/**
 * Signal Replay Equivalence (STEP 20) — the Replay Engine remains the authority
 * for decision reconstruction.
 *
 * Reconstructs a persisted EngineSignal's decision from persisted artifacts and
 * proves Replay(signal) == original decision. Guarantees:
 *   - ZERO recomputation of featureHash (opaque string equality only)
 *   - ZERO recomputation of features (reads the snapshot's persisted values)
 *   - decision + side + confidence reconstructed by re-running the SAME pure
 *     rule the engine used, over PERSISTED params (not the live strategy row)
 *
 * Fail-closed ordering: lineage (incl. symbol + strategy-param drift) -> DQ
 * floor -> reconstruct. Any integrity failure aborts before a decision exists.
 */

import { MIN_DATA_QUALITY_SCORE } from "@nexus/core";
import { decideSignal, quantizeConfidence, resolveSignalParams, SignalInputError } from "./decision.js";
import { verifySignalLineage } from "./lineage.js";
import type {
  PersistedSignal,
  SignalDataQualityReport,
  SignalFeatureSnapshot,
  SignalReplayResult,
  SignalStrategyVersion,
} from "./types.js";
import { log } from "../lib/log.js";

export function replayEngineSignal(input: {
  signal: PersistedSignal;
  featureSnapshot: SignalFeatureSnapshot;
  dqReport: SignalDataQualityReport;
  strategyVersion: SignalStrategyVersion;
}): SignalReplayResult {
  const { signal, featureSnapshot, dqReport, strategyVersion } = input;
  const recordedDecision = signal.decision;

  const lineage = verifySignalLineage({ signal, featureSnapshot, dqReport, strategyVersion });

  const base = {
    lineageMatch: lineage.lineageValid,
    datasetHashMatch: lineage.datasetHashMatch,
    featureHashMatch: lineage.featureHashMatch,
    strategyVersionMatch: lineage.strategyVersionMatch,
    sideMatch: false,
    recordedDecision,
  };

  // 1) Lineage integrity (opaque hash equality; no recomputation).
  if (!lineage.lineageValid) {
    log("error", "signal replay aborted: lineage invalid", {
      signalId: signal.id,
      detail: lineage.detail,
    });
    return {
      ...base,
      replayResult: "ABORTED_LINEAGE",
      decisionMatch: false,
      confidenceMatch: false,
      recomputedDecision: null,
      detail: lineage.detail,
    };
  }

  // 2) DQ admission floor — a sub-90 report can never reproduce a decision.
  if (dqReport.status !== "PASSED" || dqReport.score < MIN_DATA_QUALITY_SCORE) {
    return {
      ...base,
      replayResult: "REFUSED_DQ",
      decisionMatch: false,
      confidenceMatch: false,
      recomputedDecision: "REFUSED",
      detail: `DQ score ${dqReport.score} (${dqReport.status}) < ${MIN_DATA_QUALITY_SCORE} — refused`,
    };
  }

  // 3) Reconstruct from PERSISTED artifacts only: the snapshot's feature values
  //    and the signal's own params snapshot (NOT the live strategy row — lineage
  //    above already proved the live row has not drifted from this snapshot).
  const params = resolveSignalParams(
    signal.strategyParams as unknown as Record<string, unknown>,
  );
  let result;
  try {
    result = decideSignal(featureSnapshot.features, params);
  } catch (err) {
    if (err instanceof SignalInputError) {
      return {
        ...base,
        replayResult: "ABORTED_FEATURE_VECTOR",
        decisionMatch: false,
        confidenceMatch: false,
        recomputedDecision: null,
        detail: err.message,
      };
    }
    throw err;
  }

  const recomputedDecision = result.decision;
  const recomputedConfidence = quantizeConfidence(result.confidence);
  const decisionMatch = recomputedDecision === recordedDecision;
  const confidenceMatch = recomputedConfidence === signal.confidence;
  // `side` (pre-filter trend bias) is persisted distinctly from `decision` and
  // must also reproduce — otherwise a tampered side passes as MATCH.
  const sideMatch = result.side === signal.side;
  const fullMatch = decisionMatch && confidenceMatch && sideMatch;

  return {
    ...base,
    replayResult: fullMatch ? "MATCH" : "DECISION_MISMATCH",
    decisionMatch,
    confidenceMatch,
    sideMatch,
    recomputedDecision,
    detail: fullMatch
      ? "decision + side + confidence reproduced from persisted artifacts"
      : `recomputed ${result.side}/${recomputedDecision}/${recomputedConfidence} != recorded ${signal.side}/${recordedDecision}/${signal.confidence}`,
  };
}
