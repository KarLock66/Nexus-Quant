/**
 * Replay verification fixtures (STEP 12).
 *
 * The feature vector + featureHash are the REAL output of services/quant
 * compute_core_technical (see ../__fixtures__/core-technical-authentic.json) —
 * an authentic, decisive bull snapshot (ema_20 > ema_50 > ema_200, rsi_14=100),
 * so the frozen v1 rule reconstructs STRONG_BUY. Tampered scenarios mutate a
 * copy of this authentic quintuple; nothing here invents a featureHash.
 *
 * datasetHash is a persisted lineage token compared by opaque equality (replay
 * never recomputes it), so a fixed hex value is faithful to the contract.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type {
  ReplayDataQualityReport,
  ReplayFeatureSnapshot,
  ReplayInput,
  ReplaySignal,
  ReplayStrategyVersion,
} from "./types.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const authentic = JSON.parse(
  readFileSync(join(HERE, "../__fixtures__/core-technical-authentic.json"), "utf8"),
) as { featureHash: string; features: Record<string, number> };

export const AUTH_FEATURE_HASH = authentic.featureHash;
export const AUTH_FEATURES = authentic.features;
export const AUTH_DATASET_HASH =
  "a1b2c3d4e5f60718293a4b5c6d7e8f90112233445566778899aabbccddeeff00";

/** The decision the frozen v1 rule reconstructs from the authentic vector. */
export const EXPECTED_STATE = "STRONG_BUY" as const;

const FS_ID = "fs_authentic_1";
const DQ_ID = "dq_authentic_1";
const SV_ID = "sv_core_technical_1";

function dqReport(over: Partial<ReplayDataQualityReport> = {}): ReplayDataQualityReport {
  return { id: DQ_ID, score: 100, status: "PASSED", datasetHash: AUTH_DATASET_HASH, ...over };
}

function featureSnapshot(
  over: Partial<ReplayFeatureSnapshot> = {},
): ReplayFeatureSnapshot {
  return {
    id: FS_ID,
    featureHash: AUTH_FEATURE_HASH,
    features: { ...AUTH_FEATURES },
    ...over,
  };
}

function signal(over: Partial<ReplaySignal> = {}): ReplaySignal {
  return {
    id: "sig_authentic_1",
    state: EXPECTED_STATE,
    featureHash: AUTH_FEATURE_HASH,
    datasetHash: AUTH_DATASET_HASH,
    featureSnapshotId: FS_ID,
    dqReportId: DQ_ID,
    strategyVersionId: SV_ID,
    ...over,
  };
}

function strategyVersion(
  over: Partial<ReplayStrategyVersion> = {},
): ReplayStrategyVersion {
  return { id: SV_ID, parameters: {}, ...over };
}

/** Flip one hex nibble so the value stays a valid 64-hex but is not equal. */
function tamperHex(h: string): string {
  const first = h[0] === "0" ? "1" : "0";
  return first + h.slice(1);
}

/** Scenario A — clean data: full reproduction. */
export function scenarioCleanData(): ReplayInput {
  return {
    dqReport: dqReport(),
    featureSnapshot: featureSnapshot(),
    signal: signal(),
    strategyVersion: strategyVersion(),
  };
}

/** Scenario B — Stage-B deductions that keep score >= 90 (still PASSED). */
export function scenarioStageBDeductions(): ReplayInput {
  return {
    dqReport: dqReport({ score: 92, status: "PASSED" }),
    featureSnapshot: featureSnapshot(),
    signal: signal(),
    strategyVersion: strategyVersion(),
  };
}

/** Scenario C — failed DQ (score < 90): decision must be refused. */
export function scenarioFailedDq(): ReplayInput {
  return {
    dqReport: dqReport({ score: 80, status: "FAILED" }),
    featureSnapshot: featureSnapshot(),
    signal: signal(),
    strategyVersion: strategyVersion(),
  };
}

/** Scenario D — tampered featureHash on the signal: replay aborts. */
export function scenarioTamperedFeatureHash(): ReplayInput {
  return {
    dqReport: dqReport(),
    featureSnapshot: featureSnapshot(),
    signal: signal({ featureHash: tamperHex(AUTH_FEATURE_HASH) }),
    strategyVersion: strategyVersion(),
  };
}

/** Scenario E — tampered datasetHash on the signal: replay aborts. */
export function scenarioTamperedDatasetHash(): ReplayInput {
  return {
    dqReport: dqReport(),
    featureSnapshot: featureSnapshot(),
    signal: signal({ datasetHash: tamperHex(AUTH_DATASET_HASH) }),
    strategyVersion: strategyVersion(),
  };
}

/** Scenario F — corrupt persisted feature vector (missing key): replay aborts. */
export function scenarioCorruptFeatureVector(): ReplayInput {
  const snap = featureSnapshot();
  const broken: Record<string, number> = { ...snap.features };
  delete broken["ema_20"];
  return {
    dqReport: dqReport(),
    featureSnapshot: { ...snap, features: broken },
    signal: signal(),
    strategyVersion: strategyVersion(),
  };
}
