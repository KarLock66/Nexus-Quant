/**
 * Phase 11A-1 — Execution Core Foundation: canonical contracts.
 *
 * PURE types + value-unions ONLY. This package imports nothing runtime-y (no broker, no
 * Prisma, no Redis, no fetch, no React) — it is the single, deterministic, fail-closed
 * transform from an already-served {@link TradingDecision} + {@link TradePlan} (the single
 * source of truth) into an execution intent, plan, order/fill/position lifecycle and an
 * immutable audit trail.
 *
 * Hard invariant: the decision/plan are consumed VERBATIM. direction / confidence / entry /
 * stop / targets / R:R / readiness are NEVER recomputed here — they are read off the served
 * outputs and only reshaped into an executable lifecycle. Every value the core adds carries
 * an {@link ExecutionProvenance} tag; where no real source exists the field fails closed
 * (UNAVAILABLE / null) and is NEVER fabricated. The clock is injected everywhere (no
 * Date.now) and all IDs are deterministic → replay identical.
 *
 * This is the ONLY component allowed to create, track and close orders. It has ZERO broker
 * dependency; a future Broker/Paper/Live adapter will consume these contracts.
 */

import type { SignalDecision, Timeframe } from "@nexus/core";
import type { Action, ReadinessBand, TradePlan } from "@nexus/trading-plan";
import type { Measure, Provenance, TradingDecision } from "@nexus/trading-decision";

export type { SignalDecision, Timeframe } from "@nexus/core";
export type { Measure, TradingDecision } from "@nexus/trading-decision";
export type { Action, ReadinessBand, TradePlan } from "@nexus/trading-plan";

// ─────────────────────────── Provenance (honesty contract) ───────────────────────────

/**
 * How an execution value came to be — the honesty contract of this core.
 *   VERBATIM    : copied byte-for-byte from the served TradingDecision / TradePlan (SSoT).
 *   DERIVED     : deterministically computed from VERBATIM source values (e.g. order side).
 *   ESTIMATED   : a deterministic estimate with a weak/assumed basis (always labeled).
 *   UNAVAILABLE : no real source exists → value is null (NEVER fabricated).
 */
export type ExecutionProvenance = "VERBATIM" | "DERIVED" | "ESTIMATED" | "UNAVAILABLE";

/** The upstream lowercase provenance carried on decision Measures. Re-exported for mapping. */
export type { Provenance } from "@nexus/trading-decision";

// ─────────────────────────── Mode / venue / source ───────────────────────────

/**
 * Execution mode. The foundation ships SIMULATION only (no broker); PAPER / LIVE / BACKTEST
 * are declared here so later phases attach an adapter WITHOUT changing these contracts.
 */
export type ExecutionMode = "SIMULATION" | "PAPER" | "LIVE" | "BACKTEST";

/** Where an order would route. UNSET until a broker adapter binds a venue (Phase 11A-2+). */
export type ExecutionVenue = "UNSET" | "SIMULATED" | "DERIBIT" | "BINANCE" | "BYBIT";

/** Who caused an execution event — provenance for the audit trail. */
export type ExecutionSource =
  | "DECISION_ENGINE"
  | "TRADE_PLAN"
  | "EXECUTION_CORE"
  | "REDUCER"
  | "KILL_SWITCH"
  | "RUNTIME"
  | "SYSTEM";

// ─────────────────────────── Lifecycle statuses ───────────────────────────

/**
 * Top-level execution lifecycle. The forward path is
 *   NOT_CREATED → PLANNED → READY → SUBMITTED → ACKNOWLEDGED → PARTIALLY_FILLED →
 *   FILLED → OPEN → REDUCING → CLOSED
 * with failure exits REJECTED / EXPIRED / CANCELLED / FAILED. Transitions are deterministic
 * and validated by the state machine — illegal transitions are rejected, never applied.
 */
