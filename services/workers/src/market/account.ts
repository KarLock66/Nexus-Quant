/**
 * Account model (Phase 6) — pure, event-sourced cash + a derived valuation.
 *
 * The stored account is intentionally minimal: cashBalance and cumulative
 * realizedPnl. Cash moves ONLY with realized PnL (and fees), so the account is a
 * deterministic fold over the realized-PnL deltas the position reducer emits, and
 * is reconstructable from the fill stream alone. Everything risk-relevant —
 * unrealized PnL, equity, margin used, buying power, gross exposure — is DERIVED
 * from cash + the live positions + their marks (valuateAccount), so it can never
 * drift out of sync with the positions.
 *
 *   equity      = cash + unrealizedPnL
 *   marginUsed  = grossExposure / leverage
 *   buyingPower = equity * leverage - grossExposure
 *
 * Phase 6 does NOT gate on buying power — risk gating is exclusively the Phase 5
 * risk layer's job (strict separation, unchanged). The account is a reporting +
 * reconciliation surface, not a second risk gate.
 */

import { parseDecimal, quantizeNotional, quantizePnl } from "./money.js";
import { positionNotional, unrealizedPnl } from "./position.js";
import type { Account, AccountValuation, Position } from "./types.js";

export interface AccountConfig {
  /** Opening cash balance, in capital units. */
  initialCash: number;
  /** Margin leverage (>= 1). 1 = fully funded; higher frees buying power. */
  leverage: number;
}

/** Fully-funded default; opening cash mirrors the Phase 5 portfolio capital. */
export const DEFAULT_ACCOUNT_CONFIG: AccountConfig = {
  initialCash: 1_000_000,
  leverage: 1,
};

/** Opening account: all cash, no realized PnL. */
export function emptyAccount(
  config: AccountConfig = DEFAULT_ACCOUNT_CONFIG,
): Account {
  return {
    cashBalance: quantizePnl(config.initialCash),
    realizedPnl: quantizePnl(0),
  };
}

/**
 * Fold a realized-PnL delta (and optional fee) into the account. Cash and realized
 * both move by the delta; a fee reduces cash only. Pure — returns a new account.
 */
export function applyRealized(
  account: Account,
  realizedDelta: number,
  fee = 0,
): Account {
  const cash = parseDecimal(account.cashBalance) + realizedDelta - fee;
  const realized = parseDecimal(account.realizedPnl) + realizedDelta;
  return { cashBalance: quantizePnl(cash), realizedPnl: quantizePnl(realized) };
}

/**
 * Derive the full account valuation from cash + the current positions. Positions
 * are summed in sorted-symbol order so the accumulated doubles are byte-stable
 * across runs (same discipline as the portfolio's derived aggregates).
 */
export function valuateAccount(
  account: Account,
  positions: Record<string, Position>,
  config: AccountConfig = DEFAULT_ACCOUNT_CONFIG,
): AccountValuation {
  let unrealized = 0;
  let gross = 0;
  for (const symbol of Object.keys(positions).sort()) {
    const pos = positions[symbol]!;
    unrealized += unrealizedPnl(pos);
    gross += positionNotional(pos);
  }
  const cash = parseDecimal(account.cashBalance);
  const realized = parseDecimal(account.realizedPnl);
  const equity = cash + unrealized;
  const leverage = config.leverage > 0 ? config.leverage : 1;
  const marginUsed = gross / leverage;
  const buyingPower = equity * leverage - gross;
  return {
    cashBalance: quantizePnl(cash),
    realizedPnl: quantizePnl(realized),
    unrealizedPnl: quantizePnl(unrealized),
    equity: quantizePnl(equity),
    marginUsed: quantizeNotional(marginUsed),
    buyingPower: quantizePnl(buyingPower),
    grossExposure: quantizeNotional(gross),
  };
}
