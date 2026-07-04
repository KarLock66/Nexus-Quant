/**
 * @nexus/execution-adapter — Phase 11A-2 Execution Adapter Foundation.
 *
 * The pure, deterministic, fail-closed translation layer between runtime services and the
 * SEALED @nexus/execution-core. It converts a runtime request (submit / acknowledge / fill /
 * cancel / shutdown) into sealed-core reducer transitions and emits an immutable, replay-safe
 * venue-boundary event stream. It ships a PaperExecutionAdapter (deterministic, injected-fill-
 * only, no market simulation, no auto-profit) and a NullExecutionAdapter (always fail-closed);
 * a factory selects between them, default-off / opt-in. It has ZERO broker/exchange/IO
 * dependency and contains NO trading logic — direction, confidence, entry, stop, targets, R:R,
 * readiness and sizing are ALL owned by the sealed core and consumed VERBATIM.
 */

export * from "./types.js";

// Runtime context (fail-closed gates re-checked at submit time)
export { isRuntimeHealthy, runtimeBlockReason, type RuntimeState, type RuntimeContext } from "./runtime.js";

// Commands
export type {
  AdapterCommand,
  AdapterCommandType,
  SubmitCommand,
  AcknowledgeCommand,
  FillCommand,
  CancelCommand,
  CancelAllCommand,
  ReplaceCommand,
  ShutdownCommand,
} from "./commands.js";

// The contract + adapters
export type { ExecutionAdapter } from "./adapter.js";
export { PaperExecutionAdapter } from "./paper.js";
export { NullExecutionAdapter } from "./null.js";

// Factory / session construction
export {
  createAdapter,
  createSession,
  createEmptySession,
  type AdapterConfig,
  type CreateSessionOptions,
} from "./factory.js";

// Events
export {
  makeAdapterEvent,
  adapterEventId,
  mapCoreEventType,
  type MakeAdapterEventArgs,
} from "./events.js";

// Validation (fail-closed gates)
export {
  validateSubmit,
  validateAcknowledge,
  validateFill,
  validateCancel,
  validateCancelAll,
} from "./validation.js";

// Serialization (stable / replay-safe)
export { stableStringify, serializeSession, serializeEvents } from "./serialization.js";
