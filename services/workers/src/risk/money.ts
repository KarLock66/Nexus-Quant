/**
 * Decimal-string discipline for the risk & capital control layer (Phase 8).
 *
 * Reuses the established Phase 5/6 capital-unit and market-microstructure
 * precisions (notional / PnL / equity / margin are 2dp capital strings; prices and
 * quantities are 8dp strings) and adds one precision the risk layer needs: RATIOS
 * (leverage, utilization, concentration, drawdown) quantized to 6dp strings at the
 * module border. As everywhere in the platform, arithmetic happens in JS doubles
 * INTERNALLY (IEEE-754 +,-,*,/ are deterministic across platforms) and is quantized
 * only at the border, so two runs with identical inputs serialize byte-identically.
 * Nothing here reads a clock or randomness; every function is pure.
 */

import { parseDecimal, quantizeNotional } from "../execution/money.js";
import { quantizePnl, quantizePrice, quantizeQty } from "../market/money.js";

export { parseDecimal, quantizeNotional, quantizePnl, quantizePrice, quantizeQty };

/** Canonical precision for dimensionless ratios (leverage, utilization, drawdown). */
export const RATIO_DP = 6;

/**
 * Quantize a dimensionless ratio to the canonical 6dp string, normalizing -0 to 0.
 * Non-finite inputs collapse to "0.000000" — callers that must fail closed on a
 * non-finite ratio (e.g. leverage when equity <= 0) MUST guard BEFORE quantizing;
 * this is a reporting border, not a risk decision.
 */
export function quantizeRatio(n: number): string {
  const v = Number.isFinite(n) ? n : 0;
  const s = v.toFixed(RATIO_DP);
  return s === `-${(0).toFixed(RATIO_DP)}` ? (0).toFixed(RATIO_DP) : s;
}
