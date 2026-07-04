/**
 * Demo signal upstream chain (runtime continuity).
 *
 * Single source of truth for the deterministic lineage an EngineSignal requires:
 *   Strategy -> StrategyVersion (params)         ─┐
 *   FeatureSetDefinition (core-technical v1) ─┐    ├─> EngineSignal
 *   DataQualityReport (PASSED, >= 90) ────────┴─> FeatureSnapshot
 *
 * Imported by BOTH the workers pipeline (idempotent bootstrap on every tick) and
 * `pnpm db:seed:demo`, so the two can never drift. Every row is upserted on a
 * STABLE key (fixed id / composite unique) — re-running creates no duplicates.
 *
 * The feature VALUES below are deterministic fixtures; the engine derives
 * side/decision/confidence from them (it is never given a decision here). The
 * fixed `featureHash`/`datasetHash` are opaque strings copied verbatim by the
 * engine and replay — they are NOT recomputed, so determinism guarantees hold.
 * Real ingested FeatureSnapshots (recent `ts`) supersede these by `ts desc`.
 */

import { Prisma, type PrismaClient } from "@prisma/client";

export type ChainLogger = (
  level: "info" | "warn" | "error",
  msg: string,
  extra?: Record<string, unknown>,
) => void;

export interface SignalDemoChain {
  featureSetId: string;
  strategyVersion: { id: string; parameters: Record<string, unknown> };
  symbols: string[];
}

const DEMO_TS = new Date("2026-06-01T00:00:00.000Z");
const WINDOW_START = new Date("2026-05-31T00:00:00.000Z");
const WINDOW_END = DEMO_TS;

const STRATEGY_ID = "demo-strategy-core-technical";
const STRATEGY_VERSION_ID = "demo-strategy-core-technical-v1";

/** Resolved decision params (matches the engine's v1 defaults). */
const STRATEGY_PARAMS: Record<string, number> = {
  rsiLongMin: 55,
  rsiShortMax: 45,
  maxRealizedVol: 0.02,
};

interface DemoFixture {
  symbol: string;
  snapshotId: string;
  dqReportId: string;
  datasetHash: string;
  featureHash: string;
  features: Record<string, number>;
}

/** BTC -> LONG (bull EMA stack, RSI confirms, vol below filter); ETH -> SHORT. */
const FIXTURES: DemoFixture[] = [
  {
    symbol: "BTC-PERP",
    snapshotId: "demo-fs-btc-perp-h1",
    dqReportId: "demo-dq-btc-perp-h1",
    datasetHash: "demo-dataset-btc-perp-h1-v1",
    featureHash: "demo-feature-btc-perp-h1-v1",
    features: {
      ema_20: 30250,
      ema_50: 29800,
      ema_200: 28500,
      rsi_14: 63,
      realized_vol_30: 0.014,
      atr_14: 480.5,
      volume_zscore: 0.9,
    },
  },
  {
    symbol: "ETH-PERP",
    snapshotId: "demo-fs-eth-perp-h1",
    dqReportId: "demo-dq-eth-perp-h1",
    datasetHash: "demo-dataset-eth-perp-h1-v1",
    featureHash: "demo-feature-eth-perp-h1-v1",
    features: {
      ema_20: 1850,
      ema_50: 1920,
      ema_200: 2050,
      rsi_14: 37,
      realized_vol_30: 0.016,
      atr_14: 42.3,
      volume_zscore: -0.4,
    },
  },
];

const json = (v: unknown): Prisma.InputJsonValue => v as Prisma.InputJsonValue;

/**
 * Idempotently ensure the full upstream chain exists, returning the projections
 * the engine needs. Safe to call on every pipeline tick.
 */
