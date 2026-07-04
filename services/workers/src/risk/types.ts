/**
 * Risk & Capital Control contracts (Phase 8).
 *
 * The risk layer sits between Signal Generation and Execution:
 *
 *   Signals -> Position Sizer -> Risk Engine (capital model + pre-trade gate
 *           +  kill switch + exposure engine + append-only risk events) -> Execution
 *
 * Every model here is PURE-derivable and quantized at the border (see money.ts), so
 * identical inputs serialize byte-identically and the whole risk state is a
 * deterministic, replay- and restart-reconstructable fold over the risk event
 * journal (events.ts) — no hidden in-process state. The layer is FAIL-CLOSED by
 * construction: any missing / invalid input, a tripped kill switch, or an
 * un-journalable decision BLOCKS rather than allows.
 *
 * This module is additive and opt-in: nothing below changes a sealed Phase 1–7 code
 * path. The execution stage gains a single default-off hook (integration.ts) that,
 * when absent, is byte-for-byte Phase 5/6/7.
 */

import type { ExecutionLineage, ExecutionSide } from "../execution/types.js";
import type { PositionSide } from "../market/types.js";

export type { ExecutionLineage, ExecutionSide, PositionSide };

// ── Deliverable 1 — Capital Model ─────────────────────────────────────────────

/**
 * An immutable, deterministic snapshot of available trading resources. Derived
 * (capital.ts) from the event-sourced market Account + Positions + their marks, so
 * it can never drift from the positions and is reconstructable on replay/restart.
 * Every field is a quantized decimal string (2dp capital units). The field set is
 * exactly the objective's: equity, cash, margin (used/available), PnL
 * (unrealized/realized), and exposure (gross/net).
 */
export interface CapitalSnapshot {
  /** cash + unrealized PnL. */
  readonly accountEquity: string;
  /** Free realized cash (moves only with realized PnL and fees). */
  readonly availableCash: string;
  /** Margin consumed by open positions: grossExposure / leverage. */
  readonly usedMargin: string;
  /** Free margin: accountEquity - usedMargin (may be < 0 if over-leveraged). */
  readonly availableMargin: string;
  readonly unrealizedPnl: string;
  readonly realizedPnl: string;
  /** Sum of |position notional at mark|. */
  readonly grossExposure: string;
  /** Signed sum of position notional (LONG +, SHORT -). */
  readonly netExposure: string;
}

// ── Deliverable 2 — Position Sizer ────────────────────────────────────────────

export const SIZING_MODES = [
  "FIXED_QUANTITY",
  "FIXED_NOTIONAL",
  "PERCENT_OF_EQUITY",
  "VOLATILITY_ADJUSTED",
  "RISK_PER_TRADE",
] as const;
export type RiskSizingMode = (typeof SIZING_MODES)[number];

/** Deterministic sizing configuration. Only the fields a mode needs are read. */
export interface SizingConfig {
  mode: RiskSizingMode;
  /** Leverage used for the margin estimate (>= 1). */
  leverage: number;
  /** FIXED_QUANTITY: the absolute target quantity. */
  fixedQuantity?: number;
  /** FIXED_NOTIONAL: the absolute target notional (capital units). */
  fixedNotional?: number;
  /** PERCENT_OF_EQUITY: fraction of equity to deploy (0..1). */
  equityFraction?: number;
  /** VOLATILITY_ADJUSTED: target portfolio-risk fraction of equity (0..1). */
  volTargetFraction?: number;
  /** RISK_PER_TRADE: fraction of equity to risk on the stop (0..1). */
  riskFraction?: number;
  /** RISK_PER_TRADE: stop distance as a fraction of price (> 0). */
  stopLossFraction?: number;
}

/** Inputs the sizer reads (pure; no clock, no randomness). */
export interface SizingInput {
  config: SizingConfig;
  /** Account equity (capital units). */
  equity: number;
  /** Reference price the position is sized against (> 0). */
  price: number;
  /** Realized volatility as a fraction (VOLATILITY_ADJUSTED only; > 0). */
  volatility?: number;
}

/** Sizer output: a target the gate then validates. All quantized strings. */
export interface PositionSizing {
  mode: RiskSizingMode;
  /** Absolute target quantity (8dp). */
  targetQuantity: string;
  /** Target notional = |qty| * price (2dp). */
  targetNotional: string;
  /** Estimated margin usage = targetNotional / leverage (2dp). */
  estimatedMargin: string;
  /** Deterministic, audit-readable WHY this size was produced. */
  detail: string;
}

