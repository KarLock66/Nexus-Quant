/**
 * Live ingestion daemon (Phase 9).
 *
 * Drives the real-data half of the runtime pipeline end-to-end:
 *
 *   bootstrap (REST backfill -> DQ -> FeatureSnapshot, "warm indicators")
 *     -> live WebSocket stream
 *          candle  -> upsert + recompute features on the rolling window
 *          trade   -> buffered batch upsert (MarketTick)
 *          quote   -> throttled upsert (OrderbookSnapshot, best bid/ask + mark)
 *          funding -> throttled upsert (FundingRate)
 *     -> periodic REST flow poll (OI / LSR / liquidity / option chain)
 *
 * The worker tick reads "latest FeatureSnapshot per symbol by ts desc", so the
 * FeatureSnapshots written here drive real signals with NO worker change.
 *
 * Restart recovery: re-running bootstrap is idempotent (every write upserts on a
 * composite PK / point-in-time key), so a restart re-warms and resumes with no
 * divergence — re-ingesting a window yields byte-identical rows + featureHash.
 */

import type { PrismaClient } from "@nexus/db";
import type { AssetType, Exchange, Timeframe } from "@nexus/core";
import { EVENTS } from "@nexus/events";
import type {
  ExchangeConnector,
  NormalizedCandle,
  NormalizedFundingRate,
  NormalizedQuote,
  NormalizedTick,
} from "../connectors/types.js";
import { StageBAuthError, TIMEFRAME_MS, validateAndReport } from "../dq/index.js";
import {
  heartbeat,
  upsertCandles,
  upsertFundingRates,
  upsertLiquidity,
  upsertLongShortRatios,
  upsertOpenInterest,
  upsertOptionChain,
} from "../persistence/index.js";
import { upsertOrderbookSnapshots, upsertTicks } from "../persistence/ticks.js";
import { computeAndPersistFeatures } from "../features/bridge.js";
import type { PersistedFeatureSnapshot } from "../features/bridge.js";
import { log } from "../lib/log.js";
import { errMsg } from "../persistence/util.js";

/** Candles fed to the quant compute (enough to warm ema_200 + realized_vol_30). */
export const DEFAULT_FEATURE_WINDOW = 300;
/**
 * Minimum candles the default feature set (`core-technical` v1) needs to compute
 * — ema_200 plus one prior close for the first return. MIRRORS quant's
 * services/quant/app/features/core_technical.py MIN_CANDLES (and the local pin in
 * services/workers/src/cli/e2e-pipeline.ts). Pinned here so the live loop can warm
 * up enough history BEFORE calling quant and report "still warming up" distinctly
 * from a real failure — instead of letting quant reject INSUFFICIENT_DATA on every
 * tick. The quant service re-enforces this floor regardless (defense-in-depth).
 */
export const MIN_FEATURE_CANDLES = 201;
const TICK_FLUSH_MS = 1_000;
const QUOTE_FLUSH_MS = 2_000;
const ONE_DAY_MS = 86_400_000;

export interface LiveIngestionDeps {
  prisma: PrismaClient;
  publish: (name: string, payload: object) => Promise<void>;
  quantBaseUrl: string | null;
  sharedSecret?: string;
}

export interface LiveIngestionOptions {
  symbols: Array<{ symbol: string; assetType: AssetType }>;
  liveTimeframe: Timeframe;
  underlyings: string[];
  backfillFrom: Date;
  backfillTo: Date;
  flowPollMs: number;
  featureSet: string;
  featureVersion: number;
  featureWindow?: number;
}

export interface LiveIngestionHandle {
  /** Resolves once the stream is closed and the final flush completed. */
  stop(): Promise<void>;
}

// ── Feature materialization (shared by bootstrap, live, and the seal harness) ──

/**
 * Self-healing warmup. The live stream alone accrues only ONE candle per
 * timeframe interval, so a cold or retention-pruned candle store would never
 * reach the feature set's warmup minimum (e.g. ema_200) on its own — every
 * compute would fail INSUFFICIENT_DATA indefinitely, with no recovery short of
 * an operator re-running bootstrap. When the store is short, backfill a window
 * covering >= `minCandles` bars from the connector (idempotent upsert on the
 * point-in-time key), so the pipeline recovers on the next candle tick.
 *
 * No-op once warm (>= minCandles), so there is no steady-state overhead. A
 * connector/persist failure is logged and the pre-existing count returned
 * (fail-soft: the caller still skips the compute while short).
 */
