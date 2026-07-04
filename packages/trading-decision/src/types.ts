/**
 * Phase 10A-1 — Production Trading Decision Engine: canonical contracts.
 *
 * PURE types + value-unions ONLY. This package imports nothing runtime-y (no Prisma,
 * no node, no fetch) — it is the single, deterministic, fail-closed transform from an
 * admitted EngineSignal (+ its FeatureSnapshot, a current mark, and the live risk/
 * control context) into an actionable TradingDecision.
 *
 * Single source of truth: the decision/side/confidence are carried VERBATIM from the
 * persisted EngineSignal and NEVER recomputed here. Every value the engine adds is
 * tagged with a {@link Provenance} so the UI can never present a derived/assumed/
 * estimated number as if it were live truth. Nothing is fabricated: where no real
 * source exists, the field is `unavailable`.
 */

import type { MarketRegime, RiskMode, SignalDecision, Timeframe } from "@nexus/core";

export type { MarketRegime, RiskMode, SignalDecision, Timeframe } from "@nexus/core";

// ─────────────────────────── Provenance ───────────────────────────

/**
 * How a value came to be — the honesty contract of this engine.
 *   verbatim    : copied byte-for-byte from the persisted EngineSignal lineage.
 *   real        : a real observed value (live mark, signal age, DQ score).
 *   derived     : deterministically computed from REAL persisted feature values.
 *   estimated   : a deterministic estimate with a weak/assumed basis (always labeled).
 *   unavailable : no real source exists → value is null (NEVER fabricated).
 */
export type Provenance = "verbatim" | "real" | "derived" | "estimated" | "unavailable";

/** A numeric measure carrying its provenance + a human-readable basis. */
export interface Measure {
  value: number | null;
  provenance: Provenance;
  /** Deterministic, audit-readable explanation of how `value` was produced. */
  basis: string;
}

// ─────────────────────────── Signal params (mirror of the sealed rule) ───────────────────────────

/**
 * The resolved decision parameters persisted on every EngineSignal
 * (`EngineSignal.strategyParams`). Identical shape to the sealed
 * `services/workers/src/signal/decision.ts` `SignalParams` — it is not importable
 * (the worker has no package exports), so the shape is mirrored here and pinned to
 * the sealed rule by the fixture equivalence test.
 */
export interface SignalParams {
  rsiLongMin: number;
  rsiShortMax: number;
  maxRealizedVol: number;
}

export const DEFAULT_SIGNAL_PARAMS: SignalParams = {
  rsiLongMin: 55,
  rsiShortMax: 45,
  maxRealizedVol: 0.02,
};

// ─────────────────────────── Engine inputs ───────────────────────────

/** Verbatim projection of a persisted EngineSignal row (the SSoT decision). */
export interface SignalProjection {
  id: string;
  symbol: string;
  /** Trend bias before the volatility filter. */
  side: SignalDecision;
  /** Final verdict after the volatility filter — the actionable direction. */
  decision: SignalDecision;
  /** Conviction 0..1 (verbatim; quantized 4dp at rest). */
  confidence: number;
  featureHash: string;
  datasetHash: string;
  strategyVersionId: string;
  strategyParams: SignalParams;
  /** ISO timestamp the EngineSignal row was created. */
  createdAt: string;
}

/** A current/mark price observation (already freshness-bounded by the caller). */
export interface PriceObservation {
  price: number;
  /** ISO timestamp the mark describes. */
  ts: string;
  /** Which source won (markPrice|mid|tick|candle) — for the basis string. */
  source: string;
}

/** Liquidity observation derived from the order book / liquidity snapshot. */
export interface LiquidityObservation {
  spreadBps: number | null;
  /** Aggregate USD depth available near the mid (bid+ask). */
  depthUsd: number | null;
  ts: string;
}

/** Display-time risk context. The web tier has no live account — equity is ASSUMED. */
export interface RiskContext {
  /** Equity used for display sizing — an explicit assumption, never the live book. */
  assumedEquity: number;
  /** Fraction of equity risked per trade (RISK_PER_TRADE), e.g. 0.01 = 1%. */
  riskFraction: number;
  leverage: number;
  /** Hard notional cap for the static pre-trade check (capital units). */
  maxNotional: number;
  /** Current system risk mode (RISK_OFF / FROZEN force a BLOCKED riskStatus). */
  systemRiskMode: RiskMode | null;
}

