/**
 * Pre-Trade Risk Gate (Phase 8, Deliverable 3) — the FAIL-CLOSED gate every order
 * must pass before execution. PURE: given the same inputs it always returns the same
 * verdict. It enforces all six required hard checks and NEVER soft-fails — any failed
 * check, or any missing / non-finite / insolvent input, BLOCKS the order. There are
 * no warnings.
 *
 * Required checks (each REJECTS when true):
 *   Max Position Size   abs(position_after_trade)            > maxPositionSize
 *   Max Notional        positionNotional                     > maxPositionNotional
 *   Max Leverage        grossExposureAfterTrade / equity     > maxLeverage
 *   Margin Availability requiredMargin                       > availableMargin
 *   Daily Loss Limit    dailyPnL                             < -dailyLossLimit
 *   Concentration       singleAssetExposure / accountEquity  > maxAssetAllocation
 *
 * Replace semantics (matching the Phase 6 market adapter): the order's target IS the
 * resulting net position for the symbol, so the symbol's prior notional is removed
 * from gross before the target is added (projectOrder), and requiredMargin is the
 * INCREMENTAL margin to move from the prior to the target exposure.
 */

import { positionNotional } from "../market/position.js";
import type { Position } from "../market/types.js";
import { parseDecimal, quantizeNotional, quantizeRatio } from "./money.js";
import type {
  CapitalSnapshot,
  GateCheck,
  GateReason,
  GateVerdict,
  OrderProjection,
  ProposedOrder,
  RiskEventType,
  RiskLimits,
} from "./types.js";

/** Generous-but-finite defaults; the demo sizing fits inside them and executes. */
export const DEFAULT_RISK_LIMITS: RiskLimits = {
  maxPositionSize: 1_000,
  maxPositionNotional: 750_000,
  maxLeverage: 3,
  dailyLossLimit: 100_000,
  maxAssetAllocation: 0.6,
  maxDrawdown: 0.25,
};

/**
 * Project the post-trade portfolio values the gate checks. Pure. The order's target
 * REPLACES the symbol's prior exposure; requiredMargin is the incremental margin to
 * establish the new target (>= 0; reducing exposure frees rather than requires margin).
 */
export function projectOrder(
  positions: Record<string, Position>,
  capital: CapitalSnapshot,
  order: ProposedOrder,
  leverage: number,
): OrderProjection {
  const lev = Number.isFinite(leverage) && leverage > 0 ? leverage : 1;
  const target = parseDecimal(order.targetNotional);

  const prior = positions[order.symbol];
  const priorNotional = prior ? positionNotional(prior) : 0;

  const grossBefore = parseDecimal(capital.grossExposure);
  const grossAfter = grossBefore - priorNotional + target;

  const requiredMargin = Math.max(0, target - priorNotional) / lev;
  // Concentration = the asset's share of EQUITY (the standard "max allocation to one
  // asset"). equity <= 0 is fail-closed by the gate before this is read; the large
  // sentinel keeps it safe (rejecting) even if it ever were read.
  const equity = parseDecimal(capital.accountEquity);
  const concentration = equity > 0 ? target / equity : 1e9;

  return {
    symbol: order.symbol,
    positionAfterQty: order.targetQuantity,
    positionNotional: order.targetNotional,
    grossExposureAfter: quantizeNotional(grossAfter),
    requiredMargin: quantizeNotional(requiredMargin),
    concentration: quantizeRatio(concentration),
  };
}

/** Build a passed check record. */
const pass = (reason: GateReason, detail: string): GateCheck => ({
  reason,
  passed: true,
  detail,
});

/**
 * Evaluate every pre-trade check, fail-closed. Returns `approved: true` only when
 * ALL inputs are valid AND every hard check holds; otherwise blocks with the FIRST
 * failing check (most-specific first) and the full list of evaluated checks for audit.
 *
 * `dailyPnL` is the session-window PnL (current equity − session baseline equity),
 * supplied by the engine from the reconstructable RiskControlState — negative means a
 * loss. (The "daily" window is the deterministic session; a clock-based calendar reset
 * is a documented follow-up, intentionally avoided here to stay replay-deterministic.)
 */
