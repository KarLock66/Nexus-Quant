/**
 * Phase 10C-2A — Production Portfolio Intelligence Engine: canonical contracts.
 *
 * PURE types + value-unions ONLY. This package imports nothing runtime-y (no Prisma,
 * no node, no fetch, no React) — it is the single, deterministic, fail-closed transform
 * from a set of already-served {@link TradingDecision} + {@link TradePlan} outputs (the
 * single source of truth) into a complete portfolio state: summary, exposure, capital
 * allocation, risk heat, health, warnings and statistics.
 *
 * Hard invariant (mirrors @nexus/trading-decision and @nexus/trading-plan): the served
 * decision and plan are consumed VERBATIM. Direction / confidence / levels / scores / R:R /
 * readiness / action / statuses are NEVER recomputed here — they are read off the served
 * outputs and only AGGREGATED into a portfolio view. Where a source is absent the field
 * fails closed (null / 0 / UNAVAILABLE) and is never fabricated. The clock is INJECTED
 * (`now`) so the engine is replay-safe; no `Date.now`, no randomness, no IO.
 */

import { MIN_DATA_QUALITY_SCORE } from "@nexus/core";

import type { MarketRegime, Provenance, SignalDecision, Timeframe, TradingDecision } from "@nexus/trading-decision";
import type { Action, ReadinessBand, TradePlan } from "@nexus/trading-plan";

export type { MarketRegime, Provenance, SignalDecision, Timeframe, TradingDecision } from "@nexus/trading-decision";
export type { Action, ReadinessBand, TradePlan } from "@nexus/trading-plan";

// ─────────────────────────── Provenance-tagged measure ───────────────────────────

/**
 * A numeric portfolio measure carrying its provenance + an audit-readable basis. Mirrors
 * the trading-decision `Measure` so the disclosure contract is identical across the stack.
 * `value` is `null` (UNAVAILABLE) when no real source exists — never fabricated, never NaN.
 */
export interface PortfolioMeasure {
  value: number | null;
  provenance: Provenance;
  basis: string;
}

// ─────────────────────────── Engine config (all defaulted, documented) ───────────────────────────

/**
 * Documented weights for the deterministic risk-heat score (Section RiskHeat). They sum to
 * 100 — there are NO hidden weights. Heat is a pure aggregation of portfolio stress
 * factors; no ML, no fabricated values.
 */
export interface HeatWeights {
  /** Capital deployed as a fraction of assumed equity. */
  capital: number;
  /** Risk-at-risk as a fraction of the portfolio risk budget. */
  risk: number;
  /** Single-name concentration (HHI-derived). */
  concentration: number;
  /** Directional net skew |long − short| ÷ gross. */
  directionalSkew: number;
  /** Gating stress — fraction of positions blocked / stale. */
  gating: number;
}

export const DEFAULT_HEAT_WEIGHTS: HeatWeights = {
  capital: 25,
  risk: 30,
  concentration: 20,
  directionalSkew: 15,
  gating: 10,
};
// 25 + 30 + 20 + 15 + 10 = 100

/** Tunable, deterministic engine configuration (all defaulted, all documented). */
export interface PortfolioConfig {
  /** Fallback assumed equity ($) when no served decision carries one. */
  defaultEquity: number;
  /** Portfolio risk budget (% of equity). Risk-used above this → over-budget. */
  maxPortfolioRiskPct: number;
  /** A single symbol's share of gross exposure (%) at/above this → over-concentrated. */
  concentrationWarnPct: number;
  /** Long (or short) share of gross exposure (%) above this → one-sided book. */
  directionalSkewWarnPct: number;
  /** Capital deployed (%) above this → low capital remaining. */
  capitalWarnPct: number;
  /** EngineSignal older than this (s) is stale (mirrors the trade-plan freshness band). */
  signalStaleSeconds: number;
  /** FeatureSnapshot older than this (s) is stale. */
  featureStaleSeconds: number;
  /** Admitting DataQualityReport.score floor (bound to the sealed core constant). */
  minDqScore: number;
  heatWeights: HeatWeights;
  /** Heat score ≥ this → EXTREME band. */
  heatExtremeBand: number;
  /** Heat score ≥ this → HOT band. */
  heatHotBand: number;
  /** Heat score ≥ this → WARM band (else COOL). */
  heatWarmBand: number;
}

export const DEFAULT_PORTFOLIO_CONFIG: PortfolioConfig = {
  defaultEquity: 100_000,
  maxPortfolioRiskPct: 10,
  concentrationWarnPct: 60,
  directionalSkewWarnPct: 80,
  capitalWarnPct: 90,
  signalStaleSeconds: 180,
  featureStaleSeconds: 180,
  minDqScore: MIN_DATA_QUALITY_SCORE,
  heatWeights: DEFAULT_HEAT_WEIGHTS,
  heatExtremeBand: 85,
  heatHotBand: 60,
  heatWarmBand: 35,
};

// ─────────────────────────── Engine input ───────────────────────────

