/**
 * Production Signal Engine (STEP 16).
 *
 * generateSignal is PURE and deterministic: same (FeatureSnapshot, DQ Report,
 * StrategyVersion) -> same GeneratedSignal, every time. It performs no IO, reads
 * no clock, draws no randomness, and issues no network calls. featureHash and
 * datasetHash are copied VERBATIM from the admitting artifacts; the decision is
 * the frozen v1 rule over the snapshot's persisted feature values.
 *
 * Fail-closed: a sub-90 DQ report or a corrupt feature vector yields REFUSED
 * (an explicit, non-silent refusal) rather than a fabricated decision.
 */

import { MIN_DATA_QUALITY_SCORE } from "@nexus/core";
import {
  decideSignal,
  quantizeConfidence,
  resolveSignalParams,
  SignalInputError,
} from "./decision.js";
import type { SignalEngineInput, SignalGenerationResult } from "./types.js";

export function generateSignal(input: SignalEngineInput): SignalGenerationResult {
  const { featureSnapshot, dqReport, strategyVersion } = input;

  // Admission floor (the same hard floor as DQ/Feature Store). Fail-closed.
  if (dqReport.status !== "PASSED" || dqReport.score < MIN_DATA_QUALITY_SCORE) {
    return {
      status: "REFUSED",
      reason: `DQ score ${dqReport.score} (${dqReport.status}) < ${MIN_DATA_QUALITY_SCORE} — signal refused`,
    };
  }

  const params = resolveSignalParams(strategyVersion.parameters);

  let result;
  try {
    result = decideSignal(featureSnapshot.features, params);
  } catch (err) {
    if (err instanceof SignalInputError) {
      return { status: "REFUSED", reason: err.message };
    }
    throw err;
  }

  return {
    status: "GENERATED",
    signal: {
      symbol: featureSnapshot.symbol,
      side: result.side,
      decision: result.decision,
      confidence: quantizeConfidence(result.confidence),
      strategyVersionId: strategyVersion.id,
      // Snapshot the resolved params so replay reconstructs from persisted
      // artifacts alone and post-generation strategy drift is detectable.
      strategyParams: params,
      featureSnapshotId: featureSnapshot.id,
      dqReportId: dqReport.id,
      // Verbatim — never recomputed (featureHash Python-auth; datasetHash TS-auth).
      datasetHash: dqReport.datasetHash,
      featureHash: featureSnapshot.featureHash,
    },
  };
}
