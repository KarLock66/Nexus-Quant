/**
 * Capital Model (Phase 8, Deliverable 1) — an immutable, deterministic snapshot of
 * available trading resources.
 *
 * The snapshot is DERIVED, never stored: it is a pure projection of the event-sourced
 * market Account (cash + realized PnL) and the live Positions (marked to their last
 * fill price), reusing the SEALED Phase 6 valuation (`valuateAccount`) so the capital
 * model can never drift from the positions it is computed from. Because both inputs
 * are reconstructable folds over the fill stream, the capital snapshot is itself
 * replay- and restart-reconstructable. Event-driven by construction: a new snapshot
 * is built from the latest market state each time the risk engine evaluates.
 *
 * Field derivations (all 2dp capital strings):
 *   accountEquity   = cash + unrealizedPnL              (valuateAccount.equity)
 *   availableCash   = cashBalance                       (free realized cash)
 *   usedMargin      = grossExposure / leverage          (valuateAccount.marginUsed)
 *   availableMargin = accountEquity - usedMargin        (free margin; may be < 0)
 *   unrealizedPnL   = Σ position unrealized PnL
 *   realizedPnL     = cumulative realized PnL
 *   grossExposure   = Σ |position notional at mark|
 *   netExposure     = Σ signed position notional        (LONG +, SHORT -)
 */

import {
  DEFAULT_ACCOUNT_CONFIG,
  valuateAccount,
  type AccountConfig,
} from "../market/account.js";
import { positionNotional, positionSide } from "../market/position.js";
import type { Account, Position } from "../market/types.js";
import { parseDecimal, quantizeNotional } from "./money.js";
import type { CapitalSnapshot } from "./types.js";

/**
 * Build the immutable capital snapshot from the market account + positions. Pure:
 * no clock, no randomness; positions are summed in sorted-symbol order so the
 * derived doubles accumulate byte-identically across runs (same discipline as the
 * sealed valuation). The returned object is frozen — snapshots are immutable.
 */
export function buildCapitalSnapshot(
  account: Account,
  positions: Record<string, Position>,
  config: AccountConfig = DEFAULT_ACCOUNT_CONFIG,
): CapitalSnapshot {
  const v = valuateAccount(account, positions, config);

  // netExposure: signed sum over positions (LONG +, SHORT -, FLAT 0), accumulated
  // in sorted-symbol order for byte-stable rounding.
  let net = 0;
  for (const symbol of Object.keys(positions).sort()) {
    const pos = positions[symbol]!;
    const side = positionSide(pos);
    const n = positionNotional(pos);
    if (side === "LONG") net += n;
    else if (side === "SHORT") net -= n;
  }

  const equity = parseDecimal(v.equity);
  const usedMargin = parseDecimal(v.marginUsed);
  const availableMargin = equity - usedMargin;

  return Object.freeze({
    accountEquity: v.equity,
    availableCash: v.cashBalance,
    usedMargin: v.marginUsed,
    availableMargin: quantizeNotional(availableMargin),
    unrealizedPnl: v.unrealizedPnl,
    realizedPnl: v.realizedPnl,
    grossExposure: v.grossExposure,
    netExposure: quantizeNotional(net),
  });
}