export type ExecutionStatus =
  | "NOT_CREATED"
  | "PLANNED"
  | "READY"
  | "SUBMITTED"
  | "ACKNOWLEDGED"
  | "PARTIALLY_FILLED"
  | "FILLED"
  | "OPEN"
  | "REDUCING"
  | "CLOSED"
  | "REJECTED"
  | "EXPIRED"
  | "CANCELLED"
  | "FAILED";

/** Per-order lifecycle. A subset of the top-level status space. */
export type OrderStatus =
  | "NOT_CREATED"
  | "PLANNED"
  | "READY"
  | "SUBMITTED"
  | "ACKNOWLEDGED"
  | "PARTIALLY_FILLED"
  | "FILLED"
  | "CANCELLED"
  | "REJECTED"
  | "EXPIRED"
  | "FAILED";

/** Net position lifecycle for a single intent. */
export type PositionStatus = "NONE" | "OPENING" | "OPEN" | "REDUCING" | "CLOSED";

/** A single fill's completeness relative to its order quantity. */
export type FillStatus = "PARTIAL" | "FULL" | "VOID";

/** Every failure path carries an explicit, deterministic reason (fail-closed WHY). */
export type ExecutionFailureReason =
  | "NO_DECISION"
  | "NO_PLAN"
  | "BLOCKED"
  | "MISSING_ENTRY"
  | "MISSING_STOP"
  | "MISSING_TARGET"
  | "MISSING_READINESS"
  | "NOT_READY"
  | "KILL_SWITCH"
  | "RUNTIME_UNHEALTHY"
  | "ILLEGAL_TRANSITION"
  | "VALIDATION_FAILED"
  | "EXPIRED"
  | "CANCELLED"
  | "REJECTED"
  | "FAILED"
  | "BROKER_UNAVAILABLE"
  | "UNKNOWN";

// ─────────────────────────── Order primitives ───────────────────────────

export type OrderSide = "BUY" | "SELL";

/** The purpose an order serves inside a plan. */
export type OrderRole = "ENTRY" | "STOP" | "TARGET";

/** Order kind. STOP is a stop-trigger (STOP_MARKET semantics) — no live venue is called. */
export type OrderType = "MARKET" | "LIMIT" | "STOP";

// ─────────────────────────── ExecutionIntent ───────────────────────────

/**
 * The execution intent — a VERBATIM projection of the served decision + plan into the
 * fields the executor needs. Nothing here is recomputed: direction/confidence/levels/RR
 * are copied off the SSoT, readiness/action/gates off the TradePlan. `provenance` records,
 * per field group, whether the source was VERBATIM / DERIVED / UNAVAILABLE.
 */
export interface ExecutionIntent {
  intentId: string;
  signalId: string;
  symbol: string;
  timeframe: Timeframe;

  // verbatim direction + conviction
  direction: SignalDecision;
  confidence: number;

  // verbatim levels (null when the decision itself carries no level → never fabricated)
  entry: number | null;
  stop: number | null;
  targets: number[];
  riskReward: number | null;
  stopDistancePct: number | null;

  // verbatim sizing (display sizing — the web tier has no live book)
  positionSize: number | null;
  positionNotional: number | null;
  capitalRiskPercent: number | null;
  assumedEquity: number;

  // verbatim gating / readiness (from the TradePlan)
  action: Action;
  canTrade: boolean;
  shouldTrade: boolean;
  readinessScore: number | null;
  readinessBand: ReadinessBand | null;

  // verbatim lineage
  featureHash: string;
  datasetHash: string;
  strategyVersionId: string;

  mode: ExecutionMode;
  venue: ExecutionVenue;

  /** Per-field-group provenance tags (audit-readable, never a fabricated VERBATIM). */
  provenance: Readonly<Record<string, ExecutionProvenance>>;
  /** Honest gap labels carried forward from the decision/plan (never hidden). */
  notes: string[];
  /** Injected clock (epoch ms) at intent creation. */
  createdAt: number;
}

// ─────────────────────────── ExecutionOrder / Fill ───────────────────────────

