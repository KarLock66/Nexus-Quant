/**
 * intent.ts — Convert a served TradingDecision + TradePlan into an ExecutionIntent.
 *
 * This is a VERBATIM projection: direction / confidence / entry / stop / targets / R:R /
 * sizing are copied off the decision, and action / canTrade / shouldTrade / readiness off
 * the plan. NOTHING is recomputed. Absent levels stay null (UNAVAILABLE) — never fabricated.
 * The clock is injected (`now`); the intent id is deterministic in the signal id.
 */

import { intentId as makeIntentId, levelProvenance, mv } from "./util.js";
import type {
  ExecutionIntent,
  ExecutionMode,
  ExecutionProvenance,
  ExecutionVenue,
  TradePlan,
  TradingDecision,
} from "./types.js";

export interface BuildIntentOptions {
  now: number;
  mode?: ExecutionMode;
  venue?: ExecutionVenue;
}

/** Collect the finite take-profit levels off the decision, in order — VERBATIM, no gaps. */
function collectTargets(d: TradingDecision): number[] {
  const raw = [mv(d.takeProfit1), mv(d.takeProfit2), mv(d.takeProfit3)];
  return raw.filter((x): x is number => x !== null);
}

/**
 * Build the execution intent. Requires a decision AND a plan (both SSoT) — callers guard
 * their presence via {@link validateInput} first. The decision/plan must describe the SAME
 * signal; a mismatch is a fail-closed note (execution still binds to the decision's signal).
 */
export function buildExecutionIntent(
  decision: TradingDecision,
  plan: TradePlan,
  opts: BuildIntentOptions,
): ExecutionIntent {
  const id = makeIntentId(decision.signalId);
  const targets = collectTargets(decision);

  const entry = mv(decision.entryPrice);
  const stop = mv(decision.stopLoss);
  const riskReward = mv(decision.riskRewardRatio);
  const readinessScore = Number.isFinite(plan.readiness.score) ? plan.readiness.score : null;

  const provenance: Record<string, ExecutionProvenance> = {
    direction: "VERBATIM",
    confidence: "VERBATIM",
    entry: levelProvenance(decision.entryPrice),
    stop: levelProvenance(decision.stopLoss),
    targets: targets.length > 0 ? "VERBATIM" : "UNAVAILABLE",
    riskReward: levelProvenance(decision.riskRewardRatio),
    sizing: levelProvenance(decision.positionSize),
    action: "VERBATIM",
    readiness: readinessScore === null ? "UNAVAILABLE" : "VERBATIM",
    lineage: "VERBATIM",
  };

  const notes: string[] = [];
  if (plan.signalId !== decision.signalId) {
    notes.push(`plan/decision signal mismatch (plan=${plan.signalId}, decision=${decision.signalId})`);
  }
  for (const n of decision.provenanceNotes) notes.push(n);

  return {
    intentId: id,
    signalId: decision.signalId,
    symbol: decision.symbol,
    timeframe: decision.timeframe,

    direction: decision.direction,
    confidence: Number.isFinite(decision.confidence) ? decision.confidence : 0,

    entry,
    stop,
    targets,
    riskReward,
    stopDistancePct: mv(decision.stopDistancePct),

    positionSize: mv(decision.positionSize),
    positionNotional: mv(decision.positionNotional),
    capitalRiskPercent: mv(decision.capitalRiskPercent),
    assumedEquity: decision.assumedEquity,

    action: plan.summary.action,
    canTrade: plan.summary.canTrade,
    shouldTrade: plan.summary.shouldTrade,
    readinessScore,
    readinessBand: readinessScore === null ? null : plan.readiness.band,

    featureHash: decision.featureHash,
    datasetHash: decision.datasetHash,
    strategyVersionId: decision.strategyVersionId,

    mode: opts.mode ?? "SIMULATION",
    venue: opts.venue ?? "UNSET",

    provenance,
    notes,
    createdAt: opts.now,
  };
}
