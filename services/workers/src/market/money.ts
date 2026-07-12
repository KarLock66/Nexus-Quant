/**
 * Decimal-string discipline for the market layer (Phase 6).
 *
 * Reuses the Phase 5 capital-unit discipline (notional / PnL are 2dp capital
 * strings — `quantizeNotional`) and adds the market-microstructure precisions:
 * prices and quantities are quantized to 8dp strings at the module border, so two
 * runs with identical inputs serialize byte-identical prices/quantities. As in
 * Phase 5, arithmetic happens in JS doubles INTERNALLY (IEEE-754 +,-,*,/ are
 * deterministic across platforms) and is quantized only at the border. Nothing
 * here reads a clock or randomness; every function is pure.
 */

import {
  NOTIONAL_DP,
  isCanonicalDecimalString,
  parseDecimal,
  quantizeNotional,
} from "../execution/money.js";

export { NOTIONAL_DP, isCanonicalDecimalString, parseDecimal, quantizeNotional };

/** Canonical precision for prices (matches the DB Decimal(20,8) for prices). */
export const PRICE_DP = 8;
/** Canonical precision for quantities (matches the DB Decimal(28,8) for sizes). */
export const QTY_DP = 8;

/** Quantize a double to a canonical fixed-dp string, normalizing -0 to 0. */
function quantize(n: number, dp: number): string {
  const v = Number.isFinite(n) ? n : 0;
  const s = v.toFixed(dp);
  return s === `-${(0).toFixed(dp)}` ? (0).toFixed(dp) : s;
}

/** Quantize a price to the canonical 8dp string (0 on non-finite, never NaN). */
export function quantizePrice(n: number): string {
  return quantize(n, PRICE_DP);
}

/** Quantize a quantity to the canonical 8dp string (0 on non-finite, never NaN). */
export function quantizeQty(n: number): string {
  return quantize(n, QTY_DP);
}

/** Quantize a PnL / capital amount to the canonical 2dp string. PnL may be < 0. */
export const quantizePnl = quantizeNotional;
