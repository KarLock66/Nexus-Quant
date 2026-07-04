/**
 * Signal Lineage Contract (STEP 17).
 *
 * Proves the chain
 *   Signal -> FeatureSnapshot -> FeatureHash -> DQ Report -> DatasetHash
 *          -> StrategyVersion (id + decision parameters)
 * from PERSISTED artifacts alone. Hash checks are opaque string equality —
 * featureHash is never recomputed (Python authority), datasetHash is never
 * recomputed here (TS authority lives in ingestion). Fail-closed: lineageValid
 * is true ONLY when every link, every verbatim hash copy, the symbol binding,
 * AND the strategy parameters in force all agree.
 *
 * `strategyVersionMatch` is strengthened beyond an id check: the live
 * StrategyVersion.parameters must still resolve to the params snapshotted on the
 * signal — so post-generation strategy drift fails closed (it is not mistaken
 * for feature/data corruption). `symbol` is re-bound to the FeatureSnapshot
 * (its source of truth) so a mislabeled signal cannot verify as intact.
 */

import { resolveSignalParams } from "./decision.js";
import type {
  LineageVerification,
  PersistedSignal,
  SignalDataQualityReport,
  SignalFeatureSnapshot,
  SignalStrategyVersion,
} from "./types.js";

export function verifySignalLineage(input: {
  signal: PersistedSignal;
  featureSnapshot: SignalFeatureSnapshot;
  dqReport: SignalDataQualityReport;
  strategyVersion: SignalStrategyVersion;
}): LineageVerification {
  const { signal, featureSnapshot, dqReport, strategyVersion } = input;

  // Referential links: the supplied artifacts must be the ones the signal cites.
  const featureSnapshotLink = signal.featureSnapshotId === featureSnapshot.id;
  const dqReportLink = signal.dqReportId === dqReport.id;

  // Verbatim hash agreement against the source-of-truth rows.
  const featureHashMatch =
    featureSnapshotLink && signal.featureHash === featureSnapshot.featureHash;
  const datasetHashMatch =
    dqReportLink && signal.datasetHash === dqReport.datasetHash;

  // Symbol is re-bound to its source of truth (the FeatureSnapshot), so a
  // mislabeled signal (right lineage ids, wrong instrument) fails closed.
  const symbolMatch = featureSnapshotLink && signal.symbol === featureSnapshot.symbol;

  // StrategyVersion: id must match AND the live parameters must still resolve to
  // the params snapshotted on the signal (post-generation drift fails closed).
  const idMatch = signal.strategyVersionId === strategyVersion.id;
  const live = resolveSignalParams(strategyVersion.parameters);
  const snap = signal.strategyParams;
  const paramsMatch =
    live.rsiLongMin === snap.rsiLongMin &&
    live.rsiShortMax === snap.rsiShortMax &&
    live.maxRealizedVol === snap.maxRealizedVol;
  const strategyVersionMatch = idMatch && paramsMatch;

  const lineageValid =
    featureSnapshotLink &&
    dqReportLink &&
    featureHashMatch &&
    datasetHashMatch &&
    symbolMatch &&
    strategyVersionMatch;

  const problems: string[] = [];
  if (!featureSnapshotLink) problems.push("featureSnapshotId does not reference the snapshot");
  if (!dqReportLink) problems.push("dqReportId does not reference the DQ report");
  if (!featureHashMatch) problems.push("featureHash mismatch vs snapshot");
  if (!datasetHashMatch) problems.push("datasetHash mismatch vs DQ report");
  if (!symbolMatch) problems.push("symbol mismatch vs snapshot");
  if (!idMatch) problems.push("strategyVersionId mismatch");
  else if (!paramsMatch) problems.push("strategy parameter drift vs persisted snapshot");

  return {
    lineageValid,
    datasetHashMatch,
    featureHashMatch,
    strategyVersionMatch,
    detail: lineageValid ? "lineage intact" : problems.join("; "),
  };
}