// ── Deliverable 4 — Portfolio Exposure Engine ─────────────────────────────────

/** Portfolio-level risk metrics, all derived deterministically from positions. */
export interface ExposureMetrics {
  /** Sum of |notional| (2dp). */
  grossExposure: string;
  /** Signed sum: longExposure - shortExposure (2dp). */
  netExposure: string;
  /** Sum of LONG notional (2dp). */
  longExposure: string;
  /** Sum of SHORT notional, as a positive magnitude (2dp). */
  shortExposure: string;
  /** grossExposure / accountEquity (6dp; 0 when equity <= 0 — see money.ts). */
  leverage: string;
  /** grossExposure / (equity * leverage), i.e. fraction of buying power used (6dp). */
  utilization: string;
}

// ── Deliverable 3 — Pre-Trade Risk Gate ───────────────────────────────────────

/**
 * A sized, risk-CANDIDATE order — the unit the pre-trade gate evaluates. It carries
 * the resulting TARGET net position for the symbol (replace semantics, matching the
 * Phase 6 market adapter), priced, so the gate can compute every post-trade check.
 */
export interface ProposedOrder {
  symbol: string;
  side: ExecutionSide;
  /** Absolute resulting net quantity for the symbol (8dp, > 0). */
  targetQuantity: string;
  /** Resulting net notional = targetQuantity * price (2dp, > 0). */
  targetNotional: string;
  /** Reference price the order is sized against (8dp, > 0). */
  price: string;
  /** Strategy bucket the order is charged to (audit / per-strategy concerns). */
  strategyId: string;
  /** Full lineage carried verbatim for journaling (optional in standalone use). */
  lineage?: ExecutionLineage;
}

/** Post-trade projection the gate checks (pure; replace semantics per symbol). */
export interface OrderProjection {
  symbol: string;
  /** abs resulting net position quantity after the trade (8dp). */
  positionAfterQty: string;
  /** resulting net position notional (2dp). */
  positionNotional: string;
  /** portfolio gross exposure AFTER the trade (2dp). */
  grossExposureAfter: string;
  /** incremental margin the order requires to establish (2dp, >= 0). */
  requiredMargin: string;
  /** this symbol's notional as a share of accountEquity (6dp ratio). */
  concentration: string;
}

/** Machine-readable reason a pre-trade check blocked an order. */
export type GateReason =
  | "MAX_POSITION_SIZE"
  | "MAX_NOTIONAL"
  | "MAX_LEVERAGE"
  | "MARGIN_UNAVAILABLE"
  | "DAILY_LOSS_LIMIT"
  | "CONCENTRATION_LIMIT"
  | "FAIL_CLOSED";

/** One evaluated pre-trade check (recorded for audit; every check is logged). */
export interface GateCheck {
  reason: GateReason;
  passed: boolean;
  detail: string;
}

export type GateVerdict =
  | { approved: true; checks: GateCheck[] }
  | {
      approved: false;
      reason: GateReason;
      /** The most specific risk-event type for this failure (see events.ts). */
      eventType: RiskEventType;
      detail: string;
      checks: GateCheck[];
    };

/** Hard limits the pre-trade gate and kill switch enforce (fail-closed). */
export interface RiskLimits {
  /** Reject if abs(position_after_trade) > maxPositionSize (quantity). */
  maxPositionSize: number;
  /** Reject if positionNotional > maxPositionNotional. */
  maxPositionNotional: number;
  /** Reject if grossExposureAfter / accountEquity > maxLeverage. */
  maxLeverage: number;
  // Margin availability has no limit field — it rejects when requiredMargin exceeds
  // the capital model's availableMargin (a derived value, not a configured cap).
  /** Reject if dailyPnL < -dailyLossLimit (positive magnitude). */
  dailyLossLimit: number;
  /** Reject if singleAssetExposure share > maxAssetAllocation (fraction 0..1). */
  maxAssetAllocation: number;
  /** Kill switch: halt if currentDrawdown > maxDrawdown (fraction 0..1). */
  maxDrawdown: number;
}

// ── Deliverable 5 — Kill Switch ───────────────────────────────────────────────

