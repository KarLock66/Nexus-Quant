/**
 * Signal verification fixtures (STEP 18 / 20).
 *
 * Feature vectors + featureHashes are REAL services/quant compute_core_technical
 * output (see ../__fixtures__/decision-vectors.json):
 *   clean   neutral (flat)        -> decision FLAT
 *   bull    strict uptrend        -> decision LONG
 *   bear    strict downtrend      -> decision SHORT
 *   highvol uptrend + high vol    -> side LONG, decision FLAT (vol filter)
 * Tampered scenarios mutate a copy of an authentic, lineage-consistent record;
 * nothing here invents a featureHash. datasetHash is a persisted lineage token
 * compared by opaque equality, so a fixed hex value is faithful to the contract.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type {
  PersistedSignal,
  SignalDataQualityReport,
  SignalEngineInput,
  SignalFeatureSnapshot,
  SignalStrategyVersion,
} from "./types.js";
import { generateSignal } from "./engine.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const vectors = JSON.parse(
  readFileSync(join(HERE, "../__fixtures__/decision-vectors.json"), "utf8"),
) as Record<string, { featureHash: string; features: Record<string, number> }>;

export type VectorName = "clean" | "bull" | "bear" | "highvol";

export const DATASET_HASH =
  "a1b2c3d4e5f60718293a4b5c6d7e8f90112233445566778899aabbccddeeff00";

const SYMBOL = "BTC-USDT";
const SV_ID = "sv_core_technical_1";

function snapshotId(name: VectorName): string {
  return `fs_${name}_1`;
}

export function featureSnapshot(name: VectorName): SignalFeatureSnapshot {
  const v = vectors[name];
  if (!v) throw new Error(`unknown vector ${name}`);
  return {
    id: snapshotId(name),
    symbol: SYMBOL,
    featureHash: v.featureHash,
    features: { ...v.features },
  };
}

export function dqReport(
  over: Partial<SignalDataQualityReport> = {},
): SignalDataQualityReport {
  return { id: "dq_1", score: 100, status: "PASSED", datasetHash: DATASET_HASH, ...over };
}

export function strategyVersion(
  over: Partial<SignalStrategyVersion> = {},
): SignalStrategyVersion {
  return { id: SV_ID, parameters: {}, ...over };
}

export function engineInput(
  name: VectorName,
  over: { dqReport?: Partial<SignalDataQualityReport> } = {},
): SignalEngineInput {
  return {
    featureSnapshot: featureSnapshot(name),
    dqReport: dqReport(over.dqReport),
    strategyVersion: strategyVersion(),
  };
}

/** A persisted signal generated for `name` (consistent lineage by construction). */
export function persistedSignal(
  name: VectorName,
  over: Partial<PersistedSignal> = {},
): PersistedSignal {
  const gen = generateSignal(engineInput(name));
  if (gen.status !== "GENERATED") {
    throw new Error(`fixture ${name} unexpectedly refused`);
  }
  return { id: `sig_${name}_1`, ...gen.signal, ...over };
}

/** Flip one hex nibble so the value stays a valid 64-hex but is not equal. */
export function tamperHex(h: string): string {
  const first = h[0] === "0" ? "1" : "0";
  return first + h.slice(1);
}
