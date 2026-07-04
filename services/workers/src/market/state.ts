/**
 * MarketState fold (Phase 6) — the broker-side event-sourced source of truth.
 *
 * MarketState = net positions per symbol + the account. It is a PURE fold over the
 * Fill stream: each fill updates its symbol's position (position.applyFill) and
 * folds the position's realized-PnL DELTA into the account (account.applyRealized).
 * Because both halves are pure folds, the whole state is reconstructable
 * identically from the fills alone (reconstructMarketState) — the same
 * event-sourcing discipline the Phase 5 PortfolioState follows, so deterministic
 * replay and restart-rebuild hold here too. This is the "BrokerState"
 * reconciliation checks against the PortfolioState.
 */

import {
  DEFAULT_ACCOUNT_CONFIG,
  applyRealized,
  emptyAccount,
  type AccountConfig,
} from "./account.js";
import { parseDecimal } from "./money.js";
import { applyFill as applyFillToPosition, flatPosition } from "./position.js";
import type { Fill, MarketState } from "./types.js";

const REALIZED_EPSILON = 1e-9;

/** Empty market state: no positions, full opening cash. */
export function emptyMarketState(
  config: AccountConfig = DEFAULT_ACCOUNT_CONFIG,
): MarketState {
  return { positions: {}, account: emptyAccount(config) };
}

/**
 * Fold one Fill into the market state. Pure: returns a NEW state, never mutates.
 * The account is only re-derived when the fill realizes PnL (reduce/close/flip),
 * so opening/adding fills keep the account reference stable (no spurious churn).
 */
export function applyFillToMarketState(
  state: MarketState,
  fill: Fill,
): MarketState {
  const prior = state.positions[fill.symbol] ?? flatPosition(fill.symbol);
  const nextPos = applyFillToPosition(prior, fill);
  const realizedDelta =
    parseDecimal(nextPos.realizedPnl) - parseDecimal(prior.realizedPnl);
  const account =
    Math.abs(realizedDelta) > REALIZED_EPSILON
      ? applyRealized(state.account, realizedDelta)
      : state.account;
  return {
    positions: { ...state.positions, [fill.symbol]: nextPos },
    account,
  };
}

/**
 * Reconstruct market state from a Fill stream — proof the broker-side state is a
 * deterministic, event-sourced fold (same fills, same order -> same state).
 */
export function reconstructMarketState(
  fills: Fill[],
  config: AccountConfig = DEFAULT_ACCOUNT_CONFIG,
): MarketState {
  return fills.reduce(applyFillToMarketState, emptyMarketState(config));
}
