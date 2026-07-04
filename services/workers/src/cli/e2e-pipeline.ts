/**
 * End-to-end runtime pipeline orchestrator (Phase 3 runtime seal).
 *
 *   pnpm --filter @nexus/workers e2e:pipeline
 *
 * Executes the full chain against REAL service boundaries — a live Postgres
 * (Prisma), live Redis (event publish), and the live Python quant service over
 * HTTP — with NO mocks and NO in-memory shortcuts:
 *
 *   Market Data -> DQ        : read the candles + DataQualityReport that the
 *                              live ingestion daemon persisted for the
 *                              configured scope.
 *   Feature                  : POST /features/compute (Python authority for the
 *                              feature vector + featureHash) and persist exactly
 *                              one FeatureSnapshot via the production consumer.
 *   Signal                   : run the deterministic Signal Engine over the
 *                              PERSISTED snapshot + DQ report + StrategyVersion
 *                              and persist exactly one EngineSignal.
 *   Replay                   : reload every artifact FROM THE DATABASE and prove
 *                              Replay(signal) == original (decision + side +
 *                              confidence + lineage), recomputing nothing that
 *                              must be verbatim (featureHash is never recomputed
 *                              in TypeScript; datasetHash is compared opaquely).
 *
 * Deterministic outcome: exit 0 only when the signal is GENERATED and replay is
 * a full MATCH; any refusal, mismatch, or integrity failure exits 1 with a
 * machine-readable reason. Reproducibility invariants are upheld exactly as in
 * the unit suites — this run executes them across real process/DB/HTTP borders.
 *
 * Env (see .env.example): DATABASE_URL, REDIS_URL, QUANT_SERVICE_URL,
 * QUANT_SERVICE_SHARED_SECRET, plus optional E2E_EXCHANGE / E2E_SYMBOL /
 * E2E_TIMEFRAME / E2E_FEATURE_SET overrides.
 */

import { randomUUID } from "node:crypto";
import { Redis } from "ioredis";
import { prisma } from "@nexus/db";
import type { Exchange, Timeframe } from "@nexus/core";
import { EXCHANGES, TIMEFRAMES } from "@nexus/core";
import { consumeFeatureComputation } from "../features/index.js";
import type { FeatureComputeInput } from "../features/index.js";
import {
  quantizeConfidence,
  replayEngineSignal,
  runSignalEngine,
} from "../signal/index.js";
import type {
  PersistedSignal,
  SignalDataQualityReport,
  SignalFeatureSnapshot,
  SignalParams,
  SignalStrategyVersion,
} from "../signal/index.js";

// core-technical v1 needs >= 201 candles (see services/quant/app/features/
// core_technical.py MIN_CANDLES). Asserted locally for a clear failure message.
const MIN_CANDLES = 201;

const STRATEGY_NAME = "e2e-core-technical";
const FEATURE_SET = process.env["E2E_FEATURE_SET"] ?? "core-technical";
const FEATURE_VERSION = 1;

// The Signal Engine's frozen v1 decision parameters (decision.ts
// DEFAULT_SIGNAL_PARAMS). Persisted on the StrategyVersion so generation and
// replay resolve identical params from the persisted snapshot alone.
const STRATEGY_PARAMS: SignalParams = {
  rsiLongMin: 55,
  rsiShortMax: 45,
  maxRealizedVol: 0.02,
};

function log(
  level: "info" | "warn" | "error",
  msg: string,
  extra?: Record<string, unknown>,
): void {
  console.log(
    JSON.stringify({
      ts: new Date().toISOString(),
      service: "workers",
      component: "e2e-pipeline",
      level,
      msg,
      ...extra,
    }),
  );
}

/** Fatal pipeline failure with a stable, machine-readable stage + reason. */
class PipelineError extends Error {
  readonly stage: string;
  constructor(stage: string, message: string) {
    super(message);
    this.name = "PipelineError";
    this.stage = stage;
  }
}

interface Env {
  exchange: Exchange;
  symbol: string;
  timeframe: Timeframe;
  redisUrl: string | null;
  quantBaseUrl: string;
  sharedSecret: string;
}