export async function ensureWarmupHistory(
  connector: ExchangeConnector,
  deps: Pick<LiveIngestionDeps, "prisma">,
  params: {
    exchange: Exchange;
    symbol: string;
    assetType: AssetType;
    timeframe: Timeframe;
    minCandles?: number;
  },
): Promise<number> {
  const minCandles = params.minCandles ?? MIN_FEATURE_CANDLES;
  const where = {
    exchange: params.exchange,
    symbol: params.symbol,
    timeframe: params.timeframe,
  };
  const have = await deps.prisma.marketCandle.count({ where });
  if (have >= minCandles || !connector.capabilities.candles) return have;

  // Fetch comfortably more than the floor (×1.5 + headroom) so a single pass
  // clears the warmup even with venue-side gaps in the window.
  const bars = Math.ceil(minCandles * 1.5) + 5;
  const to = new Date();
  const from = new Date(to.getTime() - bars * TIMEFRAME_MS[params.timeframe]);
  try {
    const candles = await connector.fetchCandles({
      symbol: params.symbol,
      assetType: params.assetType,
      timeframe: params.timeframe,
      from,
      to,
    });
    const written = await upsertCandles(deps.prisma, candles);
    log("info", "warmup backfill: filled candle history for feature warmup", {
      ...where,
      had: have,
      fetched: candles.length,
      written,
    });
  } catch (err) {
    log("error", "warmup backfill failed", { ...where, error: errMsg(err) });
  }
  return deps.prisma.marketCandle.count({ where });
}

/**
 * Read the last `featureWindow` candles for (exchange, symbol, timeframe) from
 * the DB, re-run DQ over them, and — if PASSED and a quant URL is configured —
 * compute + persist one FeatureSnapshot. Returns the snapshot, or null when no
 * candles exist / too few for warmup / DQ failed / quant is not configured (each
 * logged, fail-closed for persistence but non-fatal for the loop).
 */
export async function materializeFeaturesFromDb(
  deps: LiveIngestionDeps,
  params: {
    exchange: Exchange;
    symbol: string;
    timeframe: Timeframe;
    featureSet: string;
    featureVersion: number;
    featureWindow?: number;
    /** Warmup floor; below this we skip the (guaranteed-failing) quant call. */
    minCandles?: number;
  },
): Promise<PersistedFeatureSnapshot | null> {
  if (deps.quantBaseUrl === null) return null;
  const take = params.featureWindow ?? DEFAULT_FEATURE_WINDOW;
  const rows = await deps.prisma.marketCandle.findMany({
    where: { exchange: params.exchange, symbol: params.symbol, timeframe: params.timeframe },
    orderBy: { ts: "desc" },
    take,
  });
  if (rows.length === 0) return null;
  const minCandles = params.minCandles ?? MIN_FEATURE_CANDLES;
  if (rows.length < minCandles) {
    // Not enough warmup history for the feature set yet (cold / pruned candle
    // store). Skip the round-trip that would only return INSUFFICIENT_DATA and
    // report the gap plainly — the live loop self-heals via ensureWarmupHistory,
    // so this is "still warming up", not a failure.
    log("warn", "insufficient warmup history — skipping feature compute", {
      exchange: params.exchange,
      symbol: params.symbol,
      timeframe: params.timeframe,
      have: rows.length,
      need: minCandles,
    });
    return null;
  }
  rows.reverse(); // ascending (point-in-time order)

  const candles: NormalizedCandle[] = rows.map((r) => ({
    exchange: r.exchange,
    symbol: r.symbol,
    assetType: r.assetType,
    timeframe: r.timeframe,
    ts: r.ts,
    open: r.open.toString(),
    high: r.high.toString(),
    low: r.low.toString(),
    close: r.close.toString(),
    volume: r.volume.toString(),
    ...(r.trades !== null ? { trades: r.trades } : {}),
  }));

  const first = candles[0]!;
  const last = candles[candles.length - 1]!;
  const dqDeps: { prisma: PrismaClient; quantBaseUrl: string | null; sharedSecret?: string } = {
    prisma: deps.prisma,
    quantBaseUrl: deps.quantBaseUrl,
  };
  if (deps.sharedSecret !== undefined) dqDeps.sharedSecret = deps.sharedSecret;

  const report = await validateAndReport(
    dqDeps,
    { exchange: params.exchange, symbol: params.symbol, timeframe: params.timeframe, from: first.ts, to: last.ts },
    candles,
  );
  if (report.status !== "PASSED") {
    log("warn", "live DQ not PASSED — no feature snapshot", {
      exchange: params.exchange,
      symbol: params.symbol,
      score: report.score,
    });
    return null;
  }

  const bridgeDeps: LiveIngestionDeps & { quantBaseUrl: string } = {
    ...deps,
    quantBaseUrl: deps.quantBaseUrl,
  };
  return computeAndPersistFeatures(bridgeDeps, {
    scope: { exchange: params.exchange, symbol: params.symbol, timeframe: params.timeframe, ts: last.ts },
    candles,
    dqReportId: report.id,
    dqScore: report.score,
    featureSet: params.featureSet,
    version: params.featureVersion,
  });
}

