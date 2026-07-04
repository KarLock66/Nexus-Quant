/**
 * Section B — buildExecutionChecklist. The ten pre-trade gates, each PASS / FAIL / UNKNOWN
 * with the provenance of its source value and an audit-readable detail (value + threshold).
 * A missing source fails closed to UNKNOWN — never PASS. Statuses are carried verbatim from
 * the decision; scores are read off its provenance-tagged Measures (never recomputed).
 */

import { deriveFacts, type PlanFacts } from "./facts.js";
import type {
  ChecklistItem,
  ExecutionChecklist,
  Provenance,
  TradePlanInputs,
  TradingDecision,
} from "./types.js";
import { triStatus, type Tri } from "./util.js";

function n(x: number | null, dp = 1): string {
  return x === null ? "n/a" : x.toFixed(dp);
}

export function buildExecutionChecklist(inputs: TradePlanInputs): ExecutionChecklist {
  const f: PlanFacts = deriveFacts(inputs);
  const d: TradingDecision = inputs.decision;

  const item = (id: string, label: string, t: Tri, provenance: Provenance, detail: string): ChecklistItem => ({
    id,
    label,
    status: triStatus(t),
    provenance,
    detail,
  });

  const items: ChecklistItem[] = [
    item(
      "directional",
      "Directional signal",
      f.directional ? true : false,
      "verbatim",
      f.directional ? `decision is ${f.direction}` : "decision is FLAT (no directional edge)",
    ),
    item(
      "trend",
      "Trend aligned",
      f.trendAligned,
      d.trendStrength.provenance,
      `trend strength ${n(f.trendScore)} vs ≥ ${f.cfg.goodTrend}`,
    ),
    item(
      "momentum",
      "Momentum aligned",
      f.momentumAligned,
      d.momentumScore.provenance,
      `momentum ${n(f.momentumScoreVal)} vs ≥ ${f.cfg.goodMomentum} (RSI-only)`,
    ),
    item(
      "volatility",
      "Volatility acceptable",
      f.volOk,
      d.volatilityScore.provenance,
      `volatility score ${n(f.volScore)} vs ≤ ${f.cfg.maxVolScore} (lower is better — vs 2× maxRealizedVol)`,
    ),
    item(
      "liquidity",
      "Liquidity acceptable",
      f.liqOk,
      d.liquidityScore.provenance,
      f.liqScore === null
        ? "no order-book/liquidity snapshot (demo / no live ingestion)"
        : `liquidity score ${n(f.liqScore)} vs ≥ ${f.cfg.goodLiquidity}`,
    ),
    item(
      "risk",
      "Risk approved",
      f.riskApproved,
      "verbatim",
      `risk status ${f.riskStatusLabel}${d.riskStatus.staticOnly ? " (static — no live account)" : ""}`,
    ),
    item(
      "control",
      "Control approved",
      f.controlAllowed,
      "verbatim",
      `control status ${f.controlStatus}`,
    ),
    item(
      "runtime",
      "Runtime healthy",
      f.runtimeHealthy,
      inputs.runtimeState === null ? "unavailable" : "real",
      `runtime state ${inputs.runtimeState ?? "unknown"} vs HEALTHY`,
    ),
    item(
      "dataQuality",
      "Data quality acceptable",
      f.dqOk,
      inputs.dqScore === null ? "unavailable" : "real",
      inputs.dqScore === null
        ? "no admitting DQ score"
        : `DQ score ${inputs.dqScore} vs ≥ ${f.cfg.minDqScore}`,
    ),
    item(
      "freshness",
      "Fresh data",
      // FAIL if either is explicitly stale; PASS only when both are known fresh; else UNKNOWN.
      f.signalFresh === false || f.featureFresh === false
        ? false
        : f.signalFresh === true && f.featureFresh === true
          ? true
          : null,
      // Fail closed: an absent age source must not claim a "real" provenance (mirrors the
      // runtime/dataQuality items + invalidation's signal/feature-stale triggers).
      f.signalAgeSeconds === null || f.featureAgeSeconds === null ? "unavailable" : "real",
      `signal age ${n(f.signalAgeSeconds, 0)}s (≤ ${f.cfg.signalStaleSeconds}), ` +
        `feature age ${n(f.featureAgeSeconds, 0)}s (≤ ${f.cfg.featureStaleSeconds})`,
    ),
  ];

  let passed = 0;
  let failed = 0;
  let unknown = 0;
  for (const it of items) {
    if (it.status === "PASS") passed++;
    else if (it.status === "FAIL") failed++;
    else unknown++;
  }

  return {
    items,
    passed,
    failed,
    unknown,
    allPass: failed === 0 && unknown === 0,
    note: `${passed}/${items.length} checks passed${failed ? `, ${failed} failed` : ""}${
      unknown ? `, ${unknown} unknown (fail-closed)` : ""
    }`,
  };
}
