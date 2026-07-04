/**
 * Phase 11A-2 — Execution Adapter Foundation: canonical contracts.
 *
 * The adapter is the pure, deterministic, fail-closed translation layer between runtime
 * services and the SEALED {@link @nexus/execution-core}. It owns NO trading logic: direction,
 * confidence, entry, stop, targets, R:R, readiness and sizing are ALL produced by the core and
 * consumed VERBATIM through the {@link ExecutionState} the adapter carries. The adapter's only
 * job is to (a) validate that a runtime submission is legal (fail-closed), (b) drive the sealed
 * core reducer forward across the venue boundary, and (c) emit an immutable, replay-safe event
 * stream describing what crossed that boundary.
 *
 * Hard invariants mirrored from the core:
 *   • PURE — no IO, no broker, no exchange, no Prisma/Redis/fetch/React.
 *   • DETERMINISTIC — the clock is injected on every command (`at`); NO Date.now, NO
 *     Math.random. Identical (session, command) → byte-identical result.
 *   • FAIL-CLOSED — every rejection carries an explicit {@link AdapterFailureReason}; nothing
 *     is ever silently admitted, and no value is ever fabricated.
 *   • NO HIDDEN STATE — all state lives in the {@link AdapterSession} that threads through every
 *     call; the adapter objects themselves are behavior-only (stateless).
 *   • REPLAY-SAFE — feeding the same command stream reproduces an identical session + event log.
 */

import type {
  ExecutionFailureReason,
  ExecutionMode,
  ExecutionProvenance,
  ExecutionState,
  ExecutionStatus,
  ExecutionVenue,
  OrderRole,
  OrderSide,
  OrderStatus,
  PositionStatus,
} from "@nexus/execution-core";

export type {
  ExecutionFailureReason,
  ExecutionMode,
  ExecutionProvenance,
  ExecutionState,
  ExecutionStatus,
  ExecutionVenue,
  OrderRole,
  OrderSide,
  OrderStatus,
  PositionStatus,
} from "@nexus/execution-core";

// ─────────────────────────── Adapter kind / health ───────────────────────────

/**
 * The concrete adapter selected at the boundary. The foundation ships PAPER (deterministic,
 * injected-fill-only) and NULL (always fail-closed). LIVE is DECLARED here so a later phase
 * attaches a broker WITHOUT changing these contracts — no LIVE implementation exists yet.
 */
export type AdapterKind = "NULL" | "PAPER" | "LIVE";

/**
 * Adapter operational health.
 *   READY       : PAPER adapter accepting commands.
 *   DEGRADED    : reserved for a partially-available adapter (never entered in the foundation).
 *   SHUTDOWN    : `shutdown()` has been called; all mutating ops fail closed thereafter.
 *   UNAVAILABLE : the NULL adapter — it exists only to fail closed with explicit reasons.
 */
export type AdapterHealthStatus = "READY" | "DEGRADED" | "SHUTDOWN" | "UNAVAILABLE";

// ─────────────────────────── Failure taxonomy (fail-closed WHY) ───────────────────────────

/**
 * Every adapter rejection carries one of these reasons. The core's own
 * {@link ExecutionFailureReason} is reused verbatim where a core gate is what failed; the
 * adapter-specific reasons cover boundary conditions the core does not model.
 */
export type AdapterFailureReason =
  | ExecutionFailureReason
  | "ADAPTER_SHUTDOWN" //  adapter already shut down
  | "ADAPTER_UNAVAILABLE" //  NULL adapter (no venue bound)
  | "NOT_BOUND" //  no ExecutionState attached to the session
  | "NOT_SUBMITTED" //  op requires a prior successful submit
  | "DUPLICATE_SUBMIT" //  submit called twice on the same session
  | "MISSING_ORDER_IDS" //  plan carried an order with no id
  | "MISSING_TIMESTAMPS" //  plan / order missing a createdAt stamp
  | "UNKNOWN_ORDER" //  cancel/fill referenced an order not in the plan
  | "TERMINAL" //  execution already terminal
  | "UNSUPPORTED_OPERATION"; //  op needs a live broker (e.g. REPLACE) — not in foundation

/** An explicit adapter failure. `fatal` mirrors the core's fatal/non-fatal distinction. */
export interface AdapterError {
  reason: AdapterFailureReason;
  message: string;
  /** Injected clock (epoch ms) at rejection. */
  at: number;
  fatal: boolean;
}

