/**
 * Signal Engine contracts (STEP 15 / 16 / 17 / 20).
 *
 * Projections of the persisted artifacts replay needs, plus the engine's pure
 * output and the lineage-verification shapes. featureHash is Python-
 * authoritative and datasetHash is TS-authoritative; both are carried VERBATIM
 * and never recomputed here.
 */

import type { SignalDecision } from "@nexus/core";
import type { SignalParams } from "./decision.js";

/** Persisted FeatureSnapshot projection. `features` are the canonical values. */
export interface SignalFeatureSnapshot {
  id: string;
  symbol: string;
  featureHash: string;
  features: Record<string, number>;
}

/** Persisted DataQualityReport projection. */
export interface SignalDataQualityReport {
  id: string;
  score: number;
  status: "PASSED" | "FAILED";
  datasetHash: string;
}

/** Persisted StrategyVersion projection (decision parameters). */
export interface SignalStrategyVersion {
  id: string;
  parameters: Record<string, unknown>;
}

/** Inputs to a single deterministic generation. */
export interface SignalEngineInput {
  featureSnapshot: SignalFeatureSnapshot;
  dqReport: SignalDataQualityReport;
  strategyVersion: SignalStrategyVersion;
}

/**
 * Pure engine output (no id/createdAt — those are DB-assigned at persistence,
 * keeping generation free of Date.now and id generation). confidence is the
 * quantized 4-decimal string that is persisted and compared verbatim.
 */
export interface GeneratedSignal {
  symbol: string;
  side: SignalDecision;
  decision: SignalDecision;
  confidence: string;
  strategyVersionId: string;
  /** Resolved params in force at generation — persisted for drift-evident replay. */
  strategyParams: SignalParams;
  featureSnapshotId: string;
  dqReportId: string;
  datasetHash: string;
  featureHash: string;
}

export type SignalGenerationResult =
  | { status: "GENERATED"; signal: GeneratedSignal }
  | { status: "REFUSED"; reason: string };

/** Persisted EngineSignal projection (the recorded decision + lineage). */
export interface PersistedSignal {
  id: string;
  symbol: string;
  side: SignalDecision;
  decision: SignalDecision;
  confidence: string;
  strategyVersionId: string;
  /** Resolved params snapshot in force at generation (drift-evident on read). */
  strategyParams: SignalParams;
  featureSnapshotId: string;
  dqReportId: string;
  datasetHash: string;
  featureHash: string;
}

/** STEP 17 lineage-verification result. */
export interface LineageVerification {
  lineageValid: boolean;
  datasetHashMatch: boolean;
  featureHashMatch: boolean;
  strategyVersionMatch: boolean;
  detail: string;
}

/** STEP 20 replay-equivalence result. */
export interface SignalReplayResult {
  replayResult:
    | "MATCH"
    | "DECISION_MISMATCH"
    | "REFUSED_DQ"
    | "ABORTED_LINEAGE"
    | "ABORTED_FEATURE_VECTOR";
  decisionMatch: boolean;
  confidenceMatch: boolean;
  /** Reconstructed trend bias (`side`) equals the persisted one. */
  sideMatch: boolean;
  lineageMatch: boolean;
  datasetHashMatch: boolean;
  featureHashMatch: boolean;
  strategyVersionMatch: boolean;
  recomputedDecision: SignalDecision | "REFUSED" | null;
  recordedDecision: SignalDecision;
  detail: string;
}
