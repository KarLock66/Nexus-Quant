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

/** Compiled per-dp format checks (validation runs at boot/recovery frequency). */
const CANONICAL_DECIMAL_RE = new Map<number, RegExp>();

/**
 * True iff `v` is a canonical fixed-point decimal string of exactly `dp`
 * decimals — the one format every quantize* border emits (optional sign, at
 * least one integer digit, exactly dp fraction digits). Admission boundaries
 * use this BEFORE parseDecimal: parsing alone would silently coerce garbage
 * ("abc", "1e3", "Infinity") to 0 instead of surfacing the malformed value.
 */
export function isCanonicalDecimalString(v: unknown, dp: number): v is string {
  if (typeof v !== "string") return false;
  let re = CANONICAL_DECIMAL_RE.get(dp);
  if (re === undefined) {
    re = new RegExp(`^-?\\d+\\.\\d{${dp}}$`);
    CANONICAL_DECIMAL_RE.set(dp, re);
  }
  return re.test(v);
}