export const KILL_SWITCH_TRIGGERS = [
  "DAILY_LOSS_BREACH",
  "DRAWDOWN_BREACH",
  "LEVERAGE_BREACH",
  "MARKET_DATA_STALE",
  "RECOVERY_FAILURE",
  "JOURNAL_INTEGRITY_FAILURE",
  "EXCHANGE_CONNECTIVITY_FAILURE",
] as const;
export type KillSwitchTrigger = (typeof KILL_SWITCH_TRIGGERS)[number];

/**
 * External health signals the kill switch consults in addition to the derived
 * capital/exposure breaches. The worker sets these from the runtime (e.g. stale
 * market data, a failed recovery, a journal integrity failure, a dropped venue
 * connection). Omitted flags are treated as healthy (false).
 */
export interface HealthSignals {
  marketDataStale?: boolean;
  recoveryFailure?: boolean;
  journalIntegrityFailure?: boolean;
  exchangeConnectivityFailure?: boolean;
}

// ── Deliverable 6 — Risk Event Model ──────────────────────────────────────────

export const RISK_EVENT_TYPES = [
  "RISK_CHECK_PASSED",
  "RISK_CHECK_FAILED",
  "POSITION_LIMIT_BREACHED",
  "LEVERAGE_LIMIT_BREACHED",
  "DRAWDOWN_LIMIT_BREACHED",
  "KILL_SWITCH_TRIGGERED",
  "TRADING_HALTED",
  "TRADING_RESUMED",
] as const;
export type RiskEventType = (typeof RISK_EVENT_TYPES)[number];

/**
 * One append-only risk-journal record — the unit recovery replays. Carries the
 * capital snapshot at evaluation time so the session baseline + high-water-mark
 * (and therefore daily PnL + drawdown) are reconstructable from the journal ALONE,
 * with no hidden in-process state. `trigger` is set only for KILL_SWITCH_TRIGGERED;
 * `order` is set only for per-order gate outcomes.
 */
export interface RiskJournalRecord {
  /** Global monotonic sequence (0-based) fixing the durable event order. */
  seq: number;
  type: RiskEventType;
  /** Machine-readable cause (a GateReason, a KillSwitchTrigger, or MANUAL/RESET). */
  reason: string;
  /** Human- and audit-readable detail (deterministic for a given evaluation). */
  detail: string;
  symbol: string | null;
  /** Capital at evaluation time (state-reconstruction anchor + audit). */
  capital: CapitalSnapshot | null;
  /** The kill-switch trigger (KILL_SWITCH_TRIGGERED only). */
  trigger: KillSwitchTrigger | null;
  /** The order under evaluation (per-order gate outcomes only). */
  order: ProposedOrder | null;
}

/** A record before the store assigns its durable sequence number. */
export type RiskJournalInput = Omit<RiskJournalRecord, "seq">;

// ── Deliverable 7 — Reconstructable risk control state ────────────────────────

/**
 * The live risk control state — a deterministic fold over the risk event journal
 * (state.ts), so it is reconstructable identically on replay and rebuilt on restart
 * (recovery.ts). NO field here is in-memory-only: each is derivable from the
 * recorded events alone. The kill switch's halt survives a restart because it is a
 * projection of KILL_SWITCH_TRIGGERED / TRADING_RESUMED, not a process flag.
 */
export interface RiskControlState {
  /** True when trading is halted; survives restart, cleared only by explicit reset. */
  halted: boolean;
  /** What engaged the current halt (null when not halted). */
  trigger: KillSwitchTrigger | "MANUAL" | null;
  haltDetail: string | null;
  /** seq of the event that engaged the current halt (audit; null when not halted). */
  haltedAtSeq: number | null;
  /** First observed account equity — the session baseline for daily PnL (2dp). */
  baselineEquity: string | null;
  /** High-water-mark account equity — for drawdown (2dp). */
  peakEquity: string | null;
  checksPassed: number;
  checksFailed: number;
}

/** The decision the risk engine returns for one order (caller logs + acts on it). */
export type RiskDecision =
  | { approved: true; capital: CapitalSnapshot; sizing?: PositionSizing }
  | {
      approved: false;
      reason: GateReason | "TRADING_HALTED";
      eventType: RiskEventType;
      detail: string;
      capital: CapitalSnapshot;
    };
