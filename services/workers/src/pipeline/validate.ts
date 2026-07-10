/**
 * Phase 11C Stage 1 — runtime safety validation for the pipeline tick.
 *
 * Two admission layers, both STRUCTURAL only (no trading rule, feature
 * semantics, or decision-path change — well-formed data passes untouched):
 *
 *  1. Persisted-input validation (fail-fast): the resolved StrategyVersion row
 *     and every candidate FeatureSnapshot row must be structurally sound
 *     BEFORE the tick fingerprints its input. A malformed row throws
 *     PipelineDataError — the tick refuses to run on corrupt upstream data
 *     rather than crash with an untyped TypeError mid-tick or silently skip
 *     rows out of the inputHash.
 *
 *  2. Generated-signal validation (fail-closed): the engine's output must
 *     satisfy the EngineSignal contract — decision enums, quantized-confidence
 *     format, and verbatim lineage — BEFORE it is verified/published. A
 *     violation rejects that signal (nothing downstream ever sees it).
 */

import { SIGNAL_DECISIONS } from "@nexus/core";
import type {
  GeneratedSignal,
  SignalDataQualityReport,
  SignalFeatureSnapshot,
  SignalStrategyVersion,
} from "../signal/types.js";
import { PipelineDataError } from "./errors.js";

/** JSON columns must be plain objects here — never arrays, scalars, or null. */
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

/** The exact quantized-confidence wire format (decision.ts quantizeConfidence). */
const CONFIDENCE_RE = /^[01]\.\d{4}$/;

const DECISION_SET: ReadonlySet<string> = new Set(SIGNAL_DECISIONS);

/**
 * Structural validation of the resolved ACTIVE StrategyVersion row. THROWS
 * (fail-fast) — strategy parameters that are not a JSON object would otherwise
 * silently resolve to the built-in defaults, masking a corrupt governance row.
 */
export function assertValidStrategyVersionRow(row: {
  id: unknown;
  parameters: unknown;
}): void {
  if (!isNonEmptyString(row.id)) {
    throw new PipelineDataError(
      "resolved StrategyVersion has no id (malformed row — fail-fast, nothing fabricated)",
      "MALFORMED_STRATEGY_VERSION",
    );
  }
  if (!isPlainObject(row.parameters)) {
    throw new PipelineDataError(
      `StrategyVersion ${row.id}: parameters is not a JSON object (malformed row — fail-fast, nothing fabricated)`,
      "MALFORMED_STRATEGY_VERSION",
    );
  }
}

/** The persisted FeatureSnapshot (+ DQ report) projection the tick consumes. */
export interface CandidateSnapshotRow {
  id: unknown;
  symbol: unknown;
  ts: unknown;
  featureHash: unknown;
  features: unknown;
  dqReport: {
    id: unknown;
    score: unknown;
    status: unknown;
    datasetHash: unknown;
  } | null;
}

/**
 * Structural validation of one candidate FeatureSnapshot row. THROWS
 * (fail-fast) on the first malformed row: skipping it would silently exclude
 * a symbol from the inputHash, and proceeding would crash untyped downstream.
 */
export function assertValidSnapshotRow(row: CandidateSnapshotRow): void {
  const reject = (detail: string): never => {
    const ref = isNonEmptyString(row.id) ? row.id : "<no id>";
    throw new PipelineDataError(
      `FeatureSnapshot ${ref}: ${detail} (malformed row — fail-fast, nothing fabricated)`,
      "MALFORMED_FEATURE_SNAPSHOT",
    );
  };
  if (!isNonEmptyString(row.id)) reject("id missing or empty");
  if (!isNonEmptyString(row.symbol)) reject("symbol missing or empty");
  if (!(row.ts instanceof Date) || Number.isNaN(row.ts.getTime())) {
    reject("ts is not a valid timestamp");
  }
  if (!isNonEmptyString(row.featureHash)) reject("featureHash missing or empty");
  if (!isPlainObject(row.features)) reject("features is not a JSON object");
  const dq = row.dqReport;
  if (dq === null) reject("dqReport relation missing");
  if (dq !== null) {
    if (!isNonEmptyString(dq.id)) reject("dqReport.id missing or empty");
    if (typeof dq.score !== "number" || !Number.isFinite(dq.score)) {
      reject("dqReport.score is not a finite number");
    }
    if (dq.status !== "PASSED" && dq.status !== "FAILED") {
      reject(`dqReport.status "${String(dq.status)}" is not PASSED|FAILED`);
    }
    if (!isNonEmptyString(dq.datasetHash)) reject("dqReport.datasetHash missing or empty");
  }
}

/**
 * Contract check over the engine's GENERATED output, run BEFORE lineage
 * verification / publication. Returns a reason string when malformed (the
 * caller rejects the signal fail-closed and never publishes it), null when
 * the signal is well-formed. Defense-in-depth: the engine already builds
 * these fields verbatim, so on a healthy engine this can never fire.
 */
export function malformedSignalReason(
  signal: GeneratedSignal,
  ctx: {
    featureSnapshot: SignalFeatureSnapshot;
    dqReport: SignalDataQualityReport;
    strategyVersion: SignalStrategyVersion;
  },
): string | null {
  if (!DECISION_SET.has(signal.side)) return `side "${signal.side}" not in ${[...DECISION_SET].join("|")}`;
  if (!DECISION_SET.has(signal.decision)) {
    return `decision "${signal.decision}" not in ${[...DECISION_SET].join("|")}`;
  }
  if (!CONFIDENCE_RE.test(signal.confidence)) {
    return `confidence "${signal.confidence}" is not the quantized 4-decimal format`;
  }
  const c = Number(signal.confidence);
  if (!(c >= 0 && c <= 1)) return `confidence ${signal.confidence} outside [0, 1]`;
  if (signal.symbol !== ctx.featureSnapshot.symbol) {
    return `symbol "${signal.symbol}" != snapshot symbol "${ctx.featureSnapshot.symbol}"`;
  }
  if (signal.featureSnapshotId !== ctx.featureSnapshot.id) {
    return `featureSnapshotId "${signal.featureSnapshotId}" != snapshot id "${ctx.featureSnapshot.id}"`;
  }
  if (signal.dqReportId !== ctx.dqReport.id) {
    return `dqReportId "${signal.dqReportId}" != DQ report id "${ctx.dqReport.id}"`;
  }
  if (signal.strategyVersionId !== ctx.strategyVersion.id) {
    return `strategyVersionId "${signal.strategyVersionId}" != resolved version "${ctx.strategyVersion.id}"`;
  }
  if (signal.featureHash !== ctx.featureSnapshot.featureHash) {
    return "featureHash not carried verbatim from the feature snapshot";
  }
  if (signal.datasetHash !== ctx.dqReport.datasetHash) {
    return "datasetHash not carried verbatim from the DQ report";
  }
  return null;
}
