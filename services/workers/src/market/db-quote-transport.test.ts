/**
 * DbQuoteTransport — fail-closed on stale marks (Phase 9 review fix).
 * Proves a fresh mark is served, but a stale feed (ingestion disconnect) ages
 * the mark out so latest() returns null → execution fails closed (no order).
 */

import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@nexus/db";
import { DbQuoteTransport } from "./db-quote-transport.js";

function prismaWith(ob: unknown, tick: unknown = null, candle: unknown = null): PrismaClient {
  return {
    orderbookSnapshot: { findFirst: vi.fn(async () => ob) },
    marketTick: { findFirst: vi.fn(async () => tick) },
    marketCandle: { findFirst: vi.fn(async () => candle) },
  } as unknown as PrismaClient;
}

describe("DbQuoteTransport freshness (fail-closed on disconnect)", () => {
  it("serves a fresh orderbook mark", async () => {
    const ob = { ts: new Date(), markPrice: "30000", bestBid: "29999", bestAsk: "30001" };
    const t = new DbQuoteTransport(prismaWith(ob), { symbols: ["BTC-PERP"], maxAgeMs: 60_000 });
    await t.refresh();
    const q = t.latest("BTC-PERP");
    expect(q).not.toBeNull();
    expect(q?.price).toBe("30000.00000000");
  });

  it("returns null when the only mark is older than maxAgeMs (stale feed)", async () => {
    const stale = { ts: new Date(Date.now() - 10 * 60_000), markPrice: "30000", bestBid: "29999", bestAsk: "30001" };
    const t = new DbQuoteTransport(prismaWith(stale), { symbols: ["BTC-PERP"], maxAgeMs: 60_000 });
    await t.refresh();
    expect(t.latest("BTC-PERP")).toBeNull();
  });

  it("CLEARS a previously-fresh mark once the feed goes stale (no silent stale price)", async () => {
    const fresh = { ts: new Date(), markPrice: "30000", bestBid: "29999", bestAsk: "30001" };
    const prisma = prismaWith(fresh);
    const t = new DbQuoteTransport(prisma, { symbols: ["BTC-PERP"], maxAgeMs: 60_000 });
    await t.refresh();
    expect(t.latest("BTC-PERP")).not.toBeNull();

    // Feed disconnects: now only a stale row remains.
    (prisma.orderbookSnapshot.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({
      ts: new Date(Date.now() - 5 * 60_000),
      markPrice: "30000",
      bestBid: "29999",
      bestAsk: "30001",
    });
    await t.refresh();
    expect(t.latest("BTC-PERP")).toBeNull(); // cleared, not served stale
  });

  it("returns null at cold start (nothing known yet)", async () => {
    const t = new DbQuoteTransport(prismaWith(null), { symbols: ["BTC-PERP"] });
    await t.refresh();
    expect(t.latest("BTC-PERP")).toBeNull();
  });

  it("EXCLUDES the legacy synthetic DEMO venue from every mark query, unconditionally", async () => {
    const prisma = prismaWith(null);
    const t = new DbQuoteTransport(prisma, { symbols: ["BTC-PERP"] });
    await t.refresh();
    for (const model of ["orderbookSnapshot", "marketTick", "marketCandle"] as const) {
      const call = (prisma[model].findFirst as ReturnType<typeof vi.fn>).mock.calls[0]![0] as {
        where: Record<string, unknown>;
      };
      expect(call.where).toEqual({ symbol: "BTC-PERP", exchange: { not: "DEMO" } });
    }
    // There is no opt-in to admit synthetic venues — the option no longer exists.
    expect("allowDemoVenue" in t).toBe(false);
  });
});