/** Display-time control context (read from the Phase 9.7 control plane). */
export interface ControlContext {
  /** ALLOWED / BLOCKED from evaluateTradingPermission, or null when control data is absent. */
  permission: "ALLOWED" | "BLOCKED" | null;
  /** The control runtime state (HEALTHY gates trading), or null when unknown. */
  runtimeState: string | null;
  killEngaged: boolean;
  /** Itemized block reasons (PermissionReason.detail strings) for the explainability view. */
  blockedReasons: string[];
}

/** Tunable, deterministic engine configuration (all defaulted). */
export interface DecisionConfig {
  atrStopMult: number;
  atrTp1Mult: number;
  atrTp2Mult: number;
  atrTp3Mult: number;
  /** Holding-horizon estimate in bars (× timeframe duration). */
  holdingHorizonBars: number;
  /** Liquidity normalization: spread at/above this bps scores 0. */
  refSpreadBps: number;
  /** Liquidity normalization: depth at/above this USD scores 100. */
  refDepthUsd: number;
  priceDecimals: number;
}

export const DEFAULT_DECISION_CONFIG: DecisionConfig = {
  atrStopMult: 1.5,
  atrTp1Mult: 1.5,
  atrTp2Mult: 3.0,
  atrTp3Mult: 4.5,
  holdingHorizonBars: 20,
  refSpreadBps: 10,
  refDepthUsd: 1_000_000,
  priceDecimals: 2,
};

/** The complete, gathered input the engine consumes for ONE decision. */
export interface DecisionInputs {
  /** Epoch ms — injected clock (no Date.now inside the pure engine → replay-safe). */
  now: number;
  signal: SignalProjection;
  features: Record<string, number>;
  /** ISO bar-close timestamp of the FeatureSnapshot the signal was built from. */
  featureTs: string | null;
  timeframe: Timeframe;
  /** DataQualityReport.score (0..100) of the admitting report. */
  dqScore: number;
  price: PriceObservation | null;
  liquidity: LiquidityObservation | null;
  risk: RiskContext;
  control: ControlContext;
  config?: Partial<DecisionConfig>;
}

// ─────────────────────────── Statuses ───────────────────────────

export type ExecutionStatus = "READY" | "WAITING" | "BLOCKED" | "UNKNOWN";
export type RiskStatus = "APPROVED" | "BLOCKED" | "NOT_APPLICABLE" | "UNKNOWN";
export type ControlStatus = "ALLOWED" | "BLOCKED" | "UNKNOWN";
export type OverallStatus =
  | "ACTIONABLE"
  | "WAITING"
  | "BLOCKED"
  | "NO_TRADE"
  | "INCOMPLETE";

export interface RiskStatusView {
  status: RiskStatus;
  reason: string;
  /** True when daily-loss / drawdown checks were skipped (no live account). */
  staticOnly: boolean;
}

// ─────────────────────────── Explainability (Section C) ───────────────────────────

export interface Factor {
  label: string;
  detail: string;
}

export interface Contributions {
  trend: Measure;
  momentum: Measure;
  volatility: Measure;
  liquidity: Measure;
}

export interface ConfidenceBreakdown {
  /** 0.5 × trendStrength (directional decisions) — mirrors the sealed rule. */
  trendComponent: number | null;
  /** 0.5 × rsiConviction (directional decisions) — mirrors the sealed rule. */
  momentumComponent: number | null;
  /** The verbatim EngineSignal.confidence this breakdown explains. */
  total: number;
  basis: string;
}

export interface Explainability {
  bullish: Factor[];
  bearish: Factor[];
  neutral: Factor[];
  risk: Factor[];
  contributions: Contributions;
  confidenceBreakdown: ConfidenceBreakdown;
  executionReadiness: string;
  riskApproval: string;
  controlApproval: string;
}