export interface ExecutionOrder {
  orderId: string;
  planId: string;
  intentId: string;
  symbol: string;
  side: OrderSide;
  role: OrderRole;
  type: OrderType;
  /** Limit / trigger price — VERBATIM from the served level, or null (MARKET / unavailable). */
  price: number | null;
  /** Intended quantity, or null when sizing is UNAVAILABLE. */
  quantity: number | null;
  status: OrderStatus;
  filledQuantity: number;
  avgFillPrice: number | null;
  provenance: ExecutionProvenance;
  reason: string;
  createdAt: number;
  updatedAt: number;
}

export interface ExecutionFill {
  fillId: string;
  orderId: string;
  intentId: string;
  symbol: string;
  side: OrderSide;
  price: number;
  quantity: number;
  status: FillStatus;
  /** Cumulative filled quantity on the parent order after this fill. */
  cumulativeQuantity: number;
  provenance: ExecutionProvenance;
  ts: number;
}

// ─────────────────────────── ExecutionPlan ───────────────────────────

/**
 * The concrete order set derived from an intent: one ENTRY order plus protective STOP and
 * TARGET orders. Prices are VERBATIM from the intent's levels; quantities are DERIVED by
 * splitting the verbatim position size across the targets. The plan is `submittable` only
 * when every fail-closed precondition holds.
 */
export interface ExecutionPlan {
  planId: string;
  intentId: string;
  signalId: string;
  symbol: string;
  direction: SignalDecision;
  mode: ExecutionMode;
  venue: ExecutionVenue;
  orders: ExecutionOrder[];
  /** Total intended quantity (VERBATIM position size), or null when UNAVAILABLE. */
  totalQuantity: number | null;
  /** True only when the plan may legally reach SUBMITTED (all fail-closed gates pass). */
  submittable: boolean;
  /** When !submittable, the first failing gate — the WHY. */
  blockedReason: ExecutionFailureReason | null;
  provenance: ExecutionProvenance;
  notes: string[];
  createdAt: number;
}

// ─────────────────────────── ExecutionPosition ───────────────────────────

export interface ExecutionPosition {
  positionId: string;
  intentId: string;
  symbol: string;
  direction: SignalDecision;
  status: PositionStatus;
  /** Signed net quantity (+ long / − short). Absolute exposure is |quantity|. */
  quantity: number;
  entryQuantity: number;
  closedQuantity: number;
  avgEntryPrice: number | null;
  /** VERBATIM protective stop carried from the intent. */
  stop: number | null;
  /** VERBATIM targets carried from the intent. */
  targets: number[];
  openedAt: number | null;
  closedAt: number | null;
  provenance: ExecutionProvenance;
}

// ─────────────────────────── Events / Audit ───────────────────────────

/** The entity an event describes. */
export type ExecutionEntity = "EXECUTION" | "INTENT" | "PLAN" | "ORDER" | "FILL" | "POSITION";

/** The command/transition kind an event records. */
export type ExecutionEventType =
  | "PLANNED"
  | "ARMED"
  | "SUBMITTED"
  | "ACKNOWLEDGED"
  | "PARTIALLY_FILLED"
  | "FILLED"
  | "OPENED"
  | "REDUCED"
  | "CLOSED"
  | "CANCELLED"
  | "REJECTED"
  | "EXPIRED"
  | "FAILED"
  | "KILLED"
  | "REJECTED_TRANSITION";

/** An immutable audit event. Once appended it is never mutated. */
export interface ExecutionEvent {
  eventId: string;
  /** Monotonic per-execution sequence number (deterministic, gap-free). */
  seq: number;
  intentId: string;
  entity: ExecutionEntity;
  entityId: string;
  type: ExecutionEventType;
  previousStatus: string | null;
  newStatus: string | null;
  source: ExecutionSource;
  provenance: ExecutionProvenance;
  reason: string;
  /** Injected clock (epoch ms). */
  ts: number;
}

export interface ExecutionAudit {
  intentId: string;
  events: readonly ExecutionEvent[];
  count: number;
}