export async function ensureSignalDemoChain(
  prisma: PrismaClient,
  log?: ChainLogger,
): Promise<SignalDemoChain> {
  // 1) Strategy + StrategyVersion (fixed ids -> stable strategyVersionId).
  await prisma.strategy.upsert({
    where: { id: STRATEGY_ID },
    update: {},
    create: { id: STRATEGY_ID, name: "Demo Core-Technical", createdBy: "system:demo" },
  });
  await prisma.strategyVersion.upsert({
    where: { id: STRATEGY_VERSION_ID },
    update: { parameters: json(STRATEGY_PARAMS) },
    create: {
      id: STRATEGY_VERSION_ID,
      strategyId: STRATEGY_ID,
      version: 1,
      status: "ACTIVE",
      description: "Deterministic EMA-trend / RSI-regime / volatility-filter reference strategy (demo).",
      hypothesis: "Trend-following with RSI confirmation has positive expectancy outside high-vol regimes.",
      entryLogic: "EMA(20)>EMA(50)>EMA(200) & RSI>=rsiLongMin -> LONG; mirror for SHORT.",
      exitLogic: "Volatility filter forces FLAT when realized_vol_30 > maxRealizedVol.",
      riskRules: "No signal below DQ 90; volatility filter dominates the directional bias.",
      failureConditions: "Regime shift to PANIC/HIGH_VOL; realized vol breach; DQ degradation.",
      parameters: json(STRATEGY_PARAMS),
      validRegimes: json(["TRENDING_BULL", "TRENDING_BEAR", "RANGE_BOUND"]),
      volatilityBounds: json({ min: 0, max: STRATEGY_PARAMS["maxRealizedVol"] }),
      createdBy: "system:demo",
    },
  });

  // 2) FeatureSetDefinition (core-technical v1) — find-or-create; base seed may
  //    already own it, so resolve the live id rather than assuming a fixed one.
  const def = await prisma.featureSetDefinition.upsert({
    where: { name_version: { name: "core-technical", version: 1 } },
    update: {},
    create: {
      name: "core-technical",
      version: 1,
      domain: "TECHNICAL",
      createdBy: "system:demo",
      spec: json({
        indicators: [
          { name: "ema", params: { periods: [20, 50, 200] } },
          { name: "rsi", params: { period: 14 } },
          { name: "realized_vol", params: { windowBars: 30 } },
        ],
        canonicalOrder: "alphabetical",
        hash: "sha256",
      }),
    },
    select: { id: true },
  });
  const featureSetId = def.id;

  // 3) Per-symbol DataQualityReport + FeatureSnapshot (fixed ids -> idempotent).
  for (const f of FIXTURES) {
    await prisma.dataQualityReport.upsert({
      where: { id: f.dqReportId },
      update: { score: 95, status: "PASSED", datasetHash: f.datasetHash },
      create: {
        id: f.dqReportId,
        exchange: "DEMO",
        symbol: f.symbol,
        timeframe: "H1",
        windowStart: WINDOW_START,
        windowEnd: WINDOW_END,
        score: 95,
        status: "PASSED",
        checks: json([{ check: "demo-bootstrap", passed: true, deduction: 0, detail: "synthetic runtime-continuity report" }]),
        datasetHash: f.datasetHash,
      },
    });

    await prisma.featureSnapshot.upsert({
      where: { id: f.snapshotId },
      update: {
        features: json(f.features),
        featureHash: f.featureHash,
        dqReportId: f.dqReportId,
        featureSetId,
      },
      create: {
        id: f.snapshotId,
        exchange: "DEMO",
        symbol: f.symbol,
        timeframe: "H1",
        ts: DEMO_TS,
        features: json(f.features),
        featureHash: f.featureHash,
        featureSetId,
        dqReportId: f.dqReportId,
      },
    });
  }

  const symbols = FIXTURES.map((f) => f.symbol);
  log?.("info", "demo signal upstream chain ensured", {
    strategyVersionId: STRATEGY_VERSION_ID,
    featureSetId,
    symbols,
  });

  return {
    featureSetId,
    strategyVersion: { id: STRATEGY_VERSION_ID, parameters: STRATEGY_PARAMS },
    symbols,
  };
}