export function evaluatePreTrade(
  order: ProposedOrder,
  projection: OrderProjection,
  capital: CapitalSnapshot,
  limits: RiskLimits,
  dailyPnL: number,
): GateVerdict {
  const checks: GateCheck[] = [];

  const targetQty = parseDecimal(order.targetQuantity);
  const targetNotional = parseDecimal(order.targetNotional);
  const equity = parseDecimal(capital.accountEquity);
  const availableMargin = parseDecimal(capital.availableMargin);
  const grossAfter = parseDecimal(projection.grossExposureAfter);
  const requiredMargin = parseDecimal(projection.requiredMargin);
  const concentration = parseDecimal(projection.concentration);

  // ── Fail-closed input validation: missing/invalid config or an insolvent account
  //    must NEVER read as "allowed". equity <= 0 blocks (leverage is undefined). ───
  const limitsFinite = [
    limits.maxPositionSize,
    limits.maxPositionNotional,
    limits.maxLeverage,
    limits.dailyLossLimit,
    limits.maxAssetAllocation,
  ].every((x) => Number.isFinite(x) && x > 0);
  const orderFinite =
    Number.isFinite(targetQty) &&
    Number.isFinite(targetNotional) &&
    targetQty > 0 &&
    targetNotional > 0;
  const stateFinite =
    Number.isFinite(equity) &&
    Number.isFinite(availableMargin) &&
    Number.isFinite(grossAfter) &&
    Number.isFinite(requiredMargin) &&
    Number.isFinite(dailyPnL);
  if (!limitsFinite || !orderFinite || !stateFinite || !(equity > 0)) {
    return {
      approved: false,
      reason: "FAIL_CLOSED",
      eventType: "RISK_CHECK_FAILED",
      detail: !(equity > 0)
        ? `insolvent or non-positive equity ${capital.accountEquity} — blocking (fail-closed)`
        : "missing or invalid risk inputs — blocking (fail-closed)",
      checks: [
        { reason: "FAIL_CLOSED", passed: false, detail: "input validation failed" },
      ],
    };
  }

  // 1) Max Position Size (quantity).
  if (targetQty > limits.maxPositionSize) {
    return block(
      checks,
      "MAX_POSITION_SIZE",
      "POSITION_LIMIT_BREACHED",
      `position ${order.targetQuantity} > maxPositionSize ${limits.maxPositionSize}`,
    );
  }
  checks.push(pass("MAX_POSITION_SIZE", `qty ${order.targetQuantity} <= ${limits.maxPositionSize}`));

  // 2) Max Notional.
  if (targetNotional > limits.maxPositionNotional) {
    return block(
      checks,
      "MAX_NOTIONAL",
      "POSITION_LIMIT_BREACHED",
      `notional ${order.targetNotional} > maxPositionNotional ${limits.maxPositionNotional}`,
    );
  }
  checks.push(pass("MAX_NOTIONAL", `notional ${order.targetNotional} <= ${limits.maxPositionNotional}`));

  // 3) Max Leverage (equity > 0 guaranteed by the fail-closed gate above).
  const leverageAfter = grossAfter / equity;
  if (leverageAfter > limits.maxLeverage) {
    return block(
      checks,
      "MAX_LEVERAGE",
      "LEVERAGE_LIMIT_BREACHED",
      `leverage ${leverageAfter.toFixed(6)} (gross ${projection.grossExposureAfter} / equity ${capital.accountEquity}) > max ${limits.maxLeverage}`,
    );
  }
  checks.push(pass("MAX_LEVERAGE", `leverage ${leverageAfter.toFixed(6)} <= ${limits.maxLeverage}`));

  // 4) Margin Availability.
  if (requiredMargin > availableMargin) {
    return block(
      checks,
      "MARGIN_UNAVAILABLE",
      "RISK_CHECK_FAILED",
      `requiredMargin ${projection.requiredMargin} > availableMargin ${capital.availableMargin}`,
    );
  }
  checks.push(pass("MARGIN_UNAVAILABLE", `requiredMargin ${projection.requiredMargin} <= ${capital.availableMargin}`));

  // 5) Daily Loss Limit.
  if (dailyPnL < -limits.dailyLossLimit) {
    return block(
      checks,
      "DAILY_LOSS_LIMIT",
      "RISK_CHECK_FAILED",
      `dailyPnL ${dailyPnL.toFixed(2)} < -dailyLossLimit ${limits.dailyLossLimit}`,
    );
  }
  checks.push(pass("DAILY_LOSS_LIMIT", `dailyPnL ${dailyPnL.toFixed(2)} >= -${limits.dailyLossLimit}`));

  // 6) Concentration Limit (single-asset share of gross-after).
  if (concentration > limits.maxAssetAllocation) {
    return block(
      checks,
      "CONCENTRATION_LIMIT",
      "RISK_CHECK_FAILED",
      `concentration ${projection.concentration} > maxAssetAllocation ${limits.maxAssetAllocation}`,
    );
  }
  checks.push(pass("CONCENTRATION_LIMIT", `concentration ${projection.concentration} <= ${limits.maxAssetAllocation}`));

  return { approved: true, checks };
}

/** Append the failing check and return the blocking verdict. */
function block(
  checks: GateCheck[],
  reason: GateReason,
  eventType: RiskEventType,
  detail: string,
): GateVerdict {
  checks.push({ reason, passed: false, detail });
  return { approved: false, reason, eventType, detail, checks };
}
