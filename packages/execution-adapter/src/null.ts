/**
 * null.ts — the NullExecutionAdapter.
 *
 * The fail-closed default. It is what the factory selects when no venue is configured (or when
 * an integration is default-off / opt-in). Every mutating method rejects with an explicit
 * reason and NEVER throws, NEVER touches the sealed core, and NEVER emits an event. It exists
 * so a mis-wired or un-provisioned runtime cannot accidentally place, fill or cancel anything —
 * the safe absence of a venue, made explicit.
 */

import { buildHealth, buildStatusView, fail, type ExecutionAdapter } from "./adapter.js";
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

const KIND = "NULL" as const;
const UNAVAILABLE = "no execution venue is bound (null adapter)";

function submit(session: AdapterSession, cmd: SubmitCommand): AdapterResult {
  return fail(session, "ADAPTER_UNAVAILABLE", `submit refused — ${UNAVAILABLE}`, cmd.at, false);
}

function acknowledge(session: AdapterSession, cmd: AcknowledgeCommand): AdapterResult {
  return fail(session, "ADAPTER_UNAVAILABLE", `acknowledge refused — ${UNAVAILABLE}`, cmd.at, false);
}

function fill(session: AdapterSession, cmd: FillCommand): AdapterResult {
  return fail(session, "ADAPTER_UNAVAILABLE", `fill refused — ${UNAVAILABLE}`, cmd.at, false);
}

function cancel(session: AdapterSession, cmd: CancelCommand): AdapterResult {
  return fail(session, "ADAPTER_UNAVAILABLE", `cancel refused — ${UNAVAILABLE}`, cmd.at, false);
}

function cancelAll(session: AdapterSession, cmd: CancelAllCommand): AdapterResult {
  return fail(session, "ADAPTER_UNAVAILABLE", `cancelAll refused — ${UNAVAILABLE}`, cmd.at, false);
}

function replace(session: AdapterSession, cmd: ReplaceCommand): AdapterResult {
  return fail(session, "ADAPTER_UNAVAILABLE", `replace refused — ${UNAVAILABLE}`, cmd.at, false);
}

/**
 * Shutdown on the null adapter is a benign, idempotent state flip — there is nothing live to
 * cancel and nothing to emit. It never fails (shutting down an already-safe adapter is safe).
 */
function shutdown(session: AdapterSession, cmd: ShutdownCommand): AdapterResult {
  const down: AdapterSession = { ...session, status: "SHUTDOWN", updatedAt: cmd.at, clock: cmd.at };
  return { ok: true, session: down, events: [], error: null };
}

function status(session: AdapterSession): AdapterStatusView {
  return buildStatusView(session);
}

function health(session: AdapterSession): AdapterHealth {
  return buildHealth(session, UNAVAILABLE);
}

/** The null adapter — behavior-only (stateless); always fail-closed. */
export const NullExecutionAdapter: ExecutionAdapter = {
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
