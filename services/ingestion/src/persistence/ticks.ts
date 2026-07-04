/**
 * Phase 9 persistence — live WebSocket feed rows (raw ticks + top-of-book/mark
 * snapshots). Same discipline as persistence/index.ts:
 *  - idempotent on the table's composite PK (re-ingest never duplicates);
 *  - all market numerics arrive as decimal strings, handed to Prisma unchanged;
 *  - writes are batched; failures are logged with structure and rethrown
 *    (fail-closed).
 */

import { Prisma } from "@nexus/db";
import type { PrismaClient } from "@nexus/db";
import type { NormalizedQuote, NormalizedTick } from "../connectors/types.js";
import { log } from "../lib/log.js";
import { chunk, errMsg } from "./util.js";

export const TICK_CHUNK_SIZE = 1_000;
export const ORDERBOOK_CHUNK_SIZE = 500;

/**
 * Inserts trade prints. Ticks are immutable, so this uses createMany with
 * skipDuplicates — re-ingesting a window (restart recovery) silently skips the
 * rows already present (idempotent) instead of erroring on the PK. Returns the
 * number of NEW rows inserted.
 */
export async function upsertTicks(
  prisma: PrismaClient,
  ticks: NormalizedTick[],
): Promise<number> {
  if (ticks.length === 0) return 0;
  let inserted = 0;
  try {
    for (const batch of chunk(ticks, TICK_CHUNK_SIZE)) {
      const res = await prisma.marketTick.createMany({
        data: batch.map((t) => ({
          exchange: t.exchange,
          symbol: t.symbol,
          ts: t.ts,
          tradeId: t.tradeId,
          price: t.price,
          size: t.size,
          side: t.side,
        })),
        skipDuplicates: true,
      });
      inserted += res.count;
    }
    return inserted;
  } catch (err) {
    log("error", "upsertTicks failed", { rows: ticks.length, inserted, error: errMsg(err) });
    throw err;
  }
}

const jsonOrNull = (v: unknown): Prisma.InputJsonValue | typeof Prisma.DbNull =>
  v === undefined || v === null ? Prisma.DbNull : (v as Prisma.InputJsonValue);

/**
 * Upserts top-of-book/mark snapshots on (exchange, symbol, ts) — a same-ts
 * re-sample overwrites rather than duplicating. Optional top-N depth is stored
 * verbatim as JSON.
 */
export async function upsertOrderbookSnapshots(
  prisma: PrismaClient,
  quotes: NormalizedQuote[],
): Promise<number> {
  if (quotes.length === 0) return 0;
  let written = 0;
  try {
    for (const batch of chunk(quotes, ORDERBOOK_CHUNK_SIZE)) {
      await prisma.$transaction(
        batch.map((q) =>
          prisma.orderbookSnapshot.upsert({
            where: {
              exchange_symbol_ts: { exchange: q.exchange, symbol: q.symbol, ts: q.ts },
            },
            create: {
              exchange: q.exchange,
              symbol: q.symbol,
              ts: q.ts,
              bestBid: q.bestBid,
              bestAsk: q.bestAsk,
              bestBidSize: q.bestBidSize,
              bestAskSize: q.bestAskSize,
              markPrice: q.markPrice ?? null,
              spreadBps: q.spreadBps ?? null,
              bids: jsonOrNull(q.bids),
              asks: jsonOrNull(q.asks),
            },
            update: {
              bestBid: q.bestBid,
              bestAsk: q.bestAsk,
              bestBidSize: q.bestBidSize,
              bestAskSize: q.bestAskSize,
              markPrice: q.markPrice ?? null,
              spreadBps: q.spreadBps ?? null,
              bids: jsonOrNull(q.bids),
              asks: jsonOrNull(q.asks),
            },
          }),
        ),
      );
      written += batch.length;
    }
    return written;
  } catch (err) {
    log("error", "upsertOrderbookSnapshots failed", {
      rows: quotes.length,
      written,
      error: errMsg(err),
    });
    throw err;
  }
}