// ─────────────────────────── Lifecycle view / failure ───────────────────────────

export interface ExecutionLifecycle {
  current: ExecutionStatus;
  history: readonly ExecutionStatus[];
  /** True once a terminal status (CLOSED / REJECTED / EXPIRED / CANCELLED / FAILED) is reached. */
  terminal: boolean;
}

export interface ExecutionFailure {
  reason: ExecutionFailureReason;
  message: string;
  at: number;
  /** Fatal failures cannot be recovered (FAILED / REJECTED); non-fatal are e.g. CANCELLED. */
  fatal: boolean;
}

// ─────────────────────────── ExecutionState (reducer aggregate) ───────────────────────────

/**
 * The complete, replay-safe aggregate the reducer evolves. Immutable-by-convention: every
 * reducer step returns a NEW state; inputs are never mutated. `seq` and `clock` make ID
 * generation and event ordering deterministic.
 */
export interface ExecutionState {
  intentId: string;
  signalId: string;
  symbol: string;
  status: ExecutionStatus;
  mode: ExecutionMode;
  venue: ExecutionVenue;
  intent: ExecutionIntent;
  plan: ExecutionPlan | null;
  orders: ExecutionOrder[];
  fills: ExecutionFill[];
  position: ExecutionPosition | null;
  lifecycle: ExecutionLifecycle;
  audit: ExecutionAudit;
  failure: ExecutionFailure | null;
  /** Monotonic event sequence — advanced on every appended event. */
  seq: number;
  /** Last observed injected clock (epoch ms). */
  clock: number;
  createdAt: number;
  updatedAt: number;
}

// ─────────────────────────── Commands (reducer input) ───────────────────────────

/**
 * The deterministic command set the reducer accepts. Every command carries `at` (the
 * injected clock, epoch ms) — the reducer NEVER reads a wall clock. Broker-shaped commands
 * (ACKNOWLEDGE / FILL) carry only data an adapter would relay; the core computes the rest.
 */
export type ExecutionCommand =
  | { type: "PLAN"; at: number }
  | { type: "ARM"; at: number }
  | { type: "SUBMIT"; at: number }
  | { type: "ACKNOWLEDGE"; at: number }
  | { type: "FILL"; at: number; orderId: string; price: number; quantity: number }
  | { type: "OPEN"; at: number }
  | { type: "REDUCE"; at: number; quantity: number; price: number }
  | { type: "CLOSE"; at: number; price?: number }
  | { type: "CANCEL"; at: number; reason?: string }
  | { type: "REJECT"; at: number; reason?: string }
  | { type: "EXPIRE"; at: number }
  | { type: "FAIL"; at: number; reason?: string }
  | { type: "KILL"; at: number }
  | { type: "RUNTIME_UNHEALTHY"; at: number };

export type ExecutionCommandType = ExecutionCommand["type"];

// ─────────────────────────── Results / IO boundary ───────────────────────────

/** The gathered input `createExecution` consumes to build ONE execution from the SSoT. */
export interface ExecutionInput {
  /** Injected clock (epoch ms). */
  now: number;
  /** The served decision — SSoT, consumed VERBATIM (required; absence fails closed). */
  decision: TradingDecision | null;
  /** The served plan — SSoT, consumed VERBATIM (required; absence fails closed). */
  plan: TradePlan | null;
  /** DB-backed global kill switch — engaged ⇒ immediate CANCELLED. */
  killEngaged: boolean;
  /** Control-plane runtime health — unhealthy ⇒ FAILED. */
  runtimeHealthy: boolean;
  mode?: ExecutionMode;
  venue?: ExecutionVenue;
}

/** The outcome of a reducer step or an orchestration call. Pure, never throws. */
export interface ExecutionResult {
  ok: boolean;
  state: ExecutionState;
  /** The event appended by this step (null when the step was rejected / a no-op). */
  event: ExecutionEvent | null;
  failure: ExecutionFailure | null;
}
