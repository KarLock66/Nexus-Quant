/**
 * Idempotent persistence layer for normalized market data.
 *
 * Invariants:
 *  - Every write is an upsert on the table's composite PK — re-running any
 *    backfill never duplicates rows.
 *  - All market numerics arrive as decimal strings and are handed to Prisma
 *    unchanged (Decimal at rest; no float drift). The only decimal arithmetic
 *    (OI delta) uses Prisma.Decimal (decimal.js), never JS floats.
 *  - Writes are batched into $transaction chunks of 500 rows.
 *  - Failures are logged with structure and rethrown (fail-closed) — except
 *    heartbeat, which is telemetry and must never take a pipeline down.
 */

import { Prisma } from "@nexus/db";
import type { PrismaClient } from "@nexus/db";
import type {
  NormalizedCandle,
  NormalizedFundingRate,
  NormalizedLiquidity,
  NormalizedLongShortRatio,
  NormalizedOpenInterest,
  NormalizedOptionChain,
} from "../connectors/types.js";
import { log } from "../lib/log.js";
import { chunk, errMsg } from "./util.js";

export const UPSERT_CHUNK_SIZE = 500;

export async function upsertCandles(
  prisma: PrismaClient,
  candles: NormalizedCandle[],
): Promise<number> {
  if (candles.length === 0) return 0;
  let written = 0;
  try {
    for (const batch of chunk(candles, UPSERT_CHUNK_SIZE)) {
      await prisma.$transaction(
        batch.map((c) =>
          prisma.marketCandle.upsert({
            where: {
              exchange_symbol_timeframe_ts: {
                exchange: c.exchange,
                symbol: c.symbol,
                timeframe: c.timeframe,
                ts: c.ts,
              },
            },
            create: {
              exchange: c.exchange,
              symbol: c.symbol,
              assetType: c.assetType,
              timeframe: c.timeframe,
              ts: c.ts,
              open: c.open,
              high: c.high,
              low: c.low,
              close: c.close,
              volume: c.volume,
              trades: c.trades ?? null,
            },
            update: {
              assetType: c.assetType,
              open: c.open,
              high: c.high,
              low: c.low,
              close: c.close,
              volume: c.volume,
              trades: c.trades ?? null,
            },
          }),
        ),
      );
      written += batch.length;
    }
    return written;
  } catch (err) {
    log("error", "upsertCandles failed", {
      rows: candles.length,
      written,
      error: errMsg(err),
    });
    throw err;
  }
}

export async function upsertFundingRates(
  prisma: PrismaClient,
  rows: NormalizedFundingRate[],
): Promise<number> {
  if (rows.length === 0) return 0;
  let written = 0;
  try {
    for (const batch of chunk(rows, UPSERT_CHUNK_SIZE)) {
      await prisma.$transaction(
        batch.map((r) =>
          prisma.fundingRate.upsert({
            where: {
              exchange_symbol_ts: {
                exchange: r.exchange,
                symbol: r.symbol,
                ts: r.ts,
              },
            },
            create: {
              exchange: r.exchange,
              symbol: r.symbol,
              ts: r.ts,
              rate: r.rate,
              nextTs: r.nextTs ?? null,
            },
            update: {
              rate: r.rate,
              nextTs: r.nextTs ?? null,
            },
          }),
        ),
      );
      written += batch.length;
    }
    return written;
  } catch (err) {
    log("error", "upsertFundingRates failed", {
      rows: rows.length,
      written,
      error: errMsg(err),
    });
    throw err;
  }
}

interface PreparedOiRow extends NormalizedOpenInterest {
  oiDelta: string | null;
  oiDeltaPct: string | null;
}

/**
 * Upserts OI snapshots, computing oiDelta/oiDeltaPct against the previous
 * stored row per (exchange, symbol), chronologically:
 *  - rows are sorted by ts; the first row of each group is diffed against the
 *    latest prior row already in the DB (single source of truth);
 *  - oiDelta is null when there is no prior row at all;
 *  - oiDeltaPct = oiDelta / prevOI * 100 at 6dp, null when prevOI = 0 or no prior.
 */