// ── Bootstrap ─────────────────────────────────────────────────────────────────

/**
 * Historical warm-up: REST backfill (candles + flow + options) through the DQ
 * gateway, and — via the opt-in feature hook — a FeatureSnapshot per admitted
 * candle window. Idempotent (safe to re-run on restart).
 */
export async function bootstrap(
  connector: ExchangeConnector,
  opts: LiveIngestionOptions,
  deps: LiveIngestionDeps,
): Promise<void> {
  const { runBackfill } = await import("./backfill.js");
  const perps = opts.symbols.filter((s) => s.assetType === "PERP");

  const backfillDeps: Parameters<typeof runBackfill>[2] = {
    prisma: deps.prisma,
    publish: deps.publish,
    quantBaseUrl: deps.quantBaseUrl,
    ...(deps.sharedSecret !== undefined ? { sharedSecret: deps.sharedSecret } : {}),
    // Feature bridge: compute a FeatureSnapshot from the tail of each admitted
    // window (opt-in; only when quant is configured).
    ...(deps.quantBaseUrl !== null
      ? {
          onCandlesValidated: async ({ scope, candles, report }) => {
            const window = candles.slice(-(opts.featureWindow ?? DEFAULT_FEATURE_WINDOW));
            if (window.length === 0) return;
            const last = window[window.length - 1]!;
            await computeAndPersistFeatures(
              { ...deps, quantBaseUrl: deps.quantBaseUrl as string },
              {
                scope: { exchange: scope.exchange, symbol: scope.symbol, timeframe: scope.timeframe, ts: last.ts },
                candles: window,
                dqReportId: report.id,
                dqScore: report.score,
                featureSet: opts.featureSet,
                version: opts.featureVersion,
              },
            );
          },
        }
      : {}),
  };

  await runBackfill(
    connector,
    {
      symbols: perps,
      timeframes: [opts.liveTimeframe],
      from: opts.backfillFrom,
      to: opts.backfillTo,
      underlyings: opts.underlyings,
    },
    backfillDeps,
  );
}

// ── Periodic REST flow poll (OI / LSR / liquidity / option chain) ─────────────

async function pollFlow(
  connector: ExchangeConnector,
  perps: Array<{ symbol: string; assetType: AssetType }>,
  underlyings: string[],
  deps: LiveIngestionDeps,
): Promise<void> {
  const now = Date.now();
  const from = new Date(now - ONE_DAY_MS);
  const to = new Date(now);
  for (const { symbol } of perps) {
    try {
      if (connector.capabilities.openInterest) {
        await upsertOpenInterest(deps.prisma, await connector.fetchOpenInterest({ symbol, from, to }));
      }
      if (connector.capabilities.longShortRatio) {
        await upsertLongShortRatios(deps.prisma, await connector.fetchLongShortRatios({ symbol, from, to }));
      }
      if (connector.capabilities.liquidity) {
        const liq = await connector.fetchLiquidity(symbol);
        if (liq !== null) await upsertLiquidity(deps.prisma, liq);
      }
    } catch (err) {
      log("warn", "flow poll scope failed", { symbol, error: errMsg(err) });
    }
  }
  if (connector.capabilities.optionChain) {
    for (const underlying of underlyings) {
      try {
        const chain = await connector.fetchOptionChain(underlying);
        if (chain !== null) await upsertOptionChain(deps.prisma, chain);
      } catch (err) {
        log("warn", "flow poll option chain failed", { underlying, error: errMsg(err) });
      }
    }
  }
}

// ── Live daemon ───────────────────────────────────────────────────────────────

