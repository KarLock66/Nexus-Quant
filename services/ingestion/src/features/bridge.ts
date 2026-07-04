/**
 * DQ → Features → FeatureSnapshot bridge (Phase 9).
 *
 * Closes the gap that kept real signals from flowing: after a candle window
 * PASSES the DQ gateway, this computes the core-technical feature vector via the
 * quant service and persists exactly one point-in-time FeatureSnapshot. The
 * worker tick already reads "latest FeatureSnapshot per symbol by ts desc", so a
 * real snapshot (recent ts) supersedes the demo bootstrap with NO worker change.
 *
 * Persistence + hash discipline MIRROR services/workers/src/features/consumer.ts
 * exactly: same idempotent upsert key (exchange, symbol, timeframe, ts,
 * featureSetId); featureHash + features persisted VERBATIM (opaque pass-through,
 * never recomputed in TS). Kept in lockstep deliberately — a shared
 * @nexus/feature-store lib is the documented follow-up.
 */

import { Prisma } from "@nexus/db";
import type { PrismaClient } from "@nexus/db";
import { EXCHANGES, MIN_DATA_QUALITY_SCORE, TIMEFRAMES } from "@nexus/core";
import type { Exchange, Timeframe } from "@nexus/core";
import { EVENTS } from "@nexus/events";
import type { NormalizedCandle } from "../connectors/types.js";
import { log } from "../lib/log.js";
import { errMsg } from "../persistence/util.js";
import { computeFeatures } from "./client.js";
import type { FeatureComputeResult } from "./client.js";

/** Default Feature Store target (the only set the quant build serves today). */
export const DEFAULT_FEATURE_SET = "core-technical";
export const DEFAULT_FEATURE_VERSION = 1;

export class FeatureBridgeError extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = "FeatureBridgeError";
    this.code = code;
  }
}

export interface FeatureBridgeDeps {
  prisma: PrismaClient;
  quantBaseUrl: string;
  sharedSecret?: string;
  publish?: (name: string, payload: object) => Promise<void>;
}

export interface FeatureBridgeInput {
  scope: { exchange: Exchange; symbol: string; timeframe: Timeframe; ts?: Date };
  candles: NormalizedCandle[];
  dqReportId: string;
  dqScore: number;
  featureSet?: string;
  version?: number;
}

export interface PersistedFeatureSnapshot {
  id: string;
  featureHash: string;
  featureSetId: string;
  asOfTs: Date;
}

/**
 * Compute + persist one FeatureSnapshot from an admitted candle window.
 * Fail-closed: inadmissible DQ, an unknown scope, a contract mismatch, or an
 * unknown feature set each throw rather than silently degrade.
 */
export async function computeAndPersistFeatures(
  deps: FeatureBridgeDeps,
  input: FeatureBridgeInput,
): Promise<PersistedFeatureSnapshot> {
  const featureSet = input.featureSet ?? DEFAULT_FEATURE_SET;
  const version = input.version ?? DEFAULT_FEATURE_VERSION;

  // 1) Admission (defense-in-depth — the same floor the quant service enforces).
  if (input.dqScore < MIN_DATA_QUALITY_SCORE) {
    throw new FeatureBridgeError(
      `dq_score ${input.dqScore} < ${MIN_DATA_QUALITY_SCORE} — refusing to compute features (fail-closed)`,
      "DQ_BELOW_MINIMUM",
    );
  }
  if (!EXCHANGES.includes(input.scope.exchange)) {
    throw new FeatureBridgeError(`unknown exchange ${input.scope.exchange}`, "FEATURE_CONTRACT_MISMATCH");
  }
  if (!TIMEFRAMES.includes(input.scope.timeframe)) {
    throw new FeatureBridgeError(`unknown timeframe ${input.scope.timeframe}`, "FEATURE_CONTRACT_MISMATCH");
  }
  if (input.candles.length === 0) {
    throw new FeatureBridgeError("no candles to compute features from", "INSUFFICIENT_DATA");
  }

  // 2) Compute (HTTP). featureHash + features come back opaque/verbatim.
  const clientDeps: { quantBaseUrl: string; sharedSecret?: string } = {
    quantBaseUrl: deps.quantBaseUrl,
  };
  if (deps.sharedSecret !== undefined) clientDeps.sharedSecret = deps.sharedSecret;

  const result: FeatureComputeResult = await computeFeatures(clientDeps, {
    dqReportId: input.dqReportId,
    dqScore: input.dqScore,
    scope: {
      exchange: input.scope.exchange,
      symbol: input.scope.symbol,
      timeframe: input.scope.timeframe,
      ...(input.scope.ts !== undefined ? { ts: input.scope.ts } : {}),
    },
    featureSet,
    version,
    marketData: {
      candles: input.candles.map((c) => ({
        ts: c.ts.toISOString(),
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        volume: c.volume,
      })),
    },
  });

  // Defense-in-depth: refuse to persist a vector the caller did not ask for.
  if (result.featureSet !== featureSet || result.version !== version) {
    throw new FeatureBridgeError(
      `requested ${featureSet} v${version}, got ${result.featureSet} v${result.version}`,
      "FEATURE_CONTRACT_MISMATCH",
    );
  }

  // 3) Resolve the catalog id (FeatureSnapshot.featureSetId is a required FK).
  const def = await deps.prisma.featureSetDefinition.findUnique({
    where: { name_version: { name: result.featureSet, version: result.version } },
  });
  if (def === null) {
    throw new FeatureBridgeError(
      `no FeatureSetDefinition for ${result.featureSet} v${result.version} (fail-closed)`,
      "UNKNOWN_FEATURE_SET",
    );
  }

  // 4) Persist exactly one FeatureSnapshot (idempotent on the point-in-time key).
  //    featureHash + features written VERBATIM (opaque pass-through).
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
    inputCandleCount: result.inputCandleCount,
  });

  if (deps.publish) {
    await deps.publish(EVENTS.FEATURE_SNAPSHOT_CREATED, {
      snapshotId: snapshot.id,
      symbol: input.scope.symbol,
      timeframe: input.scope.timeframe,
      featureHash: result.featureHash,
    });
  }

  return { id: snapshot.id, featureHash: result.featureHash, featureSetId: def.id, asOfTs };
}
