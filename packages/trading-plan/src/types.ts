/**
 * Phase 10C-1 — Production Actionable Decision Engine: canonical contracts.
 *
 * PURE types + value-unions ONLY. This package imports nothing runtime-y (no Prisma,
 * no node, no fetch, no React) — it is the single, deterministic, fail-closed transform
 * from an already-served {@link TradingDecision} (the single source of truth) + the live
 * control/risk/data-quality context into an actionable TradePlan that answers, per signal:
 *   Should I trade?  ·  Can I trade?  ·  Why?  ·  What is the exact plan?  ·  What breaks it?
 *
 * Hard invariant: the TradingDecision is consumed VERBATIM. Direction / confidence /
 * levels / scores / R:R / statuses are NEVER recomputed here — they are read off the
 * decision and only reshaped into checklists, an action verdict, invalidation triggers
 * and a readiness score. Where a source is absent the field fails closed (UNKNOWN /
 * UNAVAILABLE / null) and is never fabricated.
 */

import { MIN_DATA_QUALITY_SCORE } from "@nexus/core";

import type { Provenance, SignalDecision, Timeframe, TradingDecision } from "@nexus/trading-decision";

export type { Measure, Provenance, SignalDecision, Timeframe, TradingDecision } from "@nexus/trading-decision";

// ─────────────────────────── Engine config (all defaulted, documented) ───────────────────────────

/**
 * Weights for the readiness score (Section E). Documented + summing to 100 — there are
 * NO hidden weights. Readiness is deliberately gating/approval/freshness-aware, which is
 * what distinguishes it from the 10A-2 presentation `setupGrade` (quality-only, gating-blind).
 */
export interface ReadinessWeights {
  directional: number;
  confidence: number;
  riskReward: number;
  control: number;
  runtime: number;
  risk: number;
  dataQuality: number;
  freshness: number;
}

export const DEFAULT_READINESS_WEIGHTS: ReadinessWeights = {
  directional: 10,
  confidence: 20,
  riskReward: 15,
  control: 10,
  runtime: 10,
  risk: 10,
  dataQuality: 10,
  freshness: 15,
};
// 10 + 20 + 15 + 10 + 10 + 10 + 10 + 15 = 100

/** Tunable, deterministic engine configuration (all defaulted). */
export interface TradePlanConfig {
  /** EngineSignal older than this (s) is expired. Mirrors the H1 control freshness band. */
  signalStaleSeconds: number;
  /** FeatureSnapshot older than this (s) is stale. */
  featureStaleSeconds: number;
  /** Admitting DataQualityReport.score floor. Bound to the sealed @nexus/core MIN_DATA_QUALITY_SCORE (no re-typed literal). */
  minDqScore: number;
  /** confidence ≥ this is "strong" conviction. */
  strongConfidence: number;
  /** R:R ≥ this is a top-tier reward geometry. */
  readyRR: number;
  /** trendStrength ≥ this counts as "trend aligned". */
  goodTrend: number;
  /** momentumScore ≥ this counts as "momentum aligned". */
  goodMomentum: number;
  /**
   * volatilityScore ≤ this counts as "volatility acceptable". NB: volatilityScore is
   * INVERTED vs the others — it is realized_vol normalized against 2× the strategy's
   * maxRealizedVol, so a directional signal (which passed the sealed vol filter) scores
   * ≤ 50 by construction. Lower is better here; the default is the filter boundary.
   */
  maxVolScore: number;
  /** liquidityScore ≥ this counts as "liquidity acceptable". */
  goodLiquidity: number;
  /** trendStrength below this is "trend lost" (invalidation trigger). */
  trendLostBelow: number;
  /** momentumScore below this is "momentum reversal" (invalidation trigger). */
  momentumReversalBelow: number;
  readinessWeights: ReadinessWeights;
  /** Readiness score ≥ this → READY band. */
  readyBand: number;
  /** Readiness score ≥ this → NEAR band. */
  nearBand: number;
  /** Readiness score ≥ this → FORMING band (else NOT_READY). */
  formingBand: number;
  /** Stop distance (% of entry) below this → TIGHT risk category. */
  riskTightBelowPct: number;
  /** Stop distance (% of entry) below this → NORMAL risk category. */
  riskNormalBelowPct: number;
  /** Stop distance (% of entry) below this → WIDE risk category (else VERY_WIDE). */
  riskWideBelowPct: number;
}

export const DEFAULT_TRADE_PLAN_CONFIG: TradePlanConfig = {
  signalStaleSeconds: 180,
  featureStaleSeconds: 180,
  minDqScore: MIN_DATA_QUALITY_SCORE,
  strongConfidence: 0.75,
  readyRR: 2.0,
  goodTrend: 60,
  goodMomentum: 55,
  maxVolScore: 50,
  goodLiquidity: 50,
  trendLostBelow: 30,
  momentumReversalBelow: 15,
  readinessWeights: DEFAULT_READINESS_WEIGHTS,
  readyBand: 75,
  nearBand: 55,
  formingBand: 35,
  riskTightBelowPct: 1.5,
  riskNormalBelowPct: 4,
  riskWideBelowPct: 8,
};

// ─────────────────────────── Engine input ───────────────────────────

