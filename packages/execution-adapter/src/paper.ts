/**
 * paper.ts — the PaperExecutionAdapter.
 *
 * A deterministic, injected-fill-only runtime for the sealed core. It NEVER:
 *   • fabricates a fill (fills are injected VERBATIM via {@link fill}),
 *   • simulates market movement, or auto-profits,
 *   • reads a clock or uses randomness (every command carries the injected `at`).
 * It composes sealed-core reducer commands to translate a runtime request into a lifecycle
 * transition, and emits exactly the venue-boundary events that resulted. It contains NO trading
 * logic — every price, level, quantity and gate comes from the core state it carries.
 *
 * Lifecycle it drives (all via the sealed reducer):
 *   submit      →  ARM (silent) → SUBMIT               ⇒ SUBMITTED
 *   acknowledge →  ACKNOWLEDGE                          ⇒ ACKNOWLEDGED
 *   fill(entry) →  FILL (→ auto-OPEN when fully filled) ⇒ PARTIAL_FILL | FILLED
 *   fill(prot.) →  FILL (reduces the open position)     ⇒ PARTIAL_FILL | FILLED
 *   cancel/all  →  CANCEL (execution-scoped; event orderId=null) ⇒ CANCELLED
 *   shutdown    →  CANCEL (if live) then SHUTDOWN        ⇒ CANCELLED
 */

import type { ExecutionCommand } from "@nexus/execution-core";
import {
  buildHealth,
  buildStatusView,
  driveAndEmit,
  driveSilent,
  fail,
  toResult,
  type ExecutionAdapter,
} from "./adapter.js";
import {
  validateAcknowledge,
  validateCancel,
  validateCancelAll,
  validateFill,
  validateSubmit,
} from "./validation.js";
import type {
  AcknowledgeCommand,
  CancelAllCommand,
  CancelCommand,
  FillCommand,
  ReplaceCommand,
  ShutdownCommand,
  SubmitCommand,
} from "./commands.js";
import type { AdapterHealth, AdapterResult, AdapterSession, AdapterStatusView } from "./types.js";

const KIND = "PAPER" as const;

function submit(session: AdapterSession, cmd: SubmitCommand): AdapterResult {
  const reason = validateSubmit(session, cmd);

  // Fail-closed operational stops actively drive the core to its terminal state so the session
  // honestly reflects the outcome (and emits the boundary event), then report the failure.
  if (reason === "KILL_SWITCH") {
    const driven = driveAndEmit(session, { type: "KILL", at: cmd.at });
    return {
      ok: false,
      session: driven.session,
      events: driven.events,
      error: { reason: "KILL_SWITCH", message: "kill switch engaged → execution cancelled", at: cmd.at, fatal: false },
    };
  }
  if (reason === "RUNTIME_UNHEALTHY") {
    const driven = driveAndEmit(session, { type: "RUNTIME_UNHEALTHY", at: cmd.at });
    return {
      ok: false,
      session: driven.session,
      events: driven.events,
      error: { reason: "RUNTIME_UNHEALTHY", message: "runtime unhealthy → execution failed", at: cmd.at, fatal: true },
    };
  }
  if (reason) return fail(session, reason, `submit rejected: ${reason}`, cmd.at, reason === "TERMINAL");

  // ARM (internal, silent) → SUBMIT (emits SUBMITTED).
  const armed = driveSilent(session, { type: "ARM", at: cmd.at });
  if (!armed.ok) return { ok: false, session, events: [], error: armed.error };

  const submitted = driveAndEmit(armed.session, { type: "SUBMIT", at: cmd.at });
  if (!submitted.ok) return { ok: false, session, events: [], error: submitted.error };

  const bound: AdapterSession = { ...submitted.session, submitted: true };
  return toResult({ ...submitted, session: bound });
}

function acknowledge(session: AdapterSession, cmd: AcknowledgeCommand): AdapterResult {
  const reason = validateAcknowledge(session);
  if (reason) return fail(session, reason, `acknowledge rejected: ${reason}`, cmd.at, reason === "TERMINAL");
  return toResult(driveAndEmit(session, { type: "ACKNOWLEDGE", at: cmd.at }));
}

