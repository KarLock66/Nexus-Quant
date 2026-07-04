/**
 * Position Sizer (Phase 8, Deliverable 2) — a dedicated, PURE, deterministic sizing
 * engine. Given a sizing config, account equity, a reference price, and (for the
 * volatility mode) a realized-volatility input, it produces a target quantity, a
 * target notional, and an estimated margin usage. Every calculation is deterministic
 * (IEEE-754 arithmetic, quantized at the border) — identical inputs always yield the
 * identical PositionSizing.
 *
 * Modes (each computes a NOTIONAL, then qty = notional / price, then
 * margin = notional / leverage):
 *   FIXED_QUANTITY      qty is given; notional = qty * price
 *   FIXED_NOTIONAL      notional is given
 *   PERCENT_OF_EQUITY   notional = equity * equityFraction
 *   VOLATILITY_ADJUSTED notional = equity * volTargetFraction / volatility
 *                       (size so that notional * vol ≈ the equity risk budget)
 *   RISK_PER_TRADE      qty    = equity * riskFraction / (price * stopLossFraction)
 *                       (risk a fixed fraction of equity over the stop distance)
 *
 * FAIL-SAFE: any non-finite / non-positive input that would make a size undefined
 * collapses to a ZERO size with an explanatory detail (a zero-size target is an
 * explicit stand-aside, never a NaN that could slip past the gate). The downstream
 * risk engine treats a zero target as "no order".
 */

import { parseDecimal, quantizeNotional, quantizeQty } from "./money.js";
import type { PositionSizing, SizingConfig, SizingInput } from "./types.js";

const isPos = (n: number): boolean => Number.isFinite(n) && n > 0;
const finite = (n: number | undefined): n is number =>
  n !== undefined && Number.isFinite(n);

/** A fail-safe zero size (explicit stand-aside) with the reason recorded. */
function zeroSize(mode: SizingConfig["mode"], detail: string): PositionSizing {
  return {
    mode,
    targetQuantity: quantizeQty(0),
    targetNotional: quantizeNotional(0),
    estimatedMargin: quantizeNotional(0),
    detail,
  };
}

/**
 * Compute a deterministic position size. Returns a zero size (never throws, never
 * NaN) when an input required by the selected mode is missing or non-positive.
 */
export function sizePosition(input: SizingInput): PositionSizing {
  const { config, equity, price, volatility } = input;
  const { mode, leverage } = config;

  if (!isPos(price)) return zeroSize(mode, `non-positive reference price ${price}`);
  const lev = isPos(leverage) ? leverage : 1;

  let notional: number;
  let detail: string;

  switch (mode) {
    case "FIXED_QUANTITY": {
      if (!finite(config.fixedQuantity) || config.fixedQuantity < 0)
        return zeroSize(mode, "fixedQuantity missing or negative");
      const qty = config.fixedQuantity;
      notional = qty * price;
      detail = `FIXED_QUANTITY qty=${qty} @ ${price}`;
      break;
    }
    case "FIXED_NOTIONAL": {
      if (!finite(config.fixedNotional) || config.fixedNotional < 0)
        return zeroSize(mode, "fixedNotional missing or negative");
      notional = config.fixedNotional;
      detail = `FIXED_NOTIONAL notional=${notional}`;
      break;
    }
    case "PERCENT_OF_EQUITY": {
      if (!finite(config.equityFraction) || config.equityFraction < 0)
        return zeroSize(mode, "equityFraction missing or negative");
      if (!Number.isFinite(equity)) return zeroSize(mode, "equity is non-finite");
      notional = Math.max(0, equity) * config.equityFraction;
      detail = `PERCENT_OF_EQUITY ${config.equityFraction} * equity ${equity}`;
      break;
    }
    case "VOLATILITY_ADJUSTED": {
      if (!finite(config.volTargetFraction) || config.volTargetFraction < 0)
        return zeroSize(mode, "volTargetFraction missing or negative");
      if (!isPos(volatility ?? NaN))
        return zeroSize(mode, "volatility missing or non-positive");
      if (!Number.isFinite(equity)) return zeroSize(mode, "equity is non-finite");
      notional = (Math.max(0, equity) * config.volTargetFraction) / (volatility as number);
      detail = `VOLATILITY_ADJUSTED riskBudget=${config.volTargetFraction} vol=${volatility}`;
      break;
    }
    case "RISK_PER_TRADE": {
      if (!finite(config.riskFraction) || config.riskFraction < 0)
        return zeroSize(mode, "riskFraction missing or negative");
      if (!isPos(config.stopLossFraction ?? NaN))
        return zeroSize(mode, "stopLossFraction missing or non-positive");
      if (!Number.isFinite(equity)) return zeroSize(mode, "equity is non-finite");
      const stopDistance = price * (config.stopLossFraction as number);
      const qty = (Math.max(0, equity) * config.riskFraction) / stopDistance;
      notional = qty * price;
      detail = `RISK_PER_TRADE risk=${config.riskFraction} stop=${config.stopLossFraction}`;
      break;
    }
    default: {
      // Exhaustiveness: an unknown mode fails safe to a zero size.
      const _never: never = mode;
      return zeroSize(_never as SizingConfig["mode"], `unknown sizing mode ${String(_never)}`);
    }
  }

  if (!Number.isFinite(notional) || notional <= 0)
    return zeroSize(mode, `${detail} -> non-positive notional`);

  const qty = notional / price;
  const margin = notional / lev;
  return {
    mode,
    targetQuantity: quantizeQty(qty),
    targetNotional: quantizeNotional(notional),
    estimatedMargin: quantizeNotional(margin),
    detail,
  };
}

/** Round-trip helper: parse a sizing's notional back to a double (audit/tests). */
export function sizingNotional(sizing: PositionSizing): number {
  return parseDecimal(sizing.targetNotional);
}