export async function upsertOpenInterest(
  prisma: PrismaClient,
  rows: NormalizedOpenInterest[],
): Promise<number> {
  if (rows.length === 0) return 0;
  try {
    const groups = new Map<string, NormalizedOpenInterest[]>();
    for (const row of rows) {
      const key = `${row.exchange}:${row.symbol}`;
      const group = groups.get(key);
      if (group) group.push(row);
      else groups.set(key, [row]);
    }

    const prepared: PreparedOiRow[] = [];
    for (const group of groups.values()) {
      const sorted = [...group].sort((a, b) => a.ts.getTime() - b.ts.getTime());
      const first = sorted[0];
      if (first === undefined) continue;

      const prior = await prisma.openInterestSnapshot.findFirst({
        where: {
          exchange: first.exchange,
          symbol: first.symbol,
          ts: { lt: first.ts },
        },
        orderBy: { ts: "desc" },
      });
      let prev: Prisma.Decimal | null =
        prior === null ? null : new Prisma.Decimal(String(prior.openInterest));

      for (const row of sorted) {
        const current = new Prisma.Decimal(row.openInterest);
        let oiDelta: string | null = null;
        let oiDeltaPct: string | null = null;
        if (prev !== null) {
          const delta = current.minus(prev);
          oiDelta = delta.toFixed();
          oiDeltaPct = prev.isZero() ? null : delta.div(prev).times(100).toFixed(6);
        }
        prepared.push({ ...row, oiDelta, oiDeltaPct });
        prev = current;
      }
    }

    for (const batch of chunk(prepared, UPSERT_CHUNK_SIZE)) {
      await prisma.$transaction(
        batch.map((r) =>
          prisma.openInterestSnapshot.upsert({
            where: {
              exchange_symbol_ts: {
                exchange: r.exchange,
                symbol: r.symbol,
                ts: r.ts,
              },
            },
            create: {
              exchange: r.exchange,
              symbol: r.symbol,
              ts: r.ts,
              openInterest: r.openInterest,
              openInterestValue: r.openInterestValue,
              oiDelta: r.oiDelta,
              oiDeltaPct: r.oiDeltaPct,
            },
            update: {
              openInterest: r.openInterest,
              openInterestValue: r.openInterestValue,
              oiDelta: r.oiDelta,
              oiDeltaPct: r.oiDeltaPct,
            },
          }),
        ),
      );
    }
    return prepared.length;
  } catch (err) {
    log("error", "upsertOpenInterest failed", {
      rows: rows.length,
      error: errMsg(err),
    });
    throw err;
  }
}

export async function upsertLongShortRatios(
  prisma: PrismaClient,
  rows: NormalizedLongShortRatio[],
): Promise<number> {
  if (rows.length === 0) return 0;
  let written = 0;
  try {
    for (const batch of chunk(rows, UPSERT_CHUNK_SIZE)) {
      await prisma.$transaction(
        batch.map((r) =>
          prisma.longShortRatio.upsert({
            where: {
              exchange_symbol_scope_ts: {
                exchange: r.exchange,
                symbol: r.symbol,
                scope: r.scope,
                ts: r.ts,
              },
            },
            create: {
              exchange: r.exchange,
              symbol: r.symbol,
              scope: r.scope,
              ts: r.ts,
              ratio: r.ratio,
              longPct: r.longPct ?? null,
              shortPct: r.shortPct ?? null,
            },
            update: {
              ratio: r.ratio,
              longPct: r.longPct ?? null,
              shortPct: r.shortPct ?? null,
            },
          }),
        ),
      );
      written += batch.length;
    }
    return written;
  } catch (err) {
    log("error", "upsertLongShortRatios failed", {
      rows: rows.length,
      written,
      error: errMsg(err),
    });
    throw err;
  }
}

/**
 * Writes the OptionsChainSnapshot aggregate (contractCount set) plus all
 * OptionContractSnapshot rows; returns the contract count.
 */
