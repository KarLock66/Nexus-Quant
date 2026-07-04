/**
 * buildTradePlan — the deterministic orchestration that assembles ONE actionable TradePlan
 * from a served TradingDecision (+ live control/risk/DQ context). It derives the shared
 * facts once and delegates to the five section builders, so every section agrees by
 * construction and no logic is duplicated.
 *
 * Invariants mirror @nexus/trading-decision: the decision is consumed VERBATIM (nothing it
 * already carries is recomputed), the clock is INJECTED (inputs.now), and every output is
 * fail-closed (UNKNOWN / UNAVAILABLE / null — never a NaN or a fabricated figure).
 */

import { buildDecisionSummary } from "./summary.js";
import { buildExecutionChecklist } from "./execution-checklist.js";
import { buildRiskChecklist } from "./risk-checklist.js";
import { buildInvalidation } from "./invalidation.js";
import { buildTradeReadiness } from "./readiness.js";
import type { TradePlan, TradePlanInputs } from "./types.js";

export function buildTradePlan(inputs: TradePlanInputs): TradePlan {
  const d = inputs.decision;
  const summary = buildDecisionSummary(inputs);
  const execution = buildExecutionChecklist(inputs);
  const risk = buildRiskChecklist(inputs);
  const invalidation = buildInvalidation(inputs);
  const readiness = buildTradeReadiness(inputs);

  // Carry the decision's own honest gap notes forward (never hide them); add the one
  // global truth about this layer (it reshapes, it never re-decides).
  const gaps = d.provenanceNotes.length > 0 ? `; ${d.provenanceNotes.join("; ")}` : "";

  return {
    signalId: d.signalId,
    symbol: d.symbol,
    timeframe: d.timeframe,
    direction: d.direction,
    confidence: Number.isFinite(d.confidence) ? d.confidence : 0,
    summary,
    execution,
    risk,
    invalidation,
    readiness,
    generatedNote:
      `derived from TradingDecision ${d.signalId} (consumed verbatim, nothing re-decided)${gaps}`,
  };
}
