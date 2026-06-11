/**
 * Canonical domain types shared by web, workers, and ingestion.
 * These mirror the Prisma enums; the JSON-Schema contracts in
 * packages/core/contracts are the cross-language (TS <-> Python) source of truth.
 */

export const EXCHANGES = ["BINANCE", "DERIBIT", "BYBIT"] as const;
export type Exchange = (typeof EXCHANGES)[number];

export const ASSET_TYPES = ["SPOT", "PERP", "OPTION"] as const;
export type AssetType = (typeof ASSET_TYPES)[number];

export const TIMEFRAMES = ["M1", "M5", "M15", "H1", "H4", "D1"] as const;
export type Timeframe = (typeof TIMEFRAMES)[number];

export const SIGNAL_STATES = [
  "STRONG_BUY",
  "BUY",
  "NEUTRAL",
  "SELL",
  "STRONG_SELL",
] as const;
export type SignalState = (typeof SIGNAL_STATES)[number];

export const SIGNAL_STATUSES = [
  "ACTIVE",
  "TARGET_HIT",
  "STOPPED",
  "INVALIDATED",
  "EXPIRED",
  "REQUIRES_MANUAL_REVIEW",
  "CAPACITY_DEFERRED",
] as const;
export type SignalStatus = (typeof SIGNAL_STATUSES)[number];

/** M8 Market Regime Engine — 7-state taxonomy (platform-wide canonical). */
export const MARKET_REGIMES = [
  "TRENDING_BULL",
  "TRENDING_BEAR",
  "RANGE_BOUND",
  "HIGH_VOL",
  "LOW_VOL",
  "PANIC",
  "EUPHORIA",
] as const;
export type MarketRegime = (typeof MARKET_REGIMES)[number];

/** Regimes no strategy may declare valid without explicit governance approval. */
export const RISK_REGIMES: readonly MarketRegime[] = ["PANIC", "EUPHORIA"];

export const GATE_TYPES = [
  "DATA_QUALITY",
  "RISK_REWARD",
  "POSITION_SIZE",
  "MARKET_REGIME",
  "VOLATILITY_FILTER",
  "RISK_MODE",
] as const;
export type GateType = (typeof GATE_TYPES)[number];

/** M2 multi-agent architecture. */
export const AGENT_TYPES = ["RESEARCH", "RISK", "OPTIONS", "GOVERNANCE"] as const;
export type AgentType = (typeof AGENT_TYPES)[number];

export const RISK_MODES = ["NORMAL", "ELEVATED", "RISK_OFF", "FROZEN"] as const;
export type RiskMode = (typeof RISK_MODES)[number];

export const SIZING_METHODS = [
  "FIXED_FRACTIONAL",
  "KELLY",
  "ATR",
  "VOLATILITY_TARGET",
] as const;
export type SizingMethod = (typeof SIZING_METHODS)[number];

/**
 * Reproducibility quintuple — required lineage on every signal and AI analysis.
 * Decimal values travel as strings to avoid float drift across language borders.
 */
export interface ReproducibilityMeta {
  datasetHash: string;
  featureHash: string;
  strategyVersionId: string;
  promptVersion?: number;
  modelVersion?: string;
}

export interface SignalCandidate extends ReproducibilityMeta {
  symbol: string;
  exchange: Exchange;
  assetType: AssetType;
  timeframe: Timeframe;
  state: SignalState;
  confidence: number; // 0..1
  riskScore: number; // 0..100
  volatilityScore: number;
  liquidityScore: number;
  marketRegime: MarketRegime;
  expectedRr: number;
  entry: string;
  stopLoss: string;
  takeProfit: string;
  invalidationPoint: string;
  reasoning: string;
  failureConditions: string[];
  featureSnapshotId: string;
  dqReportId: string;
}

export interface GateResult {
  gate: GateType;
  passed: boolean;
  measured: unknown;
  threshold: unknown;
  detail: string;
}
