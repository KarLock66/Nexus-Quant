/**
 * validation.ts — fail-closed adapter gates.
 *
 * Every gate is a PURE predicate returning the FIRST failing {@link AdapterFailureReason} (the
 * WHY, in deterministic order) or null when it passes. Nothing is ever silently admitted. These
 * gates NEVER recompute a trading value — they only assert that (a) the adapter is available,
 * (b) the sealed core state is present and legal for the requested op, and (c) the runtime
 * snapshot permits it. The core's own reducer is the ultimate authority on legal transitions;
 * these gates fail fast with a clearer reason before the core is ever touched.
 */

import { isTerminal } from "@nexus/execution-core";
import { runtimeBlockReason } from "./runtime.js";
import type { SubmitCommand, CancelCommand, FillCommand } from "./commands.js";
import type { AdapterFailureReason, AdapterSession, ExecutionState } from "./types.js";

/** True when a mutating op may not run because the adapter itself is shut down. */
function shutdownReason(session: AdapterSession): AdapterFailureReason | null {
  return session.status === "SHUTDOWN" ? "ADAPTER_SHUTDOWN" : null;
}

/** The session must carry a bound core execution to mutate anything. */
function boundState(session: AdapterSession): ExecutionState | null {
  return session.core;
}

/**
 * Assert the bound plan is structurally sound at the boundary: every order has an id and a
 * creation timestamp. These are fail-closed integrity checks the core assumes but the adapter
 * re-verifies before it will submit (a missing id/timestamp would break the audit + replay).
 */
function planIntegrityReason(state: ExecutionState): AdapterFailureReason | null {
  const plan = state.plan;
  if (!plan) return "NO_PLAN";
  if (!Number.isFinite(plan.createdAt)) return "MISSING_TIMESTAMPS";
  for (const o of plan.orders) {
    if (!o.orderId) return "MISSING_ORDER_IDS";
    if (!Number.isFinite(o.createdAt) || !Number.isFinite(o.updatedAt)) return "MISSING_TIMESTAMPS";
  }
  return null;
}

/**
 * Fail-closed SUBMIT gate. Deterministic order:
 *   adapter shutdown → not bound → already terminal → duplicate submit → runtime (kill/health)
 *   → plan present + submittable → plan integrity (order ids / timestamps).
 * Returns null only when the submission may legally proceed into the sealed core.
 */
export function validateSubmit(session: AdapterSession, cmd: SubmitCommand): AdapterFailureReason | null {
  const sd = shutdownReason(session);
  if (sd) return sd;

  const state = boundState(session);
  if (!state) return "NOT_BOUND";
  if (isTerminal(state.status)) return "TERMINAL";
  if (session.submitted) return "DUPLICATE_SUBMIT";

  const runtime = runtimeBlockReason(cmd.runtime);
  if (runtime) return runtime;

  if (!state.plan) return "NO_PLAN";
  if (!state.plan.submittable) return state.plan.blockedReason ?? "VALIDATION_FAILED";

  const integrity = planIntegrityReason(state);
  if (integrity) return integrity;

  return null;
}

/** Fail-closed ACKNOWLEDGE gate — requires a bound, submitted, non-terminal execution. */
export function validateAcknowledge(session: AdapterSession): AdapterFailureReason | null {
  const sd = shutdownReason(session);
  if (sd) return sd;
  const state = boundState(session);
  if (!state) return "NOT_BOUND";
  if (isTerminal(state.status)) return "TERMINAL";
  if (!session.submitted) return "NOT_SUBMITTED";
  return null;
}

/**
 * Fail-closed FILL gate. Beyond the shutdown/bound/terminal/submitted checks, the injected fill
 * must reference a known order and carry a positive quantity + finite price (the adapter never
 * accepts a fabricated or malformed fill). The core is the authority on whether the CURRENT
 * status admits a fill; that is left to the reducer (reported as ILLEGAL_TRANSITION).
 */
export function validateFill(session: AdapterSession, cmd: FillCommand): AdapterFailureReason | null {
  const sd = shutdownReason(session);
  if (sd) return sd;
  const state = boundState(session);
  if (!state) return "NOT_BOUND";
  if (isTerminal(state.status)) return "TERMINAL";
  if (!session.submitted) return "NOT_SUBMITTED";
  if (!cmd.orderId || !state.orders.some((o) => o.orderId === cmd.orderId)) return "UNKNOWN_ORDER";
  if (!Number.isFinite(cmd.price) || !Number.isFinite(cmd.quantity) || cmd.quantity <= 0) {
    return "VALIDATION_FAILED";
  }
  return null;
}

/** Fail-closed CANCEL gate — the referenced order must belong to the bound execution. */
export function validateCancel(session: AdapterSession, cmd: CancelCommand): AdapterFailureReason | null {
  const sd = shutdownReason(session);
  if (sd) return sd;
  const state = boundState(session);
  if (!state) return "NOT_BOUND";
  if (isTerminal(state.status)) return "TERMINAL";
  if (!cmd.orderId || !state.orders.some((o) => o.orderId === cmd.orderId)) return "UNKNOWN_ORDER";
  return null;
}

/** Fail-closed CANCEL_ALL gate — bound and non-terminal. */
export function validateCancelAll(session: AdapterSession): AdapterFailureReason | null {
  const sd = shutdownReason(session);
  if (sd) return sd;
  const state = boundState(session);
  if (!state) return "NOT_BOUND";
  if (isTerminal(state.status)) return "TERMINAL";
  return null;
}