function fill(session: AdapterSession, cmd: FillCommand): AdapterResult {
  const reason = validateFill(session, cmd);
  if (reason) return fail(session, reason, `fill rejected: ${reason}`, cmd.at, false);

  const filled = driveAndEmit(
    session,
    { type: "FILL", at: cmd.at, orderId: cmd.orderId, price: cmd.price, quantity: cmd.quantity },
    cmd.orderId,
  );
  if (!filled.ok) return { ok: false, session, events: [], error: filled.error };

  // A fully-filled ENTRY deterministically opens the position (sealed-core bookkeeping — the
  // adapter fabricates nothing; OPEN uses the core's own VWAP). This is silent (no venue event).
  let next = filled.session;
  if (next.core && next.core.status === "FILLED") {
    const opened = driveSilent(next, { type: "OPEN", at: cmd.at });
    if (opened.ok) next = opened.session;
    // If OPEN is illegal for any reason we leave the FILLED state untouched — never forced.
  }
  return toResult({ ok: true, session: next, events: filled.events, error: null });
}

function cancel(session: AdapterSession, cmd: CancelCommand): AdapterResult {
  const reason = validateCancel(session, cmd);
  if (reason) return fail(session, reason, `cancel rejected: ${reason}`, cmd.at, reason === "TERMINAL");
  // The sealed core has NO per-order cancel — CANCEL is execution-scoped (it terminates every
  // order + closes any open position). We therefore emit the CANCELLED event with orderId=null
  // (the HONEST blast radius, matching cancelAll) and record the caller's targeted order only in
  // the reason, so the audit never misrepresents a whole-execution cancel as a single-order one.
  const core: ExecutionCommand = {
    type: "CANCEL",
    at: cmd.at,
    reason: cmd.reason ?? `cancel requested for ${cmd.orderId} → execution-scoped cancel`,
  };
  return toResult(driveAndEmit(session, core, null));
}

function cancelAll(session: AdapterSession, cmd: CancelAllCommand): AdapterResult {
  const reason = validateCancelAll(session);
  if (reason) return fail(session, reason, `cancelAll rejected: ${reason}`, cmd.at, reason === "TERMINAL");
  const core: ExecutionCommand = { type: "CANCEL", at: cmd.at, reason: cmd.reason ?? "all orders cancelled" };
  return toResult(driveAndEmit(session, core, null));
}

/**
 * REPLACE is a live-venue capability (cancel a resting order handle + place a new one). The
 * paper foundation cannot honor it without inventing order mechanics the sealed core does not
 * model, so it fails closed — a broker adapter (Phase 11B+) attaches real replace semantics.
 */
function replace(session: AdapterSession, cmd: ReplaceCommand): AdapterResult {
  return fail(
    session,
    "UNSUPPORTED_OPERATION",
    "replace requires a live broker adapter — unavailable in the paper foundation",
    cmd.at,
    false,
  );
}

function shutdown(session: AdapterSession, cmd: ShutdownCommand): AdapterResult {
  if (session.status === "SHUTDOWN") {
    // Idempotent — already shut down, nothing to cancel, no event.
    return toResult({ ok: true, session, events: [], error: null });
  }

  // Fail-safe: a live (bound, non-terminal) execution is cancelled as part of shutdown.
  let next = session;
  let events = [] as AdapterResult["events"];
  if (next.core && next.core.lifecycle.terminal === false) {
    const cancelled = driveAndEmit(next, { type: "CANCEL", at: cmd.at, reason: cmd.reason ?? "adapter shutdown" }, null);
    if (cancelled.ok) {
      next = cancelled.session;
      events = cancelled.events;
    }
  }
  const down: AdapterSession = { ...next, status: "SHUTDOWN", updatedAt: cmd.at, clock: cmd.at };
  return toResult({ ok: true, session: down, events, error: null });
}

function status(session: AdapterSession): AdapterStatusView {
  return buildStatusView(session);
}

function health(session: AdapterSession): AdapterHealth {
  const reason =
    session.status === "SHUTDOWN"
      ? "adapter shut down"
      : session.submitted
        ? "execution already submitted"
        : session.core
          ? "ready to submit"
          : "no execution bound";
  return buildHealth(session, reason);
}

/** The paper adapter — behavior-only (stateless); all state lives in the threaded session. */
export const PaperExecutionAdapter: ExecutionAdapter = {
  kind: KIND,
  submit,
  acknowledge,
  fill,
  cancel,
  cancelAll,
  replace,
  shutdown,
  status,
  health,
};
