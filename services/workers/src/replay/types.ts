/**
 * Deterministic replay contracts (STEP 11).
 *
 * Replay reconstructs a historical decision from PERSISTED artifacts only. It
 * never calls /features/compute and never recomputes featureHash: hash fields
 * are compared as opaque strings (lineage integrity), and the decision is
 * recomputed from the persisted feature VALUES via the frozen v1 strategy rule.
 */

import type { SignalState } from "@nexus/core";

/** Persisted DataQualityReport projection (only what replay reads). */
export interface ReplayDataQualityReport {
  id: string;
  score: number;
  status: "PASSED" | "FAILED";
  datasetHash: string;
}

/** Persisted FeatureSnapshot projection. `features` are the canonical values. */
export interface ReplayFeatureSnapshot {
  id: string;
  featureHash: string;
  features: Record<string, number>;
}

/** Persisted Signal projection (the historical decision + lineage). */
export interface ReplaySignal {
  id: string;
  state: SignalState;
  featureHash: string;
  datasetHash: string;
  featureSnapshotId: string;
  dqReportId: string;
  strategyVersionId: string;
}

/** Persisted StrategyVersion projection (decision parameters). */
export interface ReplayStrategyVersion {
  id: string;
  parameters: Record<string, unknown>;
}

export interface ReplayInput {
  dqReport: ReplayDataQualityReport;
  featureSnapshot: ReplayFeatureSnapshot;
  signal: ReplaySignal;
  strategyVersion: ReplayStrategyVersion;
}

/**
 * Terminal replay outcomes:
 *  - MATCH                 hashes + lineage consistent, recomputed == recorded
 *  - DECISION_MISMATCH     consistent, but recomputed != recorded decision
 *  - REFUSED_DQ            DQ below the admission floor -> decision refused
 *  - ABORTED_FEATURE_HASH  signal.featureHash != snapshot.featureHash (tamper)
 *  - ABORTED_DATASET_HASH  signal.datasetHash != dqReport.datasetHash (tamper)
 *  - ABORTED_LINEAGE       artifacts do not reference each other (corruption)
 *  - ABORTED_FEATURE_VECTOR persisted feature vector is corrupt/incomplete
 */
export type ReplayResult =
  | "MATCH"
  | "DECISION_MISMATCH"
  | "REFUSED_DQ"
  | "ABORTED_FEATURE_HASH"
  | "ABORTED_DATASET_HASH"
  | "ABORTED_LINEAGE"
  | "ABORTED_FEATURE_VECTOR";

export interface ReplayOutput {
  replayResult: ReplayResult;
  /** true only when a decision was reproduced and equals the recorded one. */
  decisionMatch: boolean;
  featureHashMatch: boolean;
  datasetHashMatch: boolean;
  /** Recomputed decision, or "REFUSED"/null when no decision was produced. */
  recomputedDecision: SignalState | "REFUSED" | null;
  recordedDecision: SignalState;
  detail: string;
}
