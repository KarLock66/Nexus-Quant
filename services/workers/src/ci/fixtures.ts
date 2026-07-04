/**
 * CI harness fixtures — TEST-ONLY seed data and providers.
 *
 * This module is imported ONLY by the CI runtime harness (src/ci/*) and unit
 * tests. It is never imported by the production runtime (src/index.ts,
 * src/pipeline/*, src/market/* runtime paths) — the production pipeline
 * FAILS FAST when upstream data is missing instead of fabricating it.
 *
 * The harness runs against a DISPOSABLE database (the CI workflow provisions a
 * fresh Postgres service per run). `ensureCiFixtureLineage` seeds the exact
 * upstream chain an EngineSignal requires:
 *
 *   Strategy -> StrategyVersion (params)           ─┐
 *   FeatureSetDefinition (core-technical v1)   ─┐    ├─> EngineSignal
 *   DataQualityReport (PASSED, >= 90) ──────────┴─> FeatureSnapshot
 *
 * Every row is upserted on a STABLE key (fixed `ci-*` id / composite unique) —
 * re-running creates no duplicates, so the harness invariant "exactly one
 * EngineSignal per (featureSnapshotId, strategyVersionId)" is checkable.
 *
 * The feature VALUES are deterministic; the engine derives side/decision/
 * confidence from them (it is never handed a decision here). The fixed
 * `featureHash`/`datasetHash` strings are opaque to the engine and replay
 * (copied verbatim, never recomputed), so determinism guarantees hold.
 */

import { Prisma, prisma as defaultPrisma, type PrismaClient } from "@nexus/db";
import { HistoricalProvider, type MarketDataProvider } from "../market/market-data.js";
import { quantizePrice } from "../market/money.js";
import type { Quote } from "../market/types.js";

export type FixtureLogger = (
  level: "info" | "warn" | "error",
  msg: string,
  extra?: Record<string, unknown>,
) => void;

export interface CiFixtureLineage {
  featureSetId: string;
  strategyVersion: { id: string; parameters: Record<string, unknown> };
  symbols: string[];
}

const FIXTURE_TS = new Date("2026-06-01T00:00:00.000Z");
const WINDOW_START = new Date("2026-05-31T00:00:00.000Z");
const WINDOW_END = FIXTURE_TS;

export const CI_STRATEGY_ID = "ci-strategy-core-technical";
export const CI_STRATEGY_VERSION_ID = "ci-strategy-core-technical-v1";

/** Resolved decision params (matches the engine's v1 defaults). */
const STRATEGY_PARAMS: Record<string, number> = {
  rsiLongMin: 55,
  rsiShortMax: 45,
  maxRealizedVol: 0.02,
};

interface FixtureRow {
  symbol: string;
  snapshotId: string;
  dqReportId: string;
  datasetHash: string;
  featureHash: string;
  features: Record<string, number>;
}

