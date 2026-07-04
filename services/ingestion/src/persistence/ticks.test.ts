/**
 * Phase 9 persistence — failure-injection + idempotency contracts (DB-free).
 *
 * Proves the fail-closed / replay-safe guarantees the live feed depends on:
 *  - idempotent under reconnect: ticks insert with skipDuplicates on the (exchange,
 *    symbol, ts, tradeId) PK, so a reconnect replay never duplicates;
 *  - ordering-independent: the deterministic PK means input order does not change
 *    the set of writes (orderbook upserts key on (exchange, symbol, ts));
 *  - DB failure is rethrown (fail-closed) — never swallowed.
 */

import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@nexus/db";
import { upsertOrderbookSnapshots, upsertTicks } from "./ticks.js";
import type { NormalizedQuote, NormalizedTick } from "../connectors/types.js";

function tick(over: Partial<NormalizedTick> = {}): NormalizedTick {
  return {
    exchange: "DERIBIT",
    symbol: "BTC-PERP",
    ts: new Date("2026-06-22T00:00:00.000Z"),
    tradeId: "t-1",
    price: "30000",
    size: "0.5",
    side: "BUY",
    ...over,
  };
}

function quote(over: Partial<NormalizedQuote> = {}): NormalizedQuote {
  return {
    exchange: "DERIBIT",
    symbol: "BTC-PERP",
    ts: new Date("2026-06-22T00:00:00.000Z"),
    bestBid: "29999",
    bestAsk: "30001",
    bestBidSize: "1",
    bestAskSize: "1",
    markPrice: "30000",
    spreadBps: "0.6667",
    ...over,
  };
}

describe("upsertTicks (idempotent under reconnect)", () => {
  it("inserts with skipDuplicates on the deterministic PK (no dup under replay)", async () => {
    const createMany = vi.fn(async (args: { data: unknown[] }) => ({ count: args.data.length }));
    const prisma = { marketTick: { createMany } } as unknown as PrismaClient;

    const batch = [tick({ tradeId: "a" }), tick({ tradeId: "b" })];
    const n1 = await upsertTicks(prisma, batch);
    expect(n1).toBe(2);
    // A reconnect replays the SAME batch — the DB PK + skipDuplicates collapse it.
    const call = createMany.mock.calls[0]?.[0] as { skipDuplicates: boolean; data: unknown[] };
    expect(call.skipDuplicates).toBe(true);
    expect(call.data).toHaveLength(2);
  });

  it("is ordering-independent: the same set of rows writes regardless of input order", async () => {
    const seen: string[][] = [];
    const createMany = vi.fn(async (args: { data: Array<{ tradeId: string }> }) => {
      seen.push(args.data.map((d) => d.tradeId).sort());
      return { count: args.data.length };
    });
    const prisma = { marketTick: { createMany } } as unknown as PrismaClient;

    await upsertTicks(prisma, [tick({ tradeId: "a" }), tick({ tradeId: "b" })]);
    await upsertTicks(prisma, [tick({ tradeId: "b" }), tick({ tradeId: "a" })]);
    expect(seen[0]).toEqual(seen[1]); // same key set, order-independent
  });

  it("rethrows on a DB failure (fail-closed, never swallowed)", async () => {
    const createMany = vi.fn(async () => {
      throw new Error("connection reset");
    });
    const prisma = { marketTick: { createMany } } as unknown as PrismaClient;
    await expect(upsertTicks(prisma, [tick()])).rejects.toThrow("connection reset");
  });

  it("returns 0 for an empty batch without touching the DB", async () => {
    const createMany = vi.fn();
    const prisma = { marketTick: { createMany } } as unknown as PrismaClient;
    expect(await upsertTicks(prisma, [])).toBe(0);
    expect(createMany).not.toHaveBeenCalled();
  });
});

describe("upsertOrderbookSnapshots (same-ts re-sample overwrites, fail-closed)", () => {
  it("upserts on the deterministic (exchange, symbol, ts) PK", async () => {
    const upsert = vi.fn(async () => ({}));
    const prisma = {
      $transaction: (arr: Array<Promise<unknown>>) => Promise.all(arr),
      orderbookSnapshot: { upsert },
    } as unknown as PrismaClient;

    await upsertOrderbookSnapshots(prisma, [quote()]);
    const call = upsert.mock.calls[0]?.[0] as { where: { exchange_symbol_ts: Record<string, unknown> } };
    expect(call.where.exchange_symbol_ts).toEqual({
      exchange: "DERIBIT",
      symbol: "BTC-PERP",
      ts: new Date("2026-06-22T00:00:00.000Z"),
    });
  });

  it("rethrows on a DB failure (fail-closed)", async () => {
    const prisma = {
      $transaction: () => {
        throw new Error("deadlock detected");
      },
      orderbookSnapshot: { upsert: vi.fn() },
    } as unknown as PrismaClient;
    await expect(upsertOrderbookSnapshots(prisma, [quote()])).rejects.toThrow("deadlock detected");
  });
});
