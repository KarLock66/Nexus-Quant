/**
 * Production Feature Store consumer (STEP 10).
 *
 * Flow: admit (DQ >= 90, defense-in-depth) -> POST /features/compute -> resolve
 * the FeatureSetDefinition id -> persist exactly one FeatureSnapshot (idempotent
 * upsert on its unique key) -> publish feature.snapshot.created.
 *
 * Persistence contract (what is written, per the Phase 2 spec):
 *   feature_set, version (via featureSetId), as_of_ts (ts), featureHash,
 *   features, dq_report_id.
 *
 * Hash discipline: `featureHash` and `features` are persisted VERBATIM — the
 * exact string and the exact decoded object returned by the quant service.
 * The worker never recomputes the hash, never normalizes it, and never
 * reserializes the feature vector before persistence. (Prisma serializes the
 * JSON column on write; the worker hands it the untouched object.)
 */

import { Prisma } from "@nexus/db";
import type { PrismaClient } from "@nexus/db";
import { EXCHANGES, MIN_DATA_QUALITY_SCORE, TIMEFRAMES } from "@nexus/core";
import { EVENTS } from "@nexus/events";
import { computeFeatures } from "./client.js";
import type {
  FeatureComputeInput,
  FeatureComputeResult,
  PersistedFeatureSnapshot,
} from "./types.js";
import { errMsg, log } from "../lib/log.js";

/** Raised when the worker refuses to compute features from inadmissible data. */
export class FeatureAdmissionError extends Error {
  readonly code = "DQ_BELOW_MINIMUM";
  constructor(score: number) {
    super(
      `dq_score ${score} < ${MIN_DATA_QUALITY_SCORE} — refusing to compute ` +
        `features from inadmissible data (fail-closed)`,
    );
    this.name = "FeatureAdmissionError";
  }
}

/** Raised when the feature set/version is not defined in the catalog. */
export class UnknownFeatureSetError extends Error {
  readonly code = "UNKNOWN_FEATURE_SET";
  constructor(name: string, version: number) {
    super(`no FeatureSetDefinition for ${name} v${version} (fail-closed)`);
    this.name = "UnknownFeatureSetError";
  }
}

/** Raised when the service echoes a different set/version than requested. */
export class FeatureContractMismatchError extends Error {
  readonly code = "FEATURE_CONTRACT_MISMATCH";
  constructor(detail: string) {
    super(`feature compute response contract mismatch: ${detail} (fail-closed)`);
    this.name = "FeatureContractMismatchError";
  }
}

export interface FeatureConsumerDeps {
  prisma: PrismaClient;
  quantBaseUrl: string;
  sharedSecret?: string;
  publish?: (name: string, payload: object) => Promise<void>;
}

export async function consumeFeatureComputation(
  deps: FeatureConsumerDeps,
  input: FeatureComputeInput,
): Promise<PersistedFeatureSnapshot> {
  // 1) Admission (defense-in-depth — the same floor the quant service enforces).
  if (input.dqScore < MIN_DATA_QUALITY_SCORE) {
    throw new FeatureAdmissionError(input.dqScore);
  }
  // Fail-closed scope validation before any network call.
  if (!EXCHANGES.includes(input.scope.exchange)) {
    throw new FeatureContractMismatchError(`unknown exchange ${input.scope.exchange}`);
  }
  if (!TIMEFRAMES.includes(input.scope.timeframe)) {
    throw new FeatureContractMismatchError(`unknown timeframe ${input.scope.timeframe}`);
  }

  // 2) Compute (HTTP). featureHash + features come back opaque/verbatim.
  const clientDeps: { quantBaseUrl: string; sharedSecret?: string } = {
    quantBaseUrl: deps.quantBaseUrl,
  };
  if (deps.sharedSecret !== undefined) clientDeps.sharedSecret = deps.sharedSecret;
  const result: FeatureComputeResult = await computeFeatures(clientDeps, input);

  // Defense-in-depth: refuse to persist a vector the caller did not ask for.
  if (result.featureSet !== input.featureSet || result.version !== input.version) {
    throw new FeatureContractMismatchError(
      `requested ${input.featureSet} v${input.version}, got ${result.featureSet} v${result.version}`,
    );
  }

  // 3) Resolve the catalog id (FeatureSnapshot.featureSetId is a required FK).
  const def = await deps.prisma.featureSetDefinition.findUnique({
    where: { name_version: { name: result.featureSet, version: result.version } },
  });
  if (def === null) {
    throw new UnknownFeatureSetError(result.featureSet, result.version);
  }

  // 4) Persist exactly one FeatureSnapshot. Idempotent on the unique key so a
  //    replayed compute never duplicates a point-in-time row. featureHash and
  //    features are written verbatim (opaque pass-through).
  const asOfTs = new Date(result.asOfTs);
  const featuresJson = result.features as unknown as Prisma.InputJsonValue;

  let snapshot: { id: string };
  try {
    snapshot = await deps.prisma.featureSnapshot.upsert({
      where: {
        exchange_symbol_timeframe_ts_featureSetId: {
          exchange: input.scope.exchange,
          symbol: input.scope.symbol,
          timeframe: input.scope.timeframe,
          ts: asOfTs,
          featureSetId: def.id,
        },
      },
      create: {
        exchange: input.scope.exchange,
        symbol: input.scope.symbol,
        timeframe: input.scope.timeframe,
        ts: asOfTs,
        features: featuresJson,
        featureHash: result.featureHash,
        featureSetId: def.id,
        dqReportId: input.dqReportId,
      },
      update: {
        features: featuresJson,
        featureHash: result.featureHash,
        dqReportId: input.dqReportId,
      },
      select: { id: true },
    });
  } catch (err) {
    log("error", "failed to persist feature snapshot", {
      exchange: input.scope.exchange,
      symbol: input.scope.symbol,
      timeframe: input.scope.timeframe,
      featureSet: result.featureSet,
      error: errMsg(err),
    });
    throw err;
  }

  log("info", "feature snapshot persisted", {
    snapshotId: snapshot.id,
    exchange: input.scope.exchange,
    symbol: input.scope.symbol,
    timeframe: input.scope.timeframe,
    asOfTs: asOfTs.toISOString(),
    featureSet: result.featureSet,
    version: result.version,
    featureHash: result.featureHash,
    dqReportId: input.dqReportId,
  });

  if (deps.publish) {
    await deps.publish(EVENTS.FEATURE_SNAPSHOT_CREATED, {
      snapshotId: snapshot.id,
      symbol: input.scope.symbol,
      timeframe: input.scope.timeframe,
      featureHash: result.featureHash,
    });
  }

  return {
    id: snapshot.id,
    featureHash: result.featureHash,
    featureSetId: def.id,
    asOfTs,
  };
}