/** One served decision + its derived plan + the DQ score behind the signal. */
export interface PortfolioItem {
  /** The served decision — SSoT, consumed verbatim. */
  decision: TradingDecision;
  /** The actionable plan derived from `decision` — consumed verbatim. */
  plan: TradePlan;
  /** Admitting DataQualityReport.score (0..100) behind the signal, or null. */
  dqScore: number | null;
}

/** The complete, gathered input the engine consumes for ONE portfolio state. */
export interface PortfolioInputs {
  /** Epoch ms — injected clock (no Date.now inside the pure engine → replay-safe). */
  now: number;
  /** Every active symbol's served decision + plan. */
  items: PortfolioItem[];
  /** Control-plane runtime state (HEALTHY gates trading), or null when unknown. */
  runtimeState: string | null;
  /** ALLOWED / BLOCKED portfolio-wide control permission, or null when unknown. */
  controlPermission: "ALLOWED" | "BLOCKED" | null;
  /** DB-backed global kill switch. */
  killEngaged: boolean;
  config?: Partial<PortfolioConfig>;
}

// ─────────────────────────── Per-position state ───────────────────────────

/**
 * Lifecycle state of a single candidate position, derived VERBATIM from the served decision +
 * plan (fail-closed, exactly one per item):
 *   FLAT    : no directional edge (direction FLAT / overallStatus NO_TRADE) — stand aside.
 *   BLOCKED : directional but hard-blocked (kill / control / risk / overall BLOCKED).
 *   OPEN    : directional, actionable, can-trade and fresh — contributes to live exposure.
 *   WAITING : directional, not blocked, but not actionable / stale yet.
 */
export type PositionState = "OPEN" | "WAITING" | "BLOCKED" | "FLAT";

/** A normalized, provenance-aware view of one candidate position (read off decision + plan). */
export interface PortfolioPosition {
  signalId: string;
  symbol: string;
  timeframe: Timeframe;
  direction: SignalDecision;
  state: PositionState;
  action: Action;
  confidence: number;
  /** Position notional ($) — verbatim decision.positionNotional, or null. */
  notional: number | null;
  /** Maximum loss to the stop ($) — verbatim plan.risk.maximumLoss, or null. */
  maxLoss: number | null;
  /** Capital at risk (% of equity) — verbatim decision.capitalRiskPercent, or null. */
  riskPct: number | null;
  /** Reward:risk — verbatim decision.riskRewardRatio, or null. */
  riskReward: number | null;
  /** Readiness score 0..100 — verbatim plan.readiness.score. */
  readiness: number;
  readinessBand: ReadinessBand;
  /** Market regime — verbatim decision.marketRegime, or null. */
  regime: MarketRegime | null;
  /** True only when this position contributes to live exposure (state === OPEN). */
  contributesExposure: boolean;
}

// ─────────────────────────── Summary ───────────────────────────

/** Overall portfolio status — the headline verdict (mirrors PortfolioHealth.status). */
export type PortfolioStatus = "HEALTHY" | "CAUTION" | "RISK" | "BLOCKED";

export interface PortfolioSummary {
  /** Gross exposure ($) = long + short notional of OPEN positions. */
  currentExposure: number;
  longExposure: number;
  shortExposure: number;
  /** Net exposure ($) = long − short notional of OPEN positions. */
  netExposure: number;
  openTrades: number;
  blockedTrades: number;
  waitingTrades: number;
  /** OPEN positions whose readiness band is READY. */
  readyTrades: number;
  /** FLAT / NO_TRADE positions (stand aside) — not counted as candidate trades. */
  flatTrades: number;
  capitalUsed: number;
  capitalAvailable: number;
  /** Risk deployed ($) = Σ maxLoss of OPEN positions. */
  riskUsed: number;
  /** Risk remaining ($) within the portfolio risk budget. */
  riskRemaining: number;
  status: PortfolioStatus;
  /** The assumed equity the $-figures are based on (no live book at the web tier). */
  assumedEquity: number;
  note: string;
}

// ─────────────────────────── Exposure ───────────────────────────

export interface ExposureGroup {
  key: string;
  /** Notional ($) aggregated in this group. */
  notional: number;
  /** Share of THIS grouping's total notional (%), 0..100 (groups sum to 100 when non-empty). */
  sharePct: number;
  count: number;
  provenance: Provenance;
}

export interface ExposureBuckets {
  /** Grouped by lifecycle state (OPEN / WAITING / BLOCKED / FLAT). */
  byState: ExposureGroup[];
  /** Grouped by confidence band (HIGH ≥ 0.75 / MEDIUM ≥ 0.5 / LOW < 0.5). */
  byConfidence: ExposureGroup[];
  /** Grouped by capital-at-risk band (LOW < 0.5% / MODERATE < 1.5% / HIGH ≥ 1.5% / UNKNOWN). */
  byRisk: ExposureGroup[];
}

export interface PortfolioExposure {
  /** Gross notional grouped by symbol (descending notional, then symbol). */
  bySymbol: ExposureGroup[];
  /** Gross notional grouped by side (LONG / SHORT). */
  bySide: ExposureGroup[];
  /** Gross notional grouped by market regime. */
  byRegime: ExposureGroup[];
  buckets: ExposureBuckets;
  grossExposure: number;
  netExposure: number;
  note: string;
}

