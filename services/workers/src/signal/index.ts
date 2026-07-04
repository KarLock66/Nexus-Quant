/**
 * Signal Engine — public module surface (Phase 3).
 */

export {
  decideSignal,
  resolveSignalParams,
  quantizeConfidence,
  DEFAULT_SIGNAL_PARAMS,
  SignalInputError,
} from "./decision.js";
export type { SignalParams, SignalDecisionResult } from "./decision.js";
export { generateSignal } from "./engine.js";
export { verifySignalLineage } from "./lineage.js";
export { replayEngineSignal } from "./replay.js";
export {
  persistEngineSignal,
  runSignalEngine,
} from "./persistence.js";
export type {
  PersistedEngineSignal,
  SignalEngineDeps,
  RunSignalEngineResult,
} from "./persistence.js";
export type {
  SignalEngineInput,
  GeneratedSignal,
  SignalGenerationResult,
  PersistedSignal,
  SignalFeatureSnapshot,
  SignalDataQualityReport,
  SignalStrategyVersion,
  LineageVerification,
  SignalReplayResult,
} from "./types.js";
