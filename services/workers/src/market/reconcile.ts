/**
 * Execution reconciliation (Phase 6) — the fail-closed integrity bridge.
 *
 * The market layer (BrokerState: positions folded from broker fills) and the
 * Phase 5 PortfolioState (net notional per symbol, folded from ExecutionResults)
 * are maintained INDEPENDENTLY from the same executions. `reconcile` cross-checks
 * them: for every symbol the broker-side mark-to-market notional and side must
 * agree with the portfolio-side recorded exposure within a deterministic
 * tolerance (one cent, absorbing 2dp quantization). ANY disagreement — a notional
 * gap, a side flip, or exposure on one side only — fails closed.
 *
 * In correct operation the two always agree by construction (the stage derives the
 * portfolio's filledNotional from the very position it folds), so a failure here
 * is a genuine integrity breach: the stage treats it as fail-closed (rejects the
 * execution and emits RECONCILIATION_FAILED rather than committing divergent state).
 * Pure — no clock, no randomness.
 */

import type { PortfolioState } from "../execution/portfolio.js";
import { parseDecimal, quantizeNotional } from "./money.js";
import { positionNotional, positionSide } from "./position.js";
import type {
  MarketState,
  PositionSide,
  ReconciliationMismatch,
  ReconciliationVerdict,
} from "./types.js";

/** Absolute notional tolerance (capital units) — one cent absorbs 2dp rounding. */
export const DEFAULT_RECONCILIATION_TOLERANCE = 0.01;

/**
 * Reconcile BrokerState against PortfolioState. Returns `ok: true` only when every
 * symbol agrees within `tolerance`; otherwise lists every mismatching symbol.
 * Symbols are checked in sorted order for a stable, replay-identical verdict.
 */
export function reconcile(
  broker: MarketState,
  portfolio: PortfolioState,
  tolerance: number = DEFAULT_RECONCILIATION_TOLERANCE,
): ReconciliationVerdict {
  const symbols = new Set([
    ...Object.keys(broker.positions),
    ...Object.keys(portfolio.positions),
  ]);

  const mismatches: ReconciliationMismatch[] = [];
  for (const symbol of [...symbols].sort()) {
    const bPos = broker.positions[symbol];
    const pPos = portfolio.positions[symbol];

    const bNotional = bPos ? positionNotional(bPos) : 0;
    const pNotional = pPos ? parseDecimal(pPos.notional) : 0;
    const bFlat = bNotional <= tolerance;
    const pFlat = pNotional <= tolerance;
    const bSide: PositionSide = bPos && !bFlat ? positionSide(bPos) : "FLAT";
    const pSide: PositionSide = pPos && !pFlat ? (pPos.side as PositionSide) : "FLAT";

    const notionalGap = Math.abs(bNotional - pNotional);
    const sideMismatch = !bFlat && !pFlat && bSide !== pSide;

    if (notionalGap > tolerance || sideMismatch) {
      mismatches.push({
        symbol,
        brokerNotional: quantizeNotional(bNotional),
        brokerSide: bSide,
        portfolioNotional: quantizeNotional(pNotional),
        portfolioSide: pSide,
        detail: sideMismatch
          ? `side ${bSide} (broker) != ${pSide} (portfolio)`
          : `notional gap ${notionalGap.toFixed(2)} > tolerance ${tolerance}`,
      });
    }
  }

  const checked = symbols.size;
  if (mismatches.length === 0) return { ok: true, checked };
  return {
    ok: false,
    checked,
    mismatches,
    detail: `${mismatches.length} symbol(s) failed broker<->portfolio reconciliation`,
  };
}
