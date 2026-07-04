/**
 * @nexus/execution-core — Phase 11A-1 Execution Core Foundation.
 *
 * The single, pure, deterministic, fail-closed, replay-safe core that turns an already-served
 * TradingDecision + TradePlan (the single source of truth) into an executable lifecycle:
 * ExecutionIntent → ExecutionPlan → ExecutionState (orders / fills / positions) with an
 * immutable audit trail. It is the ONLY component allowed to create, track and close orders,
 * and it has ZERO broker dependency — direction / confidence / entry / stop / targets / R:R /
 * readiness are consumed VERBATIM and NEVER recomputed. A future Broker/Paper/Live adapter
 * will consume these contracts; nothing here performs IO, reads a wall clock, or fabricates a
 * value (absent sources fail closed to UNAVAILABLE / null).
 */

export * from "./types.js";

// Orchestration
export { createExecution, advanceExecution, type CreateExecutionResult } from "./execution.js";

// Intent / plan derivation
export { buildExecutionIntent, type BuildIntentOptions } from "./intent.js";
export { buildExecutionPlan } from "./plan.js";

// State machine
export {
  initExecutionState,
  reduceExecution,
  reduceSequence,
  canTransition,
  isTerminal,
  TERMINAL_STATUSES,
} from "./state.js";

// Lifecycle primitives
export {
  makeOrder,
  transitionOrder,
  applyFillToOrder,
  canTransitionOrder,
  sideForRole,
  type MakeOrderArgs,
} from "./orders.js";
export { makeFill, nextFillSeq, type MakeFillArgs } from "./fills.js";
export {
  emptyPosition,
  openPosition,
  reducePosition,
  closePosition,
} from "./positions.js";

// Events / audit
export { makeEvent, type MakeEventArgs } from "./events.js";
export { emptyAudit, appendEvent, lastEvent } from "./audit.js";

// Validation
export { validateInput, checkSubmittable, isSubmittable } from "./validation.js";

// Serialization
export { stableStringify, serializeExecutionState, serializeAudit } from "./serialization.js";

// Utilities (deterministic helpers + provenance mapping)
export {
  num,
  mv,
  clamp,
  clamp01,
  round,
  sumFinite,
  toExecProvenance,
  levelProvenance,
  intentId,
  planId,
  orderId,
  fillId,
  positionId,
  eventId,
} from "./util.js";