/** The complete, gathered input the engine consumes for ONE plan. */
export interface TradePlanInputs {
  /** Epoch ms — injected clock (no Date.now inside the pure engine → replay-safe). */
  now: number;
  /** The served decision — SSoT, consumed verbatim. */
  decision: TradingDecision;
  /** Admitting DataQualityReport.score (0..100) of the report behind the signal, or null. */
  dqScore: number | null;
  /** Control-plane runtime state (HEALTHY gates trading), or null when unknown. */
  runtimeState: string | null;
  /** DB-backed global kill switch. */
  killEngaged: boolean;
  config?: Partial<TradePlanConfig>;
}

// ─────────────────────────── Section A — Decision Summary ───────────────────────────

/**
 * The action verdict. The spec names STRONG_BUY / BUY / WATCH / WAIT / NO_TRADE /
 * STRONG_SELL; SELL is the documented symmetric completion of the SHORT side (a SHORT
 * with mid-tier conviction). No new strategy is introduced — this is a deterministic
 * relabelling of the served decision + gating context.
 */
export type Action =
  | "STRONG_BUY"
  | "BUY"
  | "WATCH"
  | "WAIT"
  | "NO_TRADE"
  | "SELL"
  | "STRONG_SELL";

export interface DecisionSummary {
  /** What to do — the answer to "Should I trade?". */
  action: Action;
  /** One-line human verdict. */
  headline: string;
  /** Can I trade? — true only when the runtime/control/risk gates currently permit it. */
  canTrade: boolean;
  /** Should I trade? — true only for the directional BUY/SELL actions. */
  shouldTrade: boolean;
  /** Why? — itemized, deterministic reasons. */
  why: string[];
  direction: SignalDecision;
  confidence: number;
  basis: string;
}

// ─────────────────────────── Section B — Execution Checklist ───────────────────────────

export type CheckStatus = "PASS" | "FAIL" | "UNKNOWN";

export interface ChecklistItem {
  id: string;
  label: string;
  status: CheckStatus;
  /** Provenance of the underlying source value (verbatim/real/derived/unavailable). */
  provenance: Provenance;
  /** Audit-readable detail: the source value + threshold it was checked against. */
  detail: string;
}

export interface ExecutionChecklist {
  items: ChecklistItem[];
  passed: number;
  failed: number;
  unknown: number;
  /** True only when every item is PASS (no FAIL and no UNKNOWN) — fail-closed. */
  allPass: boolean;
  note: string;
}

// ─────────────────────────── Section C — Risk Checklist ───────────────────────────

/** Section C's exact uppercase provenance tag set. */
export type RiskTag = "REAL" | "DERIVED" | "ESTIMATED" | "UNAVAILABLE";

export interface RiskField {
  key: string;
  label: string;
  value: number | null;
  /** "$" | "%" | "x" | "s" | "" */
  unit: string;
  tag: RiskTag;
  basis: string;
}

export interface RiskCategory {
  label: string;
  tag: RiskTag;
  basis: string;
}

export interface RiskChecklist {
  /** Maximum loss to the stop ($). */
  maximumLoss: RiskField;
  /** Capital at risk (% of assumed equity). */
  capitalAtRisk: RiskField;
  /** R multiple (reward:risk). */
  rMultiple: RiskField;
  /** Stop distance (% of entry). */
  distancePct: RiskField;
  /** ATR as a % of entry (recovered from the served levels). */
  atrPct: RiskField;
  /** Reward to first target (% of entry). */
  rewardPct: RiskField;
  /** Expected holding time (seconds). */
  expectedHoldSeconds: RiskField;
  /** Deterministic risk category band. */
  category: RiskCategory;
  /** The assumed equity the sizing/$-figures are based on (no live book at the web tier). */
  assumedEquity: number;
  note: string;
}

// ─────────────────────────── Section D — Trade Invalidation ───────────────────────────

/**
 *  ARMED          : a watch condition that WOULD invalidate the trade (not yet breached).
 *  TRIGGERED      : the condition is already breached now (the trade is invalidated).
 *  NOT_APPLICABLE : no active directional trade to invalidate (FLAT / no levels).
 */
export type TriggerState = "ARMED" | "TRIGGERED" | "NOT_APPLICABLE";

export interface InvalidationTrigger {
  id: string;
  label: string;
  description: string;
  state: TriggerState;
  provenance: Provenance;
  basis: string;
}

export interface Invalidation {
  triggers: InvalidationTrigger[];
  armed: number;
  triggered: number;
  summary: string;
}

// ─────────────────────────── Section E — Trade Readiness ───────────────────────────

export type ReadinessBand = "READY" | "NEAR" | "FORMING" | "NOT_READY";

export interface ReadinessComponent {
  key: string;
  label: string;
  weight: number;
  /** Points earned, 0..weight. */
  earned: number;
  basis: string;
}

export interface TradeReadiness {
  /** 0..100, always finite. */
  score: number;
  band: ReadinessBand;
  components: ReadinessComponent[];
  provenance: "derived";
  basis: string;
}

// ─────────────────────────── The TradePlan ───────────────────────────

export interface TradePlan {
  signalId: string;
  symbol: string;
  timeframe: Timeframe;
  direction: SignalDecision;
  confidence: number;
  summary: DecisionSummary;
  execution: ExecutionChecklist;
  risk: RiskChecklist;
  invalidation: Invalidation;
  readiness: TradeReadiness;
  /** Honest, human-readable note about this plan (carries the decision's own gaps). */
  generatedNote: string;
}