export interface RegimeView {
  regime: MarketRegime | null;
  provenance: Provenance;
  basis: string;
}

export interface HoldingTimeView {
  seconds: number | null;
  bars: number | null;
  provenance: Provenance;
  basis: string;
}

// ─────────────────────────── TradingDecision (Section A) ───────────────────────────

export interface TradingDecision {
  // identity + verbatim signal (always present)
  signalId: string;
  symbol: string;
  timeframe: Timeframe;
  /** Actionable direction — EngineSignal.decision (verbatim). */
  direction: SignalDecision;
  /** Trend bias pre-volatility-filter — EngineSignal.side (verbatim). */
  bias: SignalDecision;
  /** Conviction 0..1 — EngineSignal.confidence (verbatim). */
  confidence: number;
  createdAt: string;
  signalAgeSeconds: number;
  featureAgeSeconds: number | null;

  // price & levels
  currentPrice: Measure;
  entryPrice: Measure;
  stopLoss: Measure;
  takeProfit1: Measure;
  takeProfit2: Measure;
  takeProfit3: Measure;
  riskRewardRatio: Measure;
  stopDistancePct: Measure;

  // sizing
  positionSize: Measure;
  positionNotional: Measure;
  capitalRiskPercent: Measure;
  /** The equity assumption display sizing used (no live account in the web tier). */
  assumedEquity: number;
  expectedHoldingTime: HoldingTimeView;

  // scores (0..100)
  trendStrength: Measure;
  momentumScore: Measure;
  volatilityScore: Measure;
  liquidityScore: Measure;

  // regime
  marketRegime: RegimeView;

  // statuses
  executionStatus: ExecutionStatus;
  riskStatus: RiskStatusView;
  controlStatus: ControlStatus;
  overallStatus: OverallStatus;

  // explainability + lineage + honesty
  explain: Explainability;
  featureHash: string;
  datasetHash: string;
  strategyVersionId: string;
  /** Honest, human-readable gap labels present in THIS decision. */
  provenanceNotes: string[];
}

// ─────────────────────────── Consensus (Section D) ───────────────────────────

export interface ConsensusTimeframe {
  timeframe: Timeframe;
  available: boolean;
  direction: SignalDecision | null;
  trend: Measure;
  momentum: Measure;
  volatility: Measure;
  strength: Measure;
  ageSeconds: number | null;
  note: string;
}

export interface Consensus {
  symbol: string;
  timeframes: ConsensusTimeframe[];
  /** Majority actionable direction across AVAILABLE timeframes (null if none). */
  overall: SignalDecision | null;
  /** Human bias label (e.g. "bullish 3/4", "no data"). */
  bias: string;
  /** Fraction of available timeframes agreeing with `overall`, 0..100. */
  alignmentScore: Measure;
  agreement: Timeframe[];
  conflict: Timeframe[];
  availableCount: number;
  requestedCount: number;
  note: string;
}

/** Per-timeframe input to the consensus engine (one persisted snapshot per TF). */
export interface ConsensusTimeframeInput {
  timeframe: Timeframe;
  features: Record<string, number> | null;
  ts: string | null;
  params: SignalParams;
}

// ─────────────────────────── Opportunity ranking (Section F) ───────────────────────────

export interface RankComponents {
  confidence: number;
  riskReward: number;
  liquidity: number;
  featureQuality: number;
  executionReady: number;
  riskApproved: number;
  controlApproved: number;
}

export interface RankedDecision {
  symbol: string;
  timeframe: Timeframe;
  direction: SignalDecision;
  rankScore: number;
  confidence: number;
  riskReward: number | null;
  liquidityScore: number | null;
  executionStatus: ExecutionStatus;
  riskStatus: RiskStatus;
  controlStatus: ControlStatus;
  overallStatus: OverallStatus;
  components: RankComponents;
}

export interface OpportunityBoard {
  topLong: RankedDecision[];
  topShort: RankedDecision[];
  watchlist: RankedDecision[];
  blocked: RankedDecision[];
  waiting: RankedDecision[];
  total: number;
  note: string;
}
