/**
 * Real-time quote transport backed by the persisted market feed (Phase 9).
 *
 * The Phase 7 `RealtimeProvider` is pure-by-construction: the live edge lives in
 * an injected transport, and the provider only reads the latest cached mark
 * synchronously. This transport is that edge — it polls the DB (the rows the
 * ingestion daemon persists from the real exchange) on an interval and caches the
 * latest mark per symbol, served synchronously to the provider.
 *
 * Mark source (first FRESH source wins): OrderbookSnapshot.markPrice → mid(bestBid,
 * bestAsk) → latest MarketTick.price → latest MarketCandle.close.
 *
 * FAIL-CLOSED on staleness: every candidate row is age-checked against `maxAgeMs`.
 * A source older than that is treated as ABSENT, and when no fresh source exists
 * the cache entry is CLEARED so `latest()` returns null — the execution stage then
 * fails closed (no mark → no order). This covers both cold start (nothing known
 * yet) AND the disconnect-while-warm case: if the ingestion daemon dies, no fresh
 * rows are written, the last-known mark ages out, and execution stops marking
 * against a silently stale price (rather than trading on it indefinitely).
 *
 * OPT-IN / default-off: the worker constructs this only under
 * MARKET_DATA_SOURCE=realtime; with no source configured execution stays
 * unarmed (fail-closed) — there is no synthetic default.
 *
 * VENUE FILTER (zero-synthetic discipline): legacy DEMO-venue rows are synthetic
 * fixtures written into the SAME market tables as live venues by old builds.
 * They are excluded from every mark query UNCONDITIONALLY — a synthetic candle
 * must never become the price real orders are sized against.
 */

import type { PrismaClient } from "@nexus/db";
import { quantizePrice } from "./money.js";
import type { RealtimeQuoteTransport } from "./market-data.js";
import type { Quote } from "./types.js";

const DEFAULT_SYMBOLS = ["BTC-PERP", "ETH-PERP"];
const DEFAULT_POLL_MS = 2_000;
/**
 * A mark older than this is treated as ABSENT (fail-closed on a dead/lagging
 * feed). Generous enough not to flap during normal live operation — orderbook /
 * tick rows arrive every few seconds — but tight enough that an ingestion
 * disconnect ages the last-known mark out within a minute.
 */
const DEFAULT_MAX_AGE_MS = 60_000;

export interface DbQuoteTransportOptions {
  /** Symbols to keep a live mark for (default BTC-PERP, ETH-PERP). */
  symbols?: string[];
  /** Poll cadence in ms (default 2000). */
  pollMs?: number;
  /** Max mark age before a source is treated as stale/absent (default 60000). */
  maxAgeMs?: number;
}

export class DbQuoteTransport implements RealtimeQuoteTransport {
  private readonly cache = new Map<string, Quote>();
  private readonly symbols: string[];
  private readonly pollMs: number;
  private readonly maxAgeMs: number;
  /**
   * Prisma where-clause fragment excluding the legacy synthetic DEMO venue —
   * UNCONDITIONAL defense-in-depth: nothing writes DEMO rows anymore, but a
   * pre-existing database must never surface one as a production mark.
   */
  private readonly venueFilter = { exchange: { not: "DEMO" } } as const;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly prisma: PrismaClient,
    opts: DbQuoteTransportOptions = {},
  ) {
    this.symbols = opts.symbols ?? DEFAULT_SYMBOLS;
    this.pollMs = opts.pollMs ?? DEFAULT_POLL_MS;
    this.maxAgeMs = opts.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
  }

  latest(symbol: string): Quote | null {
    return this.cache.get(symbol) ?? null;
  }

  /**
   * One poll of every tracked symbol — caches the freshest mark, or CLEARS the
   * entry when no fresh source exists (fail-closed: a stale feed yields null).
   */
  async refresh(): Promise<void> {
    for (const symbol of this.symbols) {
      const quote = await this.markFor(symbol);
      if (quote !== null) this.cache.set(symbol, quote);
      else this.cache.delete(symbol);
    }
  }

  private async markFor(symbol: string): Promise<Quote | null> {
    // Live edge: a clock IS appropriate here (this is the effectful transport,
    // not a deterministic path). A source is usable only if fresh enough.
    const now = Date.now();
    const fresh = (ts: Date): boolean => now - ts.getTime() <= this.maxAgeMs;

    const ob = await this.prisma.orderbookSnapshot.findFirst({
      where: { symbol, ...this.venueFilter },
      orderBy: { ts: "desc" },
    });
    if (ob !== null && fresh(ob.ts)) {
      const mark =
        ob.markPrice !== null
          ? Number(ob.markPrice)
          : (Number(ob.bestBid) + Number(ob.bestAsk)) / 2;
      if (Number.isFinite(mark) && mark > 0) {
        return { symbol, ts: ob.ts.toISOString(), price: quantizePrice(mark) };
      }
    }
    const tick = await this.prisma.marketTick.findFirst({
      where: { symbol, ...this.venueFilter },
      orderBy: { ts: "desc" },
    });
    if (tick !== null && fresh(tick.ts)) {
      // Same finite-positive admission as the orderbook branch (Phase 11C GAP C):
      // a corrupt/zero Decimal is never a mark — fall through to the next source.
      const price = Number(tick.price);
      if (Number.isFinite(price) && price > 0) {
        return { symbol, ts: tick.ts.toISOString(), price: quantizePrice(price) };
      }
    }
    const candle = await this.prisma.marketCandle.findFirst({
      where: { symbol, ...this.venueFilter },
      orderBy: { ts: "desc" },
    });
    if (candle !== null && fresh(candle.ts)) {
      const close = Number(candle.close);
      if (Number.isFinite(close) && close > 0) {
        return { symbol, ts: candle.ts.toISOString(), price: quantizePrice(close) };
      }
    }
    return null;
  }

  /** Begin polling (fire one refresh immediately so a mark is available soon). */
  start(): void {
    if (this.timer !== undefined) return;
    void this.refresh().catch(() => undefined);
    this.timer = setInterval(() => void this.refresh().catch(() => undefined), this.pollMs);
    // Don't hold the event loop open on this poller alone.
    if (typeof this.timer.unref === "function") this.timer.unref();
  }

  stop(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }
}
