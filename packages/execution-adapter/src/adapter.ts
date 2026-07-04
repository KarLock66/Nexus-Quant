/**
 * adapter.ts — the ExecutionAdapter contract + shared, pure boundary helpers.
 *
 * The {@link ExecutionAdapter} interface is FUNCTIONAL: every method takes the current
 * {@link AdapterSession} and returns a NEW one (mirroring the core's `reduceExecution(state,
 * cmd)` shape). The adapter objects are behavior-only — they hold NO state — so two calls with
 * the same (session, command) are byte-identical. The helpers below are the ONLY places the
 * adapter touches the sealed core (`advanceExecution`) or mints an event; both paper and null
 * build their results exclusively from these, so the fail-closed / determinism / no-hidden-state
 * guarantees hold uniformly.
 */

import { advanceExecution, isTerminal } from "@nexus/execution-core";
import type { ExecutionCommand, ExecutionResult } from "@nexus/execution-core";
import { makeAdapterEvent, mapCoreEventType } from "./events.js";
import type {
  AcknowledgeCommand,
  CancelAllCommand,
  CancelCommand,
  FillCommand,
  ReplaceCommand,
  ShutdownCommand,
  SubmitCommand,
} from "./commands.js";
import type {
  AdapterError,
  AdapterEvent,
  AdapterFailureReason,
  AdapterHealth,
  AdapterKind,
  AdapterResult,
  AdapterSession,
  AdapterStatusView,
  ExecutionProvenance,
} from "./types.js";

// ─────────────────────────── The contract ───────────────────────────

/**
 * The runtime-facing execution adapter. The seven required methods (submit / cancel /
 * cancelAll / replace / status / health / shutdown) plus the two inbound venue callbacks
 * (acknowledge / fill) that a real broker's stream would invoke — injected here, never
 * fabricated. Every mutating method is pure, deterministic, total (never throws) and returns an
 * explicit {@link AdapterResult}.
 */
export interface ExecutionAdapter {
  readonly kind: AdapterKind;

  submit(session: AdapterSession, cmd: SubmitCommand): AdapterResult;
  acknowledge(session: AdapterSession, cmd: AcknowledgeCommand): AdapterResult;
  fill(session: AdapterSession, cmd: FillCommand): AdapterResult;
  cancel(session: AdapterSession, cmd: CancelCommand): AdapterResult;
  cancelAll(session: AdapterSession, cmd: CancelAllCommand): AdapterResult;
  replace(session: AdapterSession, cmd: ReplaceCommand): AdapterResult;
  shutdown(session: AdapterSession, cmd: ShutdownCommand): AdapterResult;

  status(session: AdapterSession): AdapterStatusView;
  health(session: AdapterSession): AdapterHealth;
}

// ─────────────────────────── Result constructors ───────────────────────────

/** A fail-closed rejection. The session is returned UNCHANGED — a reject never mutates state. */
export function fail(
  session: AdapterSession,
  reason: AdapterFailureReason,
  message: string,
  at: number,
  fatal = false,
): AdapterResult {
  const error: AdapterError = { reason, message, at, fatal };
  return { ok: false, session, events: [], error };
}

/** A success result carrying the advanced session and the events emitted by this op. */
function succeed(session: AdapterSession, events: readonly AdapterEvent[]): AdapterResult {
  return { ok: true, session, events, error: null };
}

// ─────────────────────────── Event emission ───────────────────────────

interface EmitArgs {
  orderId: string | null;
  type: AdapterEvent["type"];
  reason: string;
  provenance: ExecutionProvenance;
  ts: number;
}

/** Append one deterministic adapter event, returning the new session + the event. Pure. */
export function emit(session: AdapterSession, a: EmitArgs): { session: AdapterSession; event: AdapterEvent } {
  const seq = session.seq + 1;
  const event = makeAdapterEvent({
    intentId: session.intentId ?? session.core?.intentId ?? "unbound",
    seq,
    adapter: session.adapter,
    orderId: a.orderId,
    type: a.type,
    mode: session.mode,
    venue: session.venue,
    reason: a.reason,
    provenance: a.provenance,
    ts: a.ts,
  });
  const next: AdapterSession = {
    ...session,
    events: [...session.events, event],
    seq,
    updatedAt: a.ts,
    clock: a.ts,
  };
  return { session: next, event };
}

// ─────────────────────────── Core-driving helpers ───────────────────────────

/** Map a rejected core result onto an adapter error (the core reason is already in our union). */
function coreError(result: ExecutionResult, at: number): AdapterError {
  const f = result.failure;
  return {
    reason: f?.reason ?? "VALIDATION_FAILED",
    message: f?.message ?? "core rejected transition",
    at,
    fatal: f?.fatal ?? false,
  };
}