// ─────────────────────────── Events (immutable, replay-safe) ───────────────────────────

/**
 * The event the adapter emits when a transition crosses the venue boundary. This is a
 * deliberately small, venue-shaped vocabulary — it is NOT the core's internal event set.
 * Internal core transitions (PLANNED / ARMED / OPENED) produce NO adapter event.
 */
export type AdapterEventType =
  | "SUBMITTED"
  | "ACKNOWLEDGED"
  | "PARTIAL_FILL"
  | "FILLED"
  | "CANCELLED"
  | "FAILED"
  | "EXPIRED"
  | "REJECTED";

/**
 * One immutable adapter event. `seq` is a monotonic, gap-free per-session counter; `eventId`
 * is deterministic in (intentId, seq). Once emitted an event is never mutated.
 */
export interface AdapterEvent {
  eventId: string;
  /** Monotonic per-session sequence (deterministic, gap-free). */
  seq: number;
  adapter: AdapterKind;
  intentId: string;
  /** The order this event concerns, when applicable (fills/acks), else null. */
  orderId: string | null;
  type: AdapterEventType;
  mode: ExecutionMode;
  venue: ExecutionVenue;
  reason: string;
  provenance: ExecutionProvenance;
  /** Injected clock (epoch ms). */
  ts: number;
}

// ─────────────────────────── Session (all adapter state) ───────────────────────────

/**
 * The complete, replay-safe adapter state. Immutable-by-convention: every adapter method
 * returns a NEW session (inputs never mutated). Holds the sealed core state under management
 * plus the boundary bookkeeping (submitted flag, event log, monotonic seq). There is NO other
 * state anywhere in the adapter.
 */
export interface AdapterSession {
  adapter: AdapterKind;
  mode: ExecutionMode;
  venue: ExecutionVenue;
  status: AdapterHealthStatus;
  intentId: string | null;
  /** The sealed-core execution under management (null until bound). */
  core: ExecutionState | null;
  /** Append-only adapter event log. */
  events: readonly AdapterEvent[];
  /** Monotonic adapter event sequence. */
  seq: number;
  /** True once a submit has succeeded — the duplicate-submit guard. */
  submitted: boolean;
  createdAt: number;
  updatedAt: number;
  /** Last observed injected clock (epoch ms). */
  clock: number;
}

// ─────────────────────────── Result (explicit, never throws) ───────────────────────────

/**
 * The outcome of any mutating adapter method. Pure and total — it NEVER throws. The session is
 * always returned (unchanged on a validation reject; advanced on success or on a fail-closed
 * terminal transition). `events` are only the events emitted by THIS call.
 */
export interface AdapterResult {
  ok: boolean;
  session: AdapterSession;
  events: readonly AdapterEvent[];
  error: AdapterError | null;
}

// ─────────────────────────── Read views (status / health) ───────────────────────────

export interface AdapterOrderView {
  orderId: string;
  role: OrderRole;
  side: OrderSide;
  status: OrderStatus;
  price: number | null;
  quantity: number | null;
  filledQuantity: number;
}

export interface AdapterPositionView {
  status: PositionStatus;
  quantity: number;
  entryQuantity: number;
  closedQuantity: number;
  avgEntryPrice: number | null;
}

/** A pure, read-only projection of the managed execution (what `status()` returns). */
export interface AdapterStatusView {
  bound: boolean;
  intentId: string | null;
  /** The core execution status, or "UNBOUND" when no execution is attached. */
  executionStatus: ExecutionStatus | "UNBOUND";
  terminal: boolean;
  submitted: boolean;
  orders: readonly AdapterOrderView[];
  position: AdapterPositionView | null;
  eventCount: number;
  lastEventSeq: number;
}

/** A pure, read-only projection of adapter health (what `health()` returns). */
export interface AdapterHealth {
  kind: AdapterKind;
  mode: ExecutionMode;
  venue: ExecutionVenue;
  status: AdapterHealthStatus;
  bound: boolean;
  submitted: boolean;
  terminal: boolean;
  /** Whether this adapter can currently accept a submit (fail-closed WHY when false). */
  canSubmit: boolean;
  reason: string;
}