export async function runLiveIngestion(
  connector: ExchangeConnector,
  opts: LiveIngestionOptions,
  deps: LiveIngestionDeps,
): Promise<LiveIngestionHandle> {
  const exchange = connector.exchange;
  const job = `live:${exchange}`;
  const perps = opts.symbols.filter((s) => s.assetType === "PERP");
  if (perps.length === 0) {
    throw new Error(`no PERP symbols configured for live ingestion on ${exchange}`);
  }

  await heartbeat(deps.prisma, job, "RUNNING", {
    symbols: perps.map((s) => s.symbol),
    timeframe: opts.liveTimeframe,
  });

  // 1) Bootstrap (idempotent warm-up).
  log("info", "live ingestion bootstrap start", { exchange, symbols: perps.map((s) => s.symbol) });
  await bootstrap(connector, { ...opts, symbols: perps }, deps);
  log("info", "live ingestion bootstrap complete", { exchange });

  // 2) Live buffers.
  const tickBuffer = new Map<string, NormalizedTick[]>();
  const latestQuote = new Map<string, NormalizedQuote>();
  const latestFunding = new Map<string, NormalizedFundingRate>();
  const recomputing = new Set<string>();

  const recomputeFeatures = (symbol: string): void => {
    if (deps.quantBaseUrl === null || recomputing.has(symbol)) return;
    recomputing.add(symbol);
    const assetType = perps.find((s) => s.symbol === symbol)?.assetType;
    void (async () => {
      // Self-heal a cold / short candle store first so the feature set can warm
      // up; a no-op once enough history exists (no steady-state overhead).
      if (assetType !== undefined) {
        await ensureWarmupHistory(connector, deps, {
          exchange,
          symbol,
          assetType,
          timeframe: opts.liveTimeframe,
          minCandles: MIN_FEATURE_CANDLES,
        });
      }
      return materializeFeaturesFromDb(deps, {
        exchange,
        symbol,
        timeframe: opts.liveTimeframe,
        featureSet: opts.featureSet,
        featureVersion: opts.featureVersion,
        ...(opts.featureWindow !== undefined ? { featureWindow: opts.featureWindow } : {}),
      });
    })()
      .catch((err) => log("error", "live feature recompute failed", { symbol, error: errMsg(err) }))
      .finally(() => recomputing.delete(symbol));
  };

  const subscription = await connector.streamLive(
    { symbols: perps, timeframe: opts.liveTimeframe },
    {
      onCandle: (candle) => {
        void upsertCandles(deps.prisma, [candle])
          .then(() =>
            deps.publish(EVENTS.DATA_CANDLE_INGESTED, {
              exchange: candle.exchange,
              symbol: candle.symbol,
              timeframe: candle.timeframe,
              ts: candle.ts.toISOString(),
            }),
          )
          .then(() => recomputeFeatures(candle.symbol))
          .catch((err) => log("error", "live candle persist failed", { symbol: candle.symbol, error: errMsg(err) }));
      },
      onTrade: (tick) => {
        const buf = tickBuffer.get(tick.symbol);
        if (buf) buf.push(tick);
        else tickBuffer.set(tick.symbol, [tick]);
      },
      onQuote: (quote) => {
        latestQuote.set(quote.symbol, quote);
      },
      onFunding: (rate) => {
        latestFunding.set(rate.symbol, rate);
      },
      onError: (err) => log("warn", "live stream error", { exchange, error: err.message }),
      onConnected: () => log("info", "live stream connected", { exchange }),
      onDisconnected: (reason) => log("warn", "live stream disconnected", { exchange, reason }),
    },
  );

  // 3) Flush loops.
  const flushTicks = async (): Promise<void> => {
    for (const [symbol, buf] of tickBuffer) {
      if (buf.length === 0) continue;
      const batch = buf.splice(0, buf.length);
      try {
        const inserted = await upsertTicks(deps.prisma, batch);
        const last = batch[batch.length - 1]!;
        await deps.publish(EVENTS.DATA_TICK_INGESTED, {
          exchange,
          symbol,
          count: inserted,
          ts: last.ts.toISOString(),
        });
      } catch (err) {
        log("error", "tick flush failed", { symbol, error: errMsg(err) });
      }
    }
  };

  const flushQuotes = async (): Promise<void> => {
    for (const [symbol, quote] of latestQuote) {
      try {
        await upsertOrderbookSnapshots(deps.prisma, [quote]);
        await deps.publish(EVENTS.DATA_ORDERBOOK_INGESTED, {
          exchange,
          symbol,
          ts: quote.ts.toISOString(),
          bestBid: quote.bestBid,
          bestAsk: quote.bestAsk,
          ...(quote.markPrice !== undefined ? { markPrice: quote.markPrice } : {}),
        });
      } catch (err) {
        log("error", "quote flush failed", { symbol, error: errMsg(err) });
      }
    }
    latestQuote.clear();
    const funding = [...latestFunding.values()];
    latestFunding.clear();
    if (funding.length > 0) {
      try {
        await upsertFundingRates(deps.prisma, funding);
      } catch (err) {
        log("error", "funding flush failed", { error: errMsg(err) });
      }
    }
  };

  const tickTimer = setInterval(() => void flushTicks(), TICK_FLUSH_MS);
  const quoteTimer = setInterval(() => void flushQuotes(), QUOTE_FLUSH_MS);
  const flowTimer = setInterval(
    () => void pollFlow(connector, perps, opts.underlyings, deps).catch(() => undefined),
    opts.flowPollMs,
  );

  log("info", "live ingestion running", { exchange, symbols: perps.map((s) => s.symbol) });

  let stopped = false;
  return {
    async stop(): Promise<void> {
      if (stopped) return;
      stopped = true;
      clearInterval(tickTimer);
      clearInterval(quoteTimer);
      clearInterval(flowTimer);
      await subscription.close().catch(() => undefined);
      // Final drain so nothing buffered is lost.
      await flushTicks();
      await flushQuotes();
      await heartbeat(deps.prisma, job, "OK", { exchange });
      log("info", "live ingestion stopped", { exchange });
    },
  };
}
