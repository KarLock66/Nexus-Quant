/**
 * Feature Store consumer — public module surface (STEP 10).
 */

export {
  computeFeatures,
  FEATURE_COMPUTE_TIMEOUT_MS,
  FeatureComputeAuthError,
  FeatureComputeError,
} from "./client.js";
export {
  consumeFeatureComputation,
  FeatureAdmissionError,
  UnknownFeatureSetError,
  FeatureContractMismatchError,
} from "./consumer.js";
export type { FeatureConsumerDeps } from "./consumer.js";
export type {
  FeatureComputeInput,
  FeatureComputeResult,
  PersistedFeatureSnapshot,
} from "./types.js";
