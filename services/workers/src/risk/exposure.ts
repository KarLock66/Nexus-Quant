/**
 * Portfolio Exposure Engine (Phase 8, Deliverable 4) — deterministic portfolio-level
 * risk metrics derived purely from the market Positions (+ account, for leverage).
 *
 *   grossExposure = Σ |notional|
 *   netExposure   = longExposure - shortExposure
 *   longExposure  = Σ notional of LONG positions
 *   shortExposure = Σ notional of SHORT positions (positive magnitude)
 *   leverage      = grossExposure / accountEquity
 *   utilization   = grossExposure / (accountEquity * leverage)  (buying-power used)
 *
 * Pure and replay-reconstructable: positions are summed in sorted-symbol order so
 * the accumulated doubles are byte-stable. NOTE: when equity <= 0 the reported
 * leverage/utilization quantize to 0 (see money.ts) — they are REPORTING values, not
 * risk decisions; the pre-trade gate and kill switch do their own fail-closed
 * arithmetic on raw doubles and block on insolvency rather than reading these fields.
 */

import {
  DEFAULT_ACCOUNT_CONFIG,
  valuateAccount,
  type AccountConfig,
} from "../market/account.js";
import { positionNotional, positionSide } from "../market/position.js";
import type { Account, Position } from "../market/types.js";
import { parseDecimal, quantizeNotional, quantizeRatio } from "./money.js";
import type { ExposureMetrics } from "./types.js";

/** Compute the portfolio exposure metrics. Pure; deterministic; never throws. */
export function computeExposure(
  account: Account,
  positions: Record<string, Position>,
  config: AccountConfig = DEFAULT_ACCOUNT_CONFIG,
): ExposureMetrics {
  let gross = 0;
  let long = 0;
  let short = 0;
  for (const symbol of Object.keys(positions).sort()) {
    const pos = positions[symbol]!;
    const side = positionSide(pos);
    const n = positionNotional(pos);
    if (side === "LONG") {
      long += n;
      gross += n;
    } else if (side === "SHORT") {
      short += n;
      gross += n;
    }
  }
  const net = long - short;

  const equity = parseDecimal(valuateAccount(account, positions, config).equity);
  const lev = config.leverage > 0 ? config.leverage : 1;
  const maxBuyingPower = equity * lev;

  const leverage = equity > 0 ? gross / equity : 0;
  const utilization = maxBuyingPower > 0 ? gross / maxBuyingPower : 0;

  return {
    grossExposure: quantizeNotional(gross),
    netExposure: quantizeNotional(net),
    longExposure: quantizeNotional(long),
    shortExposure: quantizeNotional(short),
    leverage: quantizeRatio(leverage),
    utilization: quantizeRatio(utilization),
  };
}
