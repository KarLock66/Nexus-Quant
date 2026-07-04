/**
 * Section C — buildRiskChecklist. The concrete risk figures for the trade, each tagged
 * REAL / DERIVED / ESTIMATED / UNAVAILABLE. Values are read off the served decision's
 * Measures (provenance carried) or computed by simple geometry from those Measures
 * (ATR/maxLoss/reward) — never re-derived from raw features. Fail-closed to null /
 * UNAVAILABLE; never a NaN.
 */

import { deriveFacts, type PlanFacts } from "./facts.js";
import { toRiskTag } from "./util.js";
import type {
  RiskCategory,
  RiskChecklist,
  RiskField,
  TradePlanConfig,
  TradePlanInputs,
  TradingDecision,
} from "./types.js";

function field(
  key: string,
  label: string,
  value: number | null,
  unit: string,
  tag: RiskField["tag"],
  basis: string,
): RiskField {
  // A null value can never be tagged as a present figure — fail closed to UNAVAILABLE.
  return { key, label, value, unit, tag: value === null ? "UNAVAILABLE" : tag, basis };
}

/** Deterministic risk-category band over the stop distance (% of entry). Cut-points come
 *  from the documented config (no hidden thresholds). */
function categorize(stopDistancePct: number | null, rr: number | null, cfg: TradePlanConfig): RiskCategory {
  if (stopDistancePct === null) {
    return { label: "UNKNOWN", tag: "UNAVAILABLE", basis: "no stop distance — category not computable" };
  }
  const d = stopDistancePct;
  const band =
    d < cfg.riskTightBelowPct
      ? "TIGHT"
      : d < cfg.riskNormalBelowPct
        ? "NORMAL"
        : d < cfg.riskWideBelowPct
          ? "WIDE"
          : "VERY_WIDE";
  const rrNote = rr === null ? "" : `, R:R ${rr.toFixed(2)}`;
  return {
    label: band,
    tag: "DERIVED",
    basis:
      `stop distance ${d.toFixed(2)}% → ${band} ` +
      `(TIGHT<${cfg.riskTightBelowPct} · NORMAL<${cfg.riskNormalBelowPct} · WIDE<${cfg.riskWideBelowPct} · VERY_WIDE≥${cfg.riskWideBelowPct})${rrNote}`,
  };
}

export function buildRiskChecklist(inputs: TradePlanInputs): RiskChecklist {
  const f: PlanFacts = deriveFacts(inputs);
  const d: TradingDecision = inputs.decision;

  const maximumLoss = field(
    "maximumLoss",
    "Maximum loss",
    f.maxLoss,
    "$",
    "DERIVED",
    f.maxLoss === null
      ? "needs position size + entry + stop (unavailable)"
      : `position size ${f.size} × |entry − stop| ${
          f.entry !== null && f.stop !== null ? Math.abs(f.entry - f.stop).toFixed(2) : "?"
        } (assumes equity $${d.assumedEquity})`,
  );

  const capitalAtRisk = field(
    "capitalAtRisk",
    "Capital at risk",
    f.capitalRiskPercent,
    "%",
    toRiskTag(d.capitalRiskPercent.provenance),
    d.capitalRiskPercent.basis,
  );

  const rMultiple = field(
    "rMultiple",
    "R multiple",
    f.rr,
    "x",
    toRiskTag(d.riskRewardRatio.provenance),
    d.riskRewardRatio.basis,
  );

  const distancePct = field(
    "distancePct",
    "Stop distance",
    f.stopDistancePct,
    "%",
    toRiskTag(d.stopDistancePct.provenance),
    d.stopDistancePct.basis,
  );

  const atrPct = field(
    "atrPct",
    "ATR",
    f.atrPct,
    "%",
    "DERIVED",
    f.atrPct === null
      ? "needs entry + stop (unavailable)"
      : `ATR ${f.atr} recovered from |entry − stop| ÷ atrStopMult, as % of entry`,
  );

  const rewardPct = field(
    "rewardPct",
    "Reward to TP1",
    f.rewardPct,
    "%",
    "DERIVED",
    f.rewardPct === null
      ? "needs entry + TP1 (unavailable)"
      : "|TP1 − entry| ÷ entry × 100",
  );

  const expectedHoldSeconds = field(
    "expectedHoldSeconds",
    "Expected hold",
    f.holdSeconds,
    "s",
    toRiskTag(d.expectedHoldingTime.provenance),
    d.expectedHoldingTime.basis,
  );

  const category = categorize(f.stopDistancePct, f.rr, f.cfg);

  const note = f.directional
    ? "risk figures assume the display equity (no live account at the web tier)"
    : "FLAT — no directional trade; risk figures unavailable";

  return {
    maximumLoss,
    capitalAtRisk,
    rMultiple,
    distancePct,
    atrPct,
    rewardPct,
    expectedHoldSeconds,
    category,
    assumedEquity: Number.isFinite(d.assumedEquity) ? d.assumedEquity : 0,
    note,
  };
}
