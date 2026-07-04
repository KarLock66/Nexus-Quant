/**
 * Deterministic replay — public module surface (STEP 11).
 */

export { replaySignal } from "./engine.js";
export {
  evaluateCoreTechnical,
  resolveParams,
  DEFAULT_STRATEGY_PARAMS,
  StrategyInputError,
} from "./strategy.js";
export type { StrategyParams } from "./strategy.js";
export type {
  ReplayInput,
  ReplayOutput,
  ReplayResult,
  ReplayDataQualityReport,
  ReplayFeatureSnapshot,
  ReplaySignal,
  ReplayStrategyVersion,
} from "./types.js";
