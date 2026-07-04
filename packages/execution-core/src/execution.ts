/**
 * execution.ts — top-level orchestration.
 *
 * `createExecution` is the single entry point that turns a served TradingDecision + TradePlan
 * (SSoT) into a live {@link ExecutionState}. It is pure and fail-closed:
 *   • no decision            → NO_DECISION  (no intent, no state)
 *   • no plan                → NO_PLAN      (no plan, no state)
 *   • otherwise              → build intent → build plan → init state → PLAN
 *   • kill switch engaged    → immediate CANCELLED
 *   • runtime unhealthy      → FAILED
 * The clock is injected (`input.now` / per-command `at`); nothing here reads a wall clock or
 * recomputes a decision value. Downstream advancement goes through {@link advanceExecution}.
 */

import { buildExecutionIntent } from "./intent.js";
import { buildExecutionPlan } from "./plan.js";
import { initExecutionState, reduceExecution } from "./state.js";
import { validateInput } from "./validation.js";
import type {
  ExecutionCommand,
  ExecutionFailure,
  ExecutionInput,
  ExecutionResult,
  ExecutionState,
} from "./types.js";

export interface CreateExecutionResult {
  ok: boolean;
  /** The initialized execution, or null when the input failed closed before an intent existed. */
  state: ExecutionState | null;
  failure: ExecutionFailure | null;
}

export function createExecution(input: ExecutionInput): CreateExecutionResult {
  const inputFailure = validateInput(input);
  if (inputFailure || !input.decision || !input.plan) {
    const reason = inputFailure ?? "VALIDATION_FAILED";
    return {
      ok: false,
      state: null,
      failure: { reason, message: `cannot create execution: ${reason}`, at: input.now, fatal: true },
    };
  }

  const intent = buildExecutionIntent(input.decision, input.plan, {
    now: input.now,
    mode: input.mode ?? "SIMULATION",
    venue: input.venue ?? "UNSET",
  });
  const plan = buildExecutionPlan(intent);
  const initial = initExecutionState(intent, plan);

  // NOT_CREATED → PLANNED (planning is pure/offline; always legal here).
  const planned = reduceExecution(initial, { type: "PLAN", at: input.now });
  let result: ExecutionResult = planned;

  // Fail-closed operational guards, in priority order: kill switch first, then runtime.
  if (input.killEngaged) {
    result = reduceExecution(result.state, { type: "KILL", at: input.now });
  } else if (!input.runtimeHealthy) {
    result = reduceExecution(result.state, { type: "RUNTIME_UNHEALTHY", at: input.now });
  }

  return { ok: result.ok, state: result.state, failure: result.state.failure };
}

/** Advance an existing execution by one command (thin, explicit re-export of the reducer). */
export function advanceExecution(state: ExecutionState, command: ExecutionCommand): ExecutionResult {
  return reduceExecution(state, command);
}
