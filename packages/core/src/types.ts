/**
 * Canonical domain types shared by web, workers, and ingestion.
 * These mirror the Prisma enums; the JSON-Schema contracts in
 * packages/core/contracts are the cross-language (TS <-> Python) source of truth.
 */

/** DEMO is the deterministic synthetic connector (Demo Mode) — never a live venue. */
export const EXCHANGES = ["BINANCE", "DERIBIT", "BYBIT", "DEMO"] as const;
export type Exchange = (typeof EXCHANGES)[number];

export const LIVE_EXCHANGES = ["BINANCE", "DERIBIT", "BYBIT"] as const satisfies readonly Exchange[];

/**
 * Integration priority (approved review modification): Deribit is the primary
 * venue (options reference + crypto-native derivatives), Binance secondary
 * (deepest perp liquidity, LSR source), Bybit tertiary (cross-check venue).
 * Cross-exchange DQ checks treat earlier entries as more authoritative.
 */
export const EXCHANGE_PRIORITY: readonly Exchange[] = [
  "DERIBIT",
  "BINANCE",
  "BYBIT",
];

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

/** M1 Signal Engine (Phase 3) deterministic decision space. */
export const SIGNAL_DECISIONS = ["LONG", "SHORT", "FLAT"] as const;
export type SignalDecision = (typeof SIGNAL_DECISIONS)[number];

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

export const OPTION_TYPES = ["CALL", "PUT"] as const;
export type OptionType = (typeof OPTION_TYPES)[number];

/** Long/short ratio scopes (Binance/Bybit publish these; Deribit has none). */
export const LS_RATIO_SCOPES = [
  "GLOBAL_ACCOUNTS",
  "TOP_TRADER_ACCOUNTS",
  "TOP_TRADER_POSITIONS",
] as const;
export type LsRatioScope = (typeof LS_RATIO_SCOPES)[number];

/** Feature Store domains — every feature set belongs to exactly one. */
export const FEATURE_DOMAINS = [
  "TECHNICAL",
  "OPTIONS",
  "FLOW",
  "REGIME",
  "RISK",
] as const;
export type FeatureDomain = (typeof FEATURE_DOMAINS)[number];

/**
 * First-class option chain entity (decimal values travel as strings).
 * Mirrors OptionContractSnapshot — one entry per contract per snapshot.
 */
export interface OptionContract {
  exchange: Exchange;
  underlying: string; // BTC | ETH
  ts: string; // ISO snapshot time
  expiry: string; // ISO expiry
  strike: string;
  optionType: OptionType;
  iv: string | null;
  delta: string | null;
  gamma: string | null;
  theta: string | null;
  vega: string | null;
  openInterest: string | null;
  volume: string | null;
  bid: string | null;
  ask: string | null;
  markPrice: string | null;
}

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