export async function upsertOptionChain(
  prisma: PrismaClient,
  chain: NormalizedOptionChain,
): Promise<number> {
  try {
    await prisma.optionsChainSnapshot.upsert({
      where: {
        exchange_underlying_ts: {
          exchange: chain.exchange,
          underlying: chain.underlying,
          ts: chain.ts,
        },
      },
      create: {
        exchange: chain.exchange,
        underlying: chain.underlying,
        ts: chain.ts,
        spot: chain.spot,
        ivAtm30d: chain.ivAtm30d ?? null,
        skew25d: chain.skew25d ?? null,
        putCallRatio: chain.putCallRatio ?? null,
        totalGammaExposure: chain.totalGammaExposure ?? null,
        termStructure: chain.termStructure ?? Prisma.DbNull,
        contractCount: chain.contracts.length,
      },
      update: {
        spot: chain.spot,
        ivAtm30d: chain.ivAtm30d ?? null,
        skew25d: chain.skew25d ?? null,
        putCallRatio: chain.putCallRatio ?? null,
        totalGammaExposure: chain.totalGammaExposure ?? null,
        termStructure: chain.termStructure ?? Prisma.DbNull,
        contractCount: chain.contracts.length,
      },
    });

    for (const batch of chunk(chain.contracts, UPSERT_CHUNK_SIZE)) {
      await prisma.$transaction(
        batch.map((c) =>
          prisma.optionContractSnapshot.upsert({
            where: {
              exchange_underlying_ts_expiry_strike_optionType: {
                exchange: c.exchange,
                underlying: c.underlying,
                ts: c.ts,
                expiry: c.expiry,
                strike: c.strike,
                optionType: c.optionType,
              },
            },
            create: {
              exchange: c.exchange,
              underlying: c.underlying,
              ts: c.ts,
              expiry: c.expiry,
              strike: c.strike,
              optionType: c.optionType,
              iv: c.iv ?? null,
              delta: c.delta ?? null,
              gamma: c.gamma ?? null,
              theta: c.theta ?? null,
              vega: c.vega ?? null,
              openInterest: c.openInterest ?? null,
              volume: c.volume ?? null,
              bid: c.bid ?? null,
              ask: c.ask ?? null,
              markPrice: c.markPrice ?? null,
            },
            update: {
              iv: c.iv ?? null,
              delta: c.delta ?? null,
              gamma: c.gamma ?? null,
              theta: c.theta ?? null,
              vega: c.vega ?? null,
              openInterest: c.openInterest ?? null,
              volume: c.volume ?? null,
              bid: c.bid ?? null,
              ask: c.ask ?? null,
              markPrice: c.markPrice ?? null,
            },
          }),
        ),
      );
    }
    return chain.contracts.length;
  } catch (err) {
    log("error", "upsertOptionChain failed", {
      exchange: chain.exchange,
      underlying: chain.underlying,
      ts: chain.ts.toISOString(),
      contracts: chain.contracts.length,
      error: errMsg(err),
    });
    throw err;
  }
}

export async function upsertLiquidity(
  prisma: PrismaClient,
  row: NormalizedLiquidity,
): Promise<number> {
  try {
    await prisma.liquiditySnapshot.upsert({
      where: {
        exchange_symbol_ts: {
          exchange: row.exchange,
          symbol: row.symbol,
          ts: row.ts,
        },
      },
      create: {
        exchange: row.exchange,
        symbol: row.symbol,
        ts: row.ts,
        bidDepthUsd: row.bidDepthUsd,
        askDepthUsd: row.askDepthUsd,
        spreadBps: row.spreadBps,
      },
      update: {
        bidDepthUsd: row.bidDepthUsd,
        askDepthUsd: row.askDepthUsd,
        spreadBps: row.spreadBps,
      },
    });
    return 1;
  } catch (err) {
    log("error", "upsertLiquidity failed", {
      exchange: row.exchange,
      symbol: row.symbol,
      ts: row.ts.toISOString(),
      error: errMsg(err),
    });
    throw err;
  }
}

/**
 * Writes one JobRun row per call (job names like "connector:DERIBIT",
 * "backfill:DEMO", "features:compute"). Telemetry only: failures are logged
 * and swallowed — a broken heartbeat must never take the pipeline down.
 */
export async function heartbeat(
  prisma: PrismaClient,
  job: string,
  status: "RUNNING" | "OK" | "FAILED",
  detail?: object,
): Promise<void> {
  try {
    await prisma.jobRun.create({
      data: {
        job,
        status,
        endedAt: status === "RUNNING" ? null : new Date(),
        detail:
          detail === undefined ? Prisma.DbNull : (detail as Prisma.InputJsonValue),
      },
    });
  } catch (err) {
    log("error", "heartbeat write failed", { job, status, error: errMsg(err) });
  }
}
