/**
 * Display-time position sizing (RISK_PER_TRADE). The web tier has NO live account, so
 * sizing runs against an EXPLICITLY ASSUMED equity and is labeled accordingly — it is a
 * recommendation, never the live book. The formula mirrors the sealed Phase-8 sizer's
 * RISK_PER_TRADE mode (qty = equity·riskFraction / stopDistance), which is not
 * importable from the web; the math is unit-tested here.
 *
 * FAIL-CLOSED: a FLAT signal, no entry, or no stop → `unavailable` (no size invented).
 */

import type { Measure, RiskContext, SignalDecision } from "./types.js";
import { measure, round, unavailable } from "./util.js";

export interface Sizing {
  positionSize: Measure;
  positionNotional: Measure;
  capitalRiskPercent: Measure;
}

export function computeSizing(
  direction: SignalDecision,
  entry: number | null,
  stopLoss: number | null,
  risk: RiskContext,
): Sizing {
  if (direction === "FLAT") {
    const r = unavailable("FLAT signal — no position to size");
    return { positionSize: r, positionNotional: r, capitalRiskPercent: r };
  }
  if (entry === null || stopLoss === null) {
    const r = unavailable("entry/stop unavailable — size not computable");
    return { positionSize: r, positionNotional: r, capitalRiskPercent: r };
  }
  const stopDistance = Math.abs(entry - stopLoss);
  const equity = risk.assumedEquity;
  const frac = risk.riskFraction;
  if (!(stopDistance > 0) || !(equity > 0) || !(frac > 0)) {
    const r = unavailable("non-positive stop distance / equity / risk fraction — size not computable");
    return { positionSize: r, positionNotional: r, capitalRiskPercent: r };
  }

  const riskAmount = equity * frac;
  const qty = riskAmount / stopDistance;
  const notional = qty * entry;
  const assumed = `RISK_PER_TRADE @ assumed equity $${round(equity, 2)} · risk ${round(frac * 100, 2)}%`;

  return {
    positionSize: measure(round(qty, 8), "derived", `${assumed} · qty = equity·risk / stopDistance`),
    positionNotional: measure(round(notional, 2), "derived", `${assumed} · notional = qty × entry`),
    capitalRiskPercent: measure(round(frac * 100, 2), "derived", "configured risk fraction (RiskLimit MAX_RISK_PER_TRADE or default)"),
  };
}
