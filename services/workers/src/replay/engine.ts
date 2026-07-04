/**
 * Replay Engine v1 (STEP 11).
 *
 * Reconstructs a signal's decision from persisted artifacts and verifies its
 * reproducibility lineage. Fail-closed ordering:
 *   1. lineage   — the four artifacts must reference each other (no substitution)
 *   2. featureHash — signal.featureHash must equal snapshot.featureHash (opaque)
 *   3. datasetHash — signal.datasetHash must equal dqReport.datasetHash (opaque)
 *   4. DQ floor   — a sub-90 report yields a REFUSED decision (no signal)
 *   5. decision   — recompute from persisted feature VALUES and compare
 *
 * Invariants: replay NEVER calls /features/compute and NEVER recomputes
 * featureHash — hash checks are opaque string equality. On any integrity
 * failure the engine aborts before producing a decision.
 */

import { MIN_DATA_QUALITY_SCORE } from "@nexus/core";
import type { ReplayInput, ReplayOutput } from "./types.js";
import {
  evaluateCoreTechnical,
  resolveParams,
  StrategyInputError,
} from "./strategy.js";
import { log } from "../lib/log.js";

export function replaySignal(input: ReplayInput): ReplayOutput {
  const { dqReport, featureSnapshot, signal, strategyVersion } = input;

  const featureHashMatch = signal.featureHash === featureSnapshot.featureHash;
  const datasetHashMatch = signal.datasetHash === dqReport.datasetHash;
  const recordedDecision = signal.state;

  const abort = (
    replayResult: ReplayOutput["replayResult"],
    detail: string,
  ): ReplayOutput => {
    log("error", "replay aborted (fail-closed)", {
      signalId: signal.id,
      replayResult,
      featureHashMatch,
      datasetHashMatch,
      detail,
    });
    return {
      replayResult,
      decisionMatch: false,
      featureHashMatch,
      datasetHashMatch,
      recomputedDecision: null,
      recordedDecision,
      detail,
    };
  };

  // 1) Lineage — the supplied artifacts must form one consistent quintuple.
  if (signal.featureSnapshotId !== featureSnapshot.id) {
    return abort(
      "ABORTED_LINEAGE",
      `signal.featureSnapshotId ${signal.featureSnapshotId} != snapshot.id ${featureSnapshot.id}`,
    );
  }
  if (signal.dqReportId !== dqReport.id) {
    return abort(
      "ABORTED_LINEAGE",
      `signal.dqReportId ${signal.dqReportId} != dqReport.id ${dqReport.id}`,
    );
  }
  if (signal.strategyVersionId !== strategyVersion.id) {
    return abort(
      "ABORTED_LINEAGE",
      `signal.strategyVersionId ${signal.strategyVersionId} != strategyVersion.id ${strategyVersion.id}`,
    );
  }

  // 2) featureHash integrity (opaque equality; no recomputation).
  if (!featureHashMatch) {
    return abort(
      "ABORTED_FEATURE_HASH",
      "featureHash mismatch between signal and feature snapshot",
    );
  }

  // 3) datasetHash integrity (opaque equality).
  if (!datasetHashMatch) {
    return abort(
      "ABORTED_DATASET_HASH",
      "datasetHash mismatch between signal and DQ report",
    );
  }

  // 4) DQ admission floor — a sub-90 report can never reproduce a decision.
  if (dqReport.status !== "PASSED" || dqReport.score < MIN_DATA_QUALITY_SCORE) {
    log("warn", "replay refused: DQ below admission floor", {
      signalId: signal.id,
      dqScore: dqReport.score,
      dqStatus: dqReport.status,
    });
    return {
      replayResult: "REFUSED_DQ",
      decisionMatch: false,
      featureHashMatch,
      datasetHashMatch,
      recomputedDecision: "REFUSED",
      recordedDecision,
      detail: `DQ score ${dqReport.score} (${dqReport.status}) < ${MIN_DATA_QUALITY_SCORE} — decision refused`,
    };
  }

  // 5) Recompute the decision from PERSISTED feature values and compare.
  //    A corrupt/incomplete vector fails closed to a clean aborted result
  //    rather than throwing (persistence-corruption defense).
  const params = resolveParams(strategyVersion.parameters);
  let recomputedDecision;
  try {
    recomputedDecision = evaluateCoreTechnical(featureSnapshot.features, params);
  } catch (err) {
    if (err instanceof StrategyInputError) {
      return abort("ABORTED_FEATURE_VECTOR", err.message);
    }
    throw err;
  }
  const decisionMatch = recomputedDecision === recordedDecision;

  return {
    replayResult: decisionMatch ? "MATCH" : "DECISION_MISMATCH",
    decisionMatch,
    featureHashMatch,
    datasetHashMatch,
    recomputedDecision,
    recordedDecision,
    detail: decisionMatch
      ? "decision reproduced from persisted features"
      : `recomputed ${recomputedDecision} != recorded ${recordedDecision}`,
  };
}
