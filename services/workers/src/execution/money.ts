/**
 * Decimal-string discipline for the execution layer (Phase 5).
 *
 * Capital-unit notionals are computed in JS doubles internally (IEEE-754 +,-,*,/
 * are deterministic across platforms — the same discipline demo-math.ts relies
 * on) and quantized to a canonical decimal STRING at the module border, so two
 * runs with identical inputs always serialize byte-identical notionals. Nothing
 * here reads a clock or randomness; every function is pure.
 */

/** Canonical precision for capital-unit notionals (currency-like, 2dp). */
export const NOTIONAL_DP = 2;

/**
 * Quantize a double to the canonical notional string. Non-finite inputs collapse
 * to "0.00" (fail-safe — a notional is never NaN/Infinity), and negative-zero is
 * normalized so a flat value serializes identically regardless of sign of origin.
 */
export function quantizeNotional(n: number): string {
  const v = Number.isFinite(n) ? n : 0;
  const s = v.toFixed(NOTIONAL_DP);
  return s === `-${(0).toFixed(NOTIONAL_DP)}` ? (0).toFixed(NOTIONAL_DP) : s;
}

/** Parse a canonical decimal string back to a double (0 on non-finite, never NaN). */
export function parseDecimal(s: string): number {
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}