/**
 * Advance the sealed core by one command WITHOUT emitting an adapter event (used for internal
 * transitions like ARM before submit, or OPEN after a filled entry). On core rejection the
 * session is left unchanged and the failure is surfaced.
 */
export function driveSilent(
  session: AdapterSession,
  command: ExecutionCommand,
): { ok: boolean; session: AdapterSession; error: AdapterError | null } {
  if (!session.core) {
    return { ok: false, session, error: { reason: "NOT_BOUND", message: "no core state", at: command.at, fatal: false } };
  }
  const result = advanceExecution(session.core, command);
  if (!result.ok) return { ok: false, session, error: coreError(result, command.at) };
  const next: AdapterSession = { ...session, core: result.state, updatedAt: command.at, clock: command.at };
  return { ok: true, session: next, error: null };
}

/**
 * Advance the sealed core by one command AND emit the corresponding adapter event (when the
 * core transition crosses a venue boundary). Internal-only core transitions map to null and
 * emit nothing. `orderIdOverride` tags fill/ack events with the concrete order.
 */
export function driveAndEmit(
  session: AdapterSession,
  command: ExecutionCommand,
  orderIdOverride?: string | null,
): { ok: boolean; session: AdapterSession; events: readonly AdapterEvent[]; error: AdapterError | null } {
  if (!session.core) {
    return {
      ok: false,
      session,
      events: [],
      error: { reason: "NOT_BOUND", message: "no core state", at: command.at, fatal: false },
    };
  }
  const result = advanceExecution(session.core, command);
  if (!result.ok) return { ok: false, session, events: [], error: coreError(result, command.at) };

  let next: AdapterSession = { ...session, core: result.state, updatedAt: command.at, clock: command.at };
  const emittedEvents: AdapterEvent[] = [];

  const coreEvent = result.event;
  if (coreEvent) {
    const type = mapCoreEventType(coreEvent.type);
    if (type) {
      const orderId =
        orderIdOverride !== undefined
          ? orderIdOverride
          : coreEvent.entity === "ORDER"
            ? coreEvent.entityId
            : null;
      const out = emit(next, {
        orderId,
        type,
        reason: coreEvent.reason,
        provenance: coreEvent.provenance,
        ts: command.at,
      });
      next = out.session;
      emittedEvents.push(out.event);
    }
  }
  return { ok: true, session: next, events: emittedEvents, error: null };
}

/** Package a driveAndEmit outcome into a public AdapterResult. */
export function toResult(o: {
  ok: boolean;
  session: AdapterSession;
  events: readonly AdapterEvent[];
  error: AdapterError | null;
}): AdapterResult {
  return o.ok ? succeed(o.session, o.events) : { ok: false, session: o.session, events: [], error: o.error };
}

// ─────────────────────────── Read views (shared) ───────────────────────────

/** Pure read projection of the managed execution. Never mutates; safe on an unbound session. */
export function buildStatusView(session: AdapterSession): AdapterStatusView {
  const state = session.core;
  if (!state) {
    return {
      bound: false,
      intentId: session.intentId,
      executionStatus: "UNBOUND",
      terminal: false,
      submitted: session.submitted,
      orders: [],
      position: null,
      eventCount: session.events.length,
      lastEventSeq: session.seq,
    };
  }
  return {
    bound: true,
    intentId: state.intentId,
    executionStatus: state.status,
    terminal: isTerminal(state.status),
    submitted: session.submitted,
    orders: state.orders.map((o) => ({
      orderId: o.orderId,
      role: o.role,
      side: o.side,
      status: o.status,
      price: o.price,
      quantity: o.quantity,
      filledQuantity: o.filledQuantity,
    })),
    position: state.position
      ? {
          status: state.position.status,
          quantity: state.position.quantity,
          entryQuantity: state.position.entryQuantity,
          closedQuantity: state.position.closedQuantity,
          avgEntryPrice: state.position.avgEntryPrice,
        }
      : null,
    eventCount: session.events.length,
    lastEventSeq: session.seq,
  };
}

/** Pure read projection of adapter health. `reason` is the fail-closed WHY when canSubmit=false. */
export function buildHealth(session: AdapterSession, reason: string): AdapterHealth {
  const state = session.core;
  const bound = state !== null;
  const terminal = state ? isTerminal(state.status) : false;
  const canSubmit = session.status === "READY" && bound && !session.submitted && !terminal;
  return {
    kind: session.adapter,
    mode: session.mode,
    venue: session.venue,
    status: session.status,
    bound,
    submitted: session.submitted,
    terminal,
    canSubmit,
    reason,
  };
}