/** BTC -> LONG (bull EMA stack, RSI confirms, vol below filter); ETH -> SHORT. */
const FIXTURES: FixtureRow[] = [
  {
    symbol: "BTC-PERP",
    snapshotId: "ci-fs-btc-perp-h1",
    dqReportId: "ci-dq-btc-perp-h1",
    datasetHash: "ci-dataset-btc-perp-h1-v1",
    featureHash: "ci-feature-btc-perp-h1-v1",
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
    snapshotId: "ci-fs-eth-perp-h1",
    dqReportId: "ci-dq-eth-perp-h1",
    datasetHash: "ci-dataset-eth-perp-h1-v1",
    featureHash: "ci-feature-eth-perp-h1-v1",
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

/**
 * Venue label for the fixture snapshots. The pipeline unconditionally excludes
 * the legacy synthetic "DEMO" venue, so fixture rows carry a real venue label —
 * legitimate ONLY because the harness owns a disposable database.
 */
const FIXTURE_EXCHANGE = "DERIBIT";

/** Stable FeatureSnapshot ids of the CI fixture lineage (exactly two). */
export const FIXTURE_SNAPSHOT_IDS = ["ci-fs-btc-perp-h1", "ci-fs-eth-perp-h1"] as const;

const json = (v: unknown): Prisma.InputJsonValue => v as Prisma.InputJsonValue;

/**
 * Idempotently seed the full upstream chain, returning the projections the
 * engine needs. CI/test use only — see the module header.
 */
export async function ensureCiFixtureLineage(
  prisma: PrismaClient = defaultPrisma,
  log?: FixtureLogger,
): Promise<CiFixtureLineage> {
  // 1) Strategy + StrategyVersion (fixed ids -> stable strategyVersionId).
  await prisma.strategy.upsert({
    where: { id: CI_STRATEGY_ID },
    update: {},
    create: { id: CI_STRATEGY_ID, name: "CI Core-Technical", createdBy: "ci:harness" },
  });
  await prisma.strategyVersion.upsert({
    where: { id: CI_STRATEGY_VERSION_ID },
    update: { parameters: json(STRATEGY_PARAMS) },
    create: {
      id: CI_STRATEGY_VERSION_ID,
      strategyId: CI_STRATEGY_ID,
      version: 1,
      status: "ACTIVE",
      description: "Deterministic EMA-trend / RSI-regime / volatility-filter reference strategy (CI fixture).",
      hypothesis: "Trend-following with RSI confirmation has positive expectancy outside high-vol regimes.",
      entryLogic: "EMA(20)>EMA(50)>EMA(200) & RSI>=rsiLongMin -> LONG; mirror for SHORT.",
      exitLogic: "Volatility filter forces FLAT when realized_vol_30 > maxRealizedVol.",
      riskRules: "No signal below DQ 90; volatility filter dominates the directional bias.",
      failureConditions: "Regime shift to PANIC/HIGH_VOL; realized vol breach; DQ degradation.",
      parameters: json(STRATEGY_PARAMS),
      validRegimes: json(["TRENDING_BULL", "TRENDING_BEAR", "RANGE_BOUND"]),
      volatilityBounds: json({ min: 0, max: STRATEGY_PARAMS["maxRealizedVol"] }),
      createdBy: "ci:harness",
    },
  });

  // 2) FeatureSetDefinition (core-technical v1) — find-or-create; the base seed
  //    may already own it, so resolve the live id rather than assuming one.
  const def = await prisma.featureSetDefinition.upsert({
    where: { name_version: { name: "core-technical", version: 1 } },
    update: {},
    create: {
      name: "core-technical",
      version: 1,
      domain: "TECHNICAL",
      createdBy: "ci:harness",
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
        exchange: FIXTURE_EXCHANGE,
        symbol: f.symbol,
        timeframe: "H1",
        windowStart: WINDOW_START,
        windowEnd: WINDOW_END,
        score: 95,
        status: "PASSED",
        checks: json([{ check: "ci-fixture", passed: true, deduction: 0, detail: "deterministic CI harness fixture report" }]),
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
        exchange: FIXTURE_EXCHANGE,
        symbol: f.symbol,
        timeframe: "H1",
        ts: FIXTURE_TS,
        features: json(f.features),
        featureHash: f.featureHash,
        featureSetId,
        dqReportId: f.dqReportId,
      },
    });
  }

  const symbols = FIXTURES.map((f) => f.symbol);
  log?.("info", "CI fixture lineage ensured", {
    strategyVersionId: CI_STRATEGY_VERSION_ID,
    featureSetId,
    symbols,
  });

  return {
    featureSetId,
    strategyVersion: { id: CI_STRATEGY_VERSION_ID, parameters: STRATEGY_PARAMS },
    symbols,
  };
}

/**
 * Deterministic fixture quotes aligned to the fixture FeatureSnapshot timestamp
 * (BTC-PERP, ETH-PERP). Fixed values -> the market layer is deterministic in
 * tests without coupling to feature internals. TEST/CI ONLY — the production
 * worker builds its provider from MARKET_DATA_SOURCE=realtime or stays unarmed.
 */
export const FIXTURE_QUOTES: Quote[] = [
  { symbol: "BTC-PERP", ts: "2026-06-01T00:00:00.000Z", price: quantizePrice(30000) },
  { symbol: "ETH-PERP", ts: "2026-06-01T00:00:00.000Z", price: quantizePrice(1850) },
];

/** A ready-made deterministic provider over the fixture quotes (test/CI only). */
export function fixtureQuoteProvider(): MarketDataProvider {
  return new HistoricalProvider(FIXTURE_QUOTES);
}
