/**
 * deriveFacts — the ONE place the trade-plan engine turns a served {@link TradingDecision}
 * (+ control/risk/DQ/freshness context) into the atomic, deterministic facts every builder
 * consumes. Centralizing this means the summary, checklists, invalidation and readiness all
 * agree by construction and NO thresholding logic is duplicated across builders.
 *
 * Nothing here is recomputed from raw features — every value is read off the decision's
 * provenance-tagged Measures (or its verbatim statuses). All tri-states fail closed to
 * `null` (UNKNOWN) when the source is absent; no numeric is ever a NaN.
 */

import { DEFAULT_DECISION_CONFIG } from "@nexus/trading-decision";
import { DEFAULT_TRADE_PLAN_CONFIG, type TradePlanConfig, type TradePlanInputs } from "./types.js";
import { mv, round, type Tri } from "./util.js";

export interface PlanFacts {
  cfg: TradePlanConfig;

  // verbatim signal
  direction: "LONG" | "SHORT" | "FLAT";
  directional: boolean;
  isLong: boolean;
  isShort: boolean;
  confidence: number;

  // gating tri-states (true = pass, false = fail, null = unknown)
  controlAllowed: Tri;
  runtimeHealthy: Tri;
  riskApproved: Tri;
  dqOk: Tri;
  signalFresh: Tri;
  featureFresh: Tri;
  trendAligned: Tri;
  momentumAligned: Tri;
  volOk: Tri;
  liqOk: Tri;
  killEngaged: boolean;

  // verbatim statuses
  overallStatus: string;
  controlStatus: string;
  executionStatus: string;
  riskStatusLabel: string;

  // composite verdict flags
  hardBlocked: boolean;
  stale: boolean;
  noTrade: boolean;
  actionable: boolean;
  canTrade: boolean;
  strong: boolean;
  good: boolean;

  // served numerics (read verbatim from the decision Measures)
  entry: number | null;
  stop: number | null;
  tp1: number | null;
  size: number | null;
  rr: number | null;
  stopDistancePct: number | null;
  capitalRiskPercent: number | null;
  trendScore: number | null;
  momentumScoreVal: number | null;
  volScore: number | null;
  liqScore: number | null;
  holdSeconds: number | null;
  signalAgeSeconds: number | null;
  featureAgeSeconds: number | null;

  // derived geometry (ATR recovered from the served levels — single source of truth)
  atr: number | null;
  atrPct: number | null;
  maxLoss: number | null;
  rewardPct: number | null;
}

export function resolveConfig(partial?: Partial<TradePlanConfig>): TradePlanConfig {
  return { ...DEFAULT_TRADE_PLAN_CONFIG, ...(partial ?? {}) };
}