function readEnv(): Env {
  const exchange = (process.env["E2E_EXCHANGE"] ?? "DERIBIT") as Exchange;
  if (!EXCHANGES.includes(exchange)) {
    throw new PipelineError("config", `invalid E2E_EXCHANGE: ${exchange}`);
  }
  const timeframe = (process.env["E2E_TIMEFRAME"] ?? "H1") as Timeframe;
  if (!TIMEFRAMES.includes(timeframe)) {
    throw new PipelineError("config", `invalid E2E_TIMEFRAME: ${timeframe}`);
  }
  return {
    exchange,
    symbol: process.env["E2E_SYMBOL"] ?? "BTC-USDT",
    timeframe,
    redisUrl: process.env["REDIS_URL"] ?? null,
    quantBaseUrl: process.env["QUANT_SERVICE_URL"] ?? "http://localhost:8000",
    sharedSecret: process.env["QUANT_SERVICE_SHARED_SECRET"] ?? "",
  };
}

/** Minimal soft-failing Redis publisher (mirrors ingestion lib/events.ts). */
function createPublisher(redisUrl: string | null): {
  publish: (name: string, payload: object) => Promise<void>;
  close: () => Promise<void>;
} {
  if (redisUrl === null || redisUrl === "") {
    return { publish: async () => undefined, close: async () => undefined };
  }
  let warned = false;
  const client = new Redis(redisUrl, {
    lazyConnect: true,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    retryStrategy: () => 5_000,
  });
  client.on("error", (err: Error) => {
    if (warned) return;
    warned = true;
    log("warn", "redis publish degraded to no-op", { error: err.message });
  });
  return {
    async publish(name: string, payload: object): Promise<void> {
      try {
        await client.publish(
          name,
          JSON.stringify({
            name,
            payload,
            publishedAt: new Date().toISOString(),
            correlationId: randomUUID(),
          }),
        );
      } catch (err) {
        if (warned) return;
        warned = true;
        log("warn", "redis publish failed", {
          event: name,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
    async close(): Promise<void> {
      try {
        await client.quit();
      } catch {
        try {
          client.disconnect();
        } catch {
          // already closed
        }
      }
    },
  };
}

async function main(): Promise<void> {
  const env = readEnv();
  const scope = { exchange: env.exchange, symbol: env.symbol, timeframe: env.timeframe };
  log("info", "e2e pipeline starting", { ...scope, quantBaseUrl: env.quantBaseUrl });

  const publisher = createPublisher(env.redisUrl);

  // ── 1) Market Data + DQ: read what ingestion persisted for this scope ──────
  const dqRow = await prisma.dataQualityReport.findFirst({
    where: { exchange: env.exchange, symbol: env.symbol, timeframe: env.timeframe },
    orderBy: { createdAt: "desc" },
  });
  if (dqRow === null) {
    throw new PipelineError(
      "market-data+dq",
      `no DataQualityReport for ${env.exchange}:${env.symbol}:${env.timeframe} — ` +
        "run the live ingestion step first",
    );
  }
  if (dqRow.status !== "PASSED") {
    throw new PipelineError(
      "market-data+dq",
      `DQ report ${dqRow.id} is ${dqRow.status} (score ${dqRow.score}) — ` +
        "pipeline cannot admit inadmissible data (fail-closed)",
    );
  }

  const candles = await prisma.marketCandle.findMany({
    where: { exchange: env.exchange, symbol: env.symbol, timeframe: env.timeframe },
    orderBy: { ts: "asc" },
  });
  if (candles.length < MIN_CANDLES) {
    throw new PipelineError(
      "market-data+dq",
      `only ${candles.length} candles persisted (< ${MIN_CANDLES}) — ` +
        "ingestion backfill window too short for core-technical v1",
    );
  }
  const lastCandle = candles[candles.length - 1];
  if (lastCandle === undefined) {
    throw new PipelineError("market-data+dq", "candle list unexpectedly empty");
  }
  log("info", "market-data + DQ admitted", {
    dqReportId: dqRow.id,
    score: dqRow.score,
    datasetHash: dqRow.datasetHash,
    candles: candles.length,
    asOfTs: lastCandle.ts.toISOString(),
  });

  // ── 2) Feature: compute (Python authority) + persist one FeatureSnapshot ───
  const featureInput: FeatureComputeInput = {
    dqReportId: dqRow.id,
    dqScore: dqRow.score,
    scope: { ...scope, ts: lastCandle.ts },
    featureSet: FEATURE_SET,
    version: FEATURE_VERSION,
    marketData: {
      candles: candles.map((c) => ({
        ts: c.ts.toISOString(),
        open: c.open.toString(),
        high: c.high.toString(),
        low: c.low.toString(),
        close: c.close.toString(),
        volume: c.volume.toString(),
      })),
    },
  };
  const consumerDeps: {
    prisma: typeof prisma;
    quantBaseUrl: string;
    sharedSecret?: string;
    publish: (name: string, payload: object) => Promise<void>;
  } = {
    prisma,
    quantBaseUrl: env.quantBaseUrl,
    publish: publisher.publish,
  };
  if (env.sharedSecret !== "") consumerDeps.sharedSecret = env.sharedSecret;

  let persistedSnapshot;
  try {
    persistedSnapshot = await consumeFeatureComputation(consumerDeps, featureInput);
  } catch (err) {
    throw new PipelineError(
      "feature",
      `feature computation/persistence failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  log("info", "feature snapshot persisted", {
    snapshotId: persistedSnapshot.id,
    featureHash: persistedSnapshot.featureHash,
  });

  // ── StrategyVersion: ensure the governed decision params exist (idempotent) ─
  const strategy = await prisma.strategy.upsert({
    where: { name: STRATEGY_NAME },
    update: {},
    create: { name: STRATEGY_NAME, createdBy: "system:e2e" },
  });
  const strategyVersionRow = await prisma.strategyVersion.upsert({
    where: { strategyId_version: { strategyId: strategy.id, version: 1 } },
    update: {},
    create: {
      strategyId: strategy.id,
      version: 1,
      status: "ACTIVE",
      description: "Deterministic core-technical v1 EMA/RSI/vol decision (E2E runtime seal).",
      hypothesis: "EMA-stack trend confirmed by RSI, stood down in high realized vol.",
      entryLogic: "side=LONG iff ema20>ema50>ema200 and rsi>=rsiLongMin (mirror for SHORT).",
      exitLogic: "Out of scope for the EngineSignal artifact (decision-only).",
      riskRules: "realized_vol_30 > maxRealizedVol forces decision=FLAT.",
      failureConditions: "DQ<90 or corrupt feature vector -> REFUSED (fail-closed).",
      parameters: { ...STRATEGY_PARAMS },
      validRegimes: ["TRENDING_BULL", "TRENDING_BEAR", "RANGE_BOUND"],
      volatilityBounds: { min: 0, max: STRATEGY_PARAMS.maxRealizedVol },
      createdBy: "system:e2e",
    },
  });

  // ── 3) Signal: generate + persist from PERSISTED artifacts ─────────────────
  // Reload the snapshot from the DB so the engine reads only persisted state.
  const snapshotRow = await prisma.featureSnapshot.findUnique({
    where: { id: persistedSnapshot.id },
  });
  if (snapshotRow === null) {
    throw new PipelineError("signal", "feature snapshot vanished after persistence");
  }
  const signalFeatureSnapshot: SignalFeatureSnapshot = {
    id: snapshotRow.id,
    symbol: snapshotRow.symbol,
    featureHash: snapshotRow.featureHash,
    features: snapshotRow.features as Record<string, number>,
  };
  const signalDqReport: SignalDataQualityReport = {
    id: dqRow.id,
    score: dqRow.score,
    status: dqRow.status,
    datasetHash: dqRow.datasetHash,
  };
  const signalStrategyVersion: SignalStrategyVersion = {
    id: strategyVersionRow.id,
    parameters: strategyVersionRow.parameters as Record<string, unknown>,
  };

  const signalResult = await runSignalEngine(
    { prisma, publish: publisher.publish },
    {
      featureSnapshot: signalFeatureSnapshot,
      dqReport: signalDqReport,
      strategyVersion: signalStrategyVersion,
    },
  );
  if (signalResult.status !== "GENERATED") {
    throw new PipelineError(
      "signal",
      `signal engine REFUSED: ${signalResult.reason}`,
    );
  }
  log("info", "engine signal persisted", {
    signalId: signalResult.signal.id,
    decision: signalResult.signal.decision,
    confidence: signalResult.signal.confidence,
  });

  // ── 4) Replay: reload EVERY artifact from the DB and prove equivalence ──────
  const signalRow = await prisma.engineSignal.findUnique({
    where: { id: signalResult.signal.id },
  });
  if (signalRow === null) {
    throw new PipelineError("replay", "engine signal vanished after persistence");
  }
  const replaySnapshotRow = await prisma.featureSnapshot.findUnique({
    where: { id: signalRow.featureSnapshotId },
  });
  const replayDqRow = await prisma.dataQualityReport.findUnique({
    where: { id: signalRow.dqReportId },
  });
  const replayStrategyRow = await prisma.strategyVersion.findUnique({
    where: { id: signalRow.strategyVersionId },
  });
  if (
    replaySnapshotRow === null ||
    replayDqRow === null ||
    replayStrategyRow === null
  ) {
    throw new PipelineError("replay", "a persisted lineage artifact is missing");
  }

  const persistedSignal: PersistedSignal = {
    id: signalRow.id,
    symbol: signalRow.symbol,
    side: signalRow.side,
    decision: signalRow.decision,
    // Project the Decimal(5,4) back to the canonical 4-decimal string the engine
    // compares (decimal.js drops trailing zeros; quantize restores them).
    confidence: quantizeConfidence(Number(signalRow.confidence)),
    strategyVersionId: signalRow.strategyVersionId,
    strategyParams: signalRow.strategyParams as unknown as SignalParams,
    featureSnapshotId: signalRow.featureSnapshotId,
    dqReportId: signalRow.dqReportId,
    datasetHash: signalRow.datasetHash,
    featureHash: signalRow.featureHash,
  };

  const replay = replayEngineSignal({
    signal: persistedSignal,
    featureSnapshot: {
      id: replaySnapshotRow.id,
      symbol: replaySnapshotRow.symbol,
      featureHash: replaySnapshotRow.featureHash,
      features: replaySnapshotRow.features as Record<string, number>,
    },
    dqReport: {
      id: replayDqRow.id,
      score: replayDqRow.score,
      status: replayDqRow.status,
      datasetHash: replayDqRow.datasetHash,
    },
    strategyVersion: {
      id: replayStrategyRow.id,
      parameters: replayStrategyRow.parameters as Record<string, unknown>,
    },
  });

  const fullMatch =
    replay.replayResult === "MATCH" &&
    replay.decisionMatch &&
    replay.confidenceMatch &&
    replay.sideMatch &&
    replay.lineageMatch;

  if (!fullMatch) {
    throw new PipelineError(
      "replay",
      `replay not a full match: ${replay.replayResult} — ${replay.detail}`,
    );
  }

  await publisher.close();

  // Final machine-readable summary line (single, parseable).
  console.log(
    JSON.stringify({
      ts: new Date().toISOString(),
      service: "workers",
      component: "e2e-pipeline",
      level: "info",
      msg: "e2e pipeline SEALED",
      scope,
      dqReportId: dqRow.id,
      dqScore: dqRow.score,
      datasetHash: dqRow.datasetHash,
      featureSnapshotId: persistedSnapshot.id,
      featureHash: persistedSnapshot.featureHash,
      engineSignalId: signalRow.id,
      decision: signalRow.decision,
      side: signalRow.side,
      confidence: persistedSignal.confidence,
      replayResult: replay.replayResult,
      replayMatch: fullMatch,
    }),
  );
}

main()
  .then(async () => {
    await prisma.$disconnect().catch(() => undefined);
    process.exit(0);
  })
  .catch(async (err: unknown) => {
    const stage = err instanceof PipelineError ? err.stage : "unknown";
    log("error", "e2e pipeline FAILED", {
      stage,
      error: err instanceof Error ? err.message : String(err),
    });
    await prisma.$disconnect().catch(() => undefined);
    process.exit(1);
  });