// ─────────────────────────── Capital allocation ───────────────────────────

export interface SymbolAllocation {
  symbol: string;
  /** Capital deployed in this symbol as a share of equity (%). */
  capitalPct: PortfolioMeasure;
  /** Risk deployed in this symbol as a share of equity (%). */
  riskPct: PortfolioMeasure;
  /** Share of gross exposure (%). */
  exposurePct: PortfolioMeasure;
}

export interface AllocationRef {
  symbol: string | null;
  value: number | null;
  provenance: Provenance;
  basis: string;
}

export interface CapitalAllocation {
  /** Total capital deployed as a share of equity (%). */
  capitalPct: PortfolioMeasure;
  /** Total risk deployed as a share of equity (%). */
  riskPct: PortfolioMeasure;
  /** Gross exposure as a share of equity (%). */
  exposurePct: PortfolioMeasure;
  perSymbol: SymbolAllocation[];
  /** Largest position by notional. */
  largestPosition: AllocationRef;
  /** Largest single-name risk by maxLoss. */
  largestRisk: AllocationRef;
  /** Best opportunity by readiness (largest opportunity). */
  largestOpportunity: AllocationRef;
  /** Single-name concentration (HHI of gross-exposure shares), 0..100. */
  concentration: PortfolioMeasure;
  note: string;
}

// ─────────────────────────── Risk heat ───────────────────────────

export type HeatBand = "COOL" | "WARM" | "HOT" | "EXTREME";

export interface HeatComponent {
  key: string;
  label: string;
  weight: number;
  /** Points earned, 0..weight. */
  earned: number;
  basis: string;
}

export interface RiskHeat {
  /** 0..100 deterministic heat score (documented weights; no ML). */
  heatScore: number;
  heatBand: HeatBand;
  /** 100 − concentration. */
  diversificationScore: number;
  /** HHI-derived single-name concentration, 0..100. */
  concentrationScore: number;
  /** Risk-used as a share of the risk budget, 0..100. */
  portfolioRisk: number;
  /** 100 − heatScore. */
  portfolioStability: number;
  components: HeatComponent[];
  provenance: "derived";
  note: string;
}

// ─────────────────────────── Portfolio health ───────────────────────────

export interface PortfolioHealth {
  status: PortfolioStatus;
  /** Itemized, deterministic reasons that drove the status. */
  reasons: string[];
  /** Convenience gate flags (verbatim from the served context). */
  runtimeHealthy: boolean | null;
  controlAllowed: boolean | null;
  killEngaged: boolean;
  heatBand: HeatBand;
  note: string;
}

// ─────────────────────────── Warnings ───────────────────────────

export type WarningSeverity = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";

export type WarningSource =
  | "control"
  | "runtime"
  | "risk"
  | "exposure"
  | "capital"
  | "concentration"
  | "data-quality"
  | "freshness"
  | "signal";

export interface PortfolioWarning {
  id: string;
  severity: WarningSeverity;
  /** Human-readable reason. */
  reason: string;
  source: WarningSource;
  /** Provenance of the underlying source value. */
  provenance: Provenance;
  /** Audit-readable basis (the value + threshold it breached). */
  basis: string;
}

export interface PortfolioWarnings {
  warnings: PortfolioWarning[];
  critical: number;
  high: number;
  medium: number;
  low: number;
  note: string;
}

// ─────────────────────────── Statistics ───────────────────────────

export interface StatRef {
  symbol: string | null;
  timeframe: Timeframe | null;
  direction: SignalDecision | null;
  value: number | null;
}

export interface ConfidenceBucket {
  label: string;
  count: number;
}

export interface PortfolioDistribution {
  byAction: Record<Action, number>;
  byReadinessBand: Record<ReadinessBand, number>;
  byRegime: ExposureGroup[];
  confidenceBuckets: ConfidenceBucket[];
}

export interface PortfolioStatistics {
  /** Sample size — the directional candidate positions the stats are computed over. */
  sampleSize: number;
  averageConfidence: number | null;
  medianConfidence: number | null;
  highestConfidence: number | null;
  lowestConfidence: number | null;
  averageRiskReward: number | null;
  averageReadiness: number | null;
  averageRisk: number | null;
  /** Highest readiness directional opportunity. */
  bestOpportunity: StatRef;
  /** Lowest readiness directional opportunity. */
  worstOpportunity: StatRef;
  distribution: PortfolioDistribution;
  note: string;
}

// ─────────────────────────── The PortfolioState ───────────────────────────

export interface PortfolioState {
  summary: PortfolioSummary;
  exposure: PortfolioExposure;
  allocation: CapitalAllocation;
  heat: RiskHeat;
  health: PortfolioHealth;
  warnings: PortfolioWarnings;
  statistics: PortfolioStatistics;
  positions: PortfolioPosition[];
  /** Honest, human-readable note (carries the count + the global provenance truth). */
  generatedNote: string;
}