export function deriveFacts(inputs: TradePlanInputs): PlanFacts {
  const cfg = resolveConfig(inputs.config);
  const d = inputs.decision;

  const direction = d.direction;
  const directional = direction !== "FLAT";
  const isLong = direction === "LONG";
  const isShort = direction === "SHORT";
  const confidence = Number.isFinite(d.confidence) ? d.confidence : 0;

  // served numerics (verbatim from the decision; null when the decision itself omitted them)
  const entry = mv(d.entryPrice);
  const stop = mv(d.stopLoss);
  const tp1 = mv(d.takeProfit1);
  const size = mv(d.positionSize);
  const rr = mv(d.riskRewardRatio);
  const stopDistancePct = mv(d.stopDistancePct);
  const capitalRiskPercent = mv(d.capitalRiskPercent);
  const trendScore = mv(d.trendStrength);
  const momentumScoreVal = mv(d.momentumScore);
  const volScore = mv(d.volatilityScore);
  const liqScore = mv(d.liquidityScore);
  const holdSeconds =
    d.expectedHoldingTime.seconds !== null && Number.isFinite(d.expectedHoldingTime.seconds)
      ? d.expectedHoldingTime.seconds
      : null;
  const signalAgeSeconds = Number.isFinite(d.signalAgeSeconds) ? d.signalAgeSeconds : null;
  const featureAgeSeconds =
    d.featureAgeSeconds !== null && Number.isFinite(d.featureAgeSeconds) ? d.featureAgeSeconds : null;

  // gating tri-states
  const controlAllowed: Tri =
    d.controlStatus === "ALLOWED" ? true : d.controlStatus === "BLOCKED" ? false : null;
  const runtimeHealthy: Tri =
    inputs.runtimeState === null ? null : inputs.runtimeState === "HEALTHY";
  const riskApproved: Tri =
    d.riskStatus.status === "APPROVED"
      ? true
      : d.riskStatus.status === "BLOCKED"
        ? false
        : null; // NOT_APPLICABLE / UNKNOWN → unknown (fail-closed)
  const dqOk: Tri =
    inputs.dqScore === null || !Number.isFinite(inputs.dqScore)
      ? null
      : inputs.dqScore >= cfg.minDqScore;
  const signalFresh: Tri = signalAgeSeconds === null ? null : signalAgeSeconds <= cfg.signalStaleSeconds;
  const featureFresh: Tri = featureAgeSeconds === null ? null : featureAgeSeconds <= cfg.featureStaleSeconds;
  const trendAligned: Tri = trendScore === null ? null : trendScore >= cfg.goodTrend;
  const momentumAligned: Tri = momentumScoreVal === null ? null : momentumScoreVal >= cfg.goodMomentum;
  // volatilityScore is INVERTED (realized vol vs 2× maxRealizedVol) — lower is better.
  const volOk: Tri = volScore === null ? null : volScore <= cfg.maxVolScore;
  const liqOk: Tri = liqScore === null ? null : liqScore >= cfg.goodLiquidity;

  // derived geometry — ATR recovered from |entry − stop| ÷ atrStopMult (sealed config).
  const atrMult = DEFAULT_DECISION_CONFIG.atrStopMult;
  const atr = entry !== null && stop !== null ? round(Math.abs(entry - stop) / atrMult, 6) : null;
  const atrPct = atr !== null && entry !== null && entry > 0 ? round((atr / entry) * 100, 4) : null;
  const maxLoss =
    size !== null && entry !== null && stop !== null ? round(size * Math.abs(entry - stop), 2) : null;
  const rewardPct =
    tp1 !== null && entry !== null && entry > 0 ? round((Math.abs(tp1 - entry) / entry) * 100, 4) : null;

  // composite verdict flags (fail-closed)
  const killEngaged = inputs.killEngaged === true;
  const hardBlocked =
    killEngaged ||
    d.controlStatus === "BLOCKED" ||
    d.riskStatus.status === "BLOCKED" ||
    d.overallStatus === "BLOCKED";
  const stale = signalFresh === false || featureFresh === false;
  const noTrade = !directional || d.overallStatus === "NO_TRADE";
  const actionable = d.overallStatus === "ACTIONABLE" && !killEngaged;
  const canTrade = actionable && !hardBlocked;
  const strong = confidence >= cfg.strongConfidence && rr !== null && rr >= cfg.readyRR;
  const good = !strong && (confidence >= cfg.strongConfidence || (rr !== null && rr >= cfg.readyRR));

  return {
    cfg,
    direction,
    directional,
    isLong,
    isShort,
    confidence,
    controlAllowed,
    runtimeHealthy,
    riskApproved,
    dqOk,
    signalFresh,
    featureFresh,
    trendAligned,
    momentumAligned,
    volOk,
    liqOk,
    killEngaged,
    overallStatus: d.overallStatus,
    controlStatus: d.controlStatus,
    executionStatus: d.executionStatus,
    riskStatusLabel: d.riskStatus.status,
    hardBlocked,
    stale,
    noTrade,
    actionable,
    canTrade,
    strong,
    good,
    entry,
    stop,
    tp1,
    size,
    rr,
    stopDistancePct,
    capitalRiskPercent,
    trendScore,
    momentumScoreVal,
    volScore,
    liqScore,
    holdSeconds,
    signalAgeSeconds,
    featureAgeSeconds,
    atr,
    atrPct,
    maxLoss,
    rewardPct,
  };
}
