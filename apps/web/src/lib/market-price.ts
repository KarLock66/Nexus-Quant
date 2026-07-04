import { prisma } from "@nexus/db";
import type { LiquidityObservation, PriceObservation } from "@nexus/trading-decision";

/**
 * Server-only current-mark + liquidity reader for the Trading Decision engine.
 *
 * Replicates the SEALED worker DbQuoteTransport contract (services/workers/src/market/
 * db-quote-transport.ts) against Prisma: a current price is the freshest of, in priority
 * order, OrderbookSnapshot.markPrice → mid(bestBid,bestAsk) → MarketTick.price →
 * MarketCandle.close, and ANY source older than `maxAgeMs` (default 60s) is treated as
 * ABSENT — a stale/empty feed yields null (FAIL-CLOSED: no fresh mark → no price-derived
 * decision fields). The worker transport is a stateful poller; the web tier replicates
 * only its priority + freshness rule with one-shot reads.
 */

const DEFAULT_MAX_AGE_MS = 60_000;

/**
 * DEMO-venue rows are synthetic (seeded-PRNG connector / fixtures). They are
 * EXCLUDED from the mark unless the deployment explicitly opts into demo mode
 * (the platform-wide DEMO_MODE flag): a fresh synthetic candle must never become
 * the price a real trading decision is sized against. Fail-closed default.
 */
const DEMO_VENUE_ALLOWED = ["true", "1", "yes"].includes(
  (process.env.DEMO_MODE ?? "").trim().toLowerCase(),
);
const VENUE_FILTER = DEMO_VENUE_ALLOWED ? {} : ({ exchange: { not: "DEMO" } } as const);

export interface MarketView {
  price: PriceObservation | null;
  liquidity: LiquidityObservation | null;
}

function num(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

const fresh = (ts: Date | null | undefined, nowMs: number, maxAgeMs: number): boolean =>
  ts != null && nowMs - ts.getTime() <= maxAgeMs;

export async function getMarketView(
  symbol: string,
  nowMs: number,
  maxAgeMs: number = DEFAULT_MAX_AGE_MS,
): Promise<MarketView> {
  let book: Awaited<ReturnType<typeof prisma.orderbookSnapshot.findFirst>> = null;
  let tick: Awaited<ReturnType<typeof prisma.marketTick.findFirst>> = null;
  let candle: Awaited<ReturnType<typeof prisma.marketCandle.findFirst>> = null;
  let liq: Awaited<ReturnType<typeof prisma.liquiditySnapshot.findFirst>> = null;
  try {
    [book, tick, candle, liq] = await Promise.all([
      prisma.orderbookSnapshot.findFirst({ where: { symbol, ...VENUE_FILTER }, orderBy: { ts: "desc" } }),
      prisma.marketTick.findFirst({ where: { symbol, ...VENUE_FILTER }, orderBy: { ts: "desc" } }),
      prisma.marketCandle.findFirst({ where: { symbol, ...VENUE_FILTER }, orderBy: { ts: "desc" } }),
      prisma.liquiditySnapshot.findFirst({ where: { symbol, ...VENUE_FILTER }, orderBy: { ts: "desc" } }),
    ]);
  } catch {
    // DB read failure → fail closed (no price).
    return { price: null, liquidity: null };
  }

  // ── current mark (priority + freshness) ──
  let price: PriceObservation | null = null;
  const bookFresh = fresh(book?.ts, nowMs, maxAgeMs);
  const bestBid = book ? num(book.bestBid) : null;
  const bestAsk = book ? num(book.bestAsk) : null;
  const mid = bestBid !== null && bestAsk !== null ? (bestBid + bestAsk) / 2 : null;

  // Positivity guards mirror the sealed DbQuoteTransport: a non-positive mark is
  // treated as absent and we fall through to the next source (fail-closed).
  const markPrice = book ? num(book.markPrice) : null;
  if (bookFresh && markPrice !== null && markPrice > 0 && book) {
    price = { price: markPrice, ts: book.ts.toISOString(), source: "orderbook.markPrice" };
  } else if (bookFresh && mid !== null && mid > 0 && book) {
    price = { price: mid, ts: book.ts.toISOString(), source: "orderbook.mid" };
  } else if (fresh(tick?.ts, nowMs, maxAgeMs) && tick) {
    const p = num(tick.price);
    if (p !== null && p > 0) price = { price: p, ts: tick.ts.toISOString(), source: "tick" };
  }
  if (price === null && fresh(candle?.ts, nowMs, maxAgeMs) && candle) {
    const c = num(candle.close);
    if (c !== null && c > 0) price = { price: c, ts: candle.ts.toISOString(), source: "candle.close" };
  }

  // ── liquidity (LiquiditySnapshot preferred; else top-of-book depth) ──
  let liquidity: LiquidityObservation | null = null;
  if (fresh(liq?.ts, nowMs, maxAgeMs) && liq) {
    const bid = num(liq.bidDepthUsd);
    const ask = num(liq.askDepthUsd);
    liquidity = {
      spreadBps: num(liq.spreadBps),
      depthUsd: bid !== null && ask !== null ? bid + ask : null,
      ts: liq.ts.toISOString(),
    };
  } else if (bookFresh && book) {
    const bidSz = num(book.bestBidSize);
    const askSz = num(book.bestAskSize);
    const refMid = mid ?? markPrice;
    const depthUsd =
      bidSz !== null && askSz !== null && refMid !== null ? (bidSz + askSz) * refMid : null;
    liquidity = { spreadBps: num(book.spreadBps), depthUsd, ts: book.ts.toISOString() };
  }

  return { price, liquidity };
}
