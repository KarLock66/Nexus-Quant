/**
 * Section E — buildTradeReadiness. A deterministic 0..100 readiness score with DOCUMENTED
 * weights (summing to 100) — no AI, no LLM, no hidden weights. It is composed ONLY from the
 * served TradingDecision + control + risk + DQ + freshness facts.
 *
 * This is deliberately distinct from the 10A-2 presentation `setupGrade`: that grade is
 * quality-only and gating-blind (confidence/R:R/scores). Readiness is gating/approval/
 * freshness-AWARE — it answers "are we ready to actually execute this?", so control,
 * runtime, risk approval, data quality and freshness carry real weight here. Every
 * component fails closed to 0 points when its source is UNKNOWN; the score is always finite.
 */

import { deriveFacts, type PlanFacts } from "./facts.js";
import { clamp, clamp01, round, type Tri } from "./util.js";
import type {
  ReadinessBand,
  ReadinessComponent,
  TradeReadiness,
  TradePlanConfig,
  TradePlanInputs,
} from "./types.js";

/** Points for a binary gate: full weight on PASS, 0 on FAIL or UNKNOWN (fail-closed). */
function gate(t: Tri, weight: number): number {
  return t === true ? weight : 0;
}

/** Band cut-points come from the documented config (no hidden thresholds). */
function bandFor(score: number, cfg: TradePlanConfig): ReadinessBand {
  if (score >= cfg.readyBand) return "READY";
  if (score >= cfg.nearBand) return "NEAR";
  if (score >= cfg.formingBand) return "FORMING";
  return "NOT_READY";
}

export function buildTradeReadiness(inputs: TradePlanInputs): TradeReadiness {
  const f: PlanFacts = deriveFacts(inputs);
  const w = f.cfg.readinessWeights;

  // directional — full weight only for a real directional signal.
  const cDirectional = f.directional ? w.directional : 0;

  // confidence — scaled by the verbatim 0..1 conviction.
  const cConfidence = round(w.confidence * clamp01(f.confidence), 2);

  // reward:risk quality — 1.0 → 0, readyRR → full; below 1 (losing geometry) → 0.
  const denom = f.cfg.readyRR - 1;
  const rrFrac = f.rr === null || denom <= 0 ? 0 : clamp((f.rr - 1) / denom, 0, 1);
  const cRiskReward = round(w.riskReward * rrFrac, 2);

  // gating components — fail-closed to 0 on FAIL/UNKNOWN.
  const cControl = gate(f.controlAllowed, w.control);
  const cRuntime = gate(f.runtimeHealthy, w.runtime);
  const cRisk = gate(f.riskApproved, w.risk);

  // data quality — scaled by the real DQ score (0 when absent).
  const dqFrac = inputs.dqScore === null || !Number.isFinite(inputs.dqScore) ? 0 : clamp01(inputs.dqScore / 100);
  const cDataQuality = round(w.dataQuality * dqFrac, 2);

  // freshness — split evenly across signal + feature; each half only on a known-fresh source.
  const half = w.freshness / 2;
  const cFreshness = round((f.signalFresh === true ? half : 0) + (f.featureFresh === true ? half : 0), 2);

  const components: ReadinessComponent[] = [
    { key: "directional", label: "Directional signal", weight: w.directional, earned: cDirectional, basis: f.directional ? `direction ${f.direction}` : "FLAT — no directional edge" },
    { key: "confidence", label: "Conviction", weight: w.confidence, earned: cConfidence, basis: `confidence ${f.confidence.toFixed(4)} × ${w.confidence}` },
    { key: "riskReward", label: "Reward:risk", weight: w.riskReward, earned: cRiskReward, basis: f.rr === null ? "no R:R (no levels)" : `R:R ${f.rr.toFixed(2)} scaled 1→${f.cfg.readyRR}` },
    { key: "control", label: "Control approved", weight: w.control, earned: cControl, basis: `control ${f.controlStatus}` },
    { key: "runtime", label: "Runtime healthy", weight: w.runtime, earned: cRuntime, basis: `runtime ${inputs.runtimeState ?? "unknown"}` },
    { key: "risk", label: "Risk approved", weight: w.risk, earned: cRisk, basis: `risk ${f.riskStatusLabel}` },
    { key: "dataQuality", label: "Data quality", weight: w.dataQuality, earned: cDataQuality, basis: inputs.dqScore === null ? "no DQ score" : `DQ ${inputs.dqScore}/100` },
    { key: "freshness", label: "Data freshness", weight: w.freshness, earned: cFreshness, basis: `signal fresh=${f.signalFresh ?? "?"}, feature fresh=${f.featureFresh ?? "?"}` },
  ];

  const rawScore = components.reduce((a, c) => a + c.earned, 0);
  const score = round(clamp(rawScore, 0, 100), 1);
  const totalWeight = components.reduce((a, c) => a + c.weight, 0);

  return {
    score,
    band: bandFor(score, f.cfg),
    components,
    provenance: "derived",
    basis:
      `deterministic readiness ${score}/100 = directional ${cDirectional} + conf ${cConfidence} + ` +
      `R:R ${cRiskReward} + control ${cControl} + runtime ${cRuntime} + risk ${cRisk} + ` +
      `DQ ${cDataQuality} + freshness ${cFreshness} (documented weights sum ${totalWeight}; UNKNOWN→0)`,
  };
}
