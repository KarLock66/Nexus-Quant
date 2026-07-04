/**
 * Feature bridge — public module surface (Phase 9).
 */

export {
  computeAndPersistFeatures,
  FeatureBridgeError,
  DEFAULT_FEATURE_SET,
  DEFAULT_FEATURE_VERSION,
} from "./bridge.js";
export type {
  FeatureBridgeDeps,
  FeatureBridgeInput,
  PersistedFeatureSnapshot,
} from "./bridge.js";
export {
  computeFeatures,
  FeatureComputeAuthError,
  FeatureComputeError,
  FEATURE_COMPUTE_TIMEOUT_MS,
} from "./client.js";
export type { FeatureComputeInput, FeatureComputeResult } from "./client.js";
