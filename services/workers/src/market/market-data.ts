/**
 * Market data abstraction (Phase 6).
 *
 * A MarketDataProvider supplies the deterministic reference price the market layer
 * sizes orders against and marks positions to. It is decoupled from the broker
 * (no broker coupling) and offers point-in-time "as-of" semantics so a replay
 * sees exactly the price the original run saw.
 *
 *   HistoricalProvider — deterministic as-of lookup over a fixed quote store. The
 *                        default for the verified path (the "paper"-equivalent).
 *   ReplayProvider     — deterministic as-of lookup over a recorded quote LOG
 *                        (replays exactly what was recorded). Replay-equivalent.
 *   RealtimeProvider   — INTERFACE-ONLY effectful edge: quote() throws (no live
 *                        feed wired), so it can never inject a clock/network into
 *                        the deterministic path — exactly like RealExecutionAdapter
 *                        and (Phase 6) RealBroker. The stage treats a provider
 *                        throw as "no price -> fail-closed".
 *
 * All concrete providers here are PURE: no clock, no randomness, no IO.
 */

import { quantizePrice } from "./money.js";
import type { ProviderMode, Quote } from "./types.js";

export interface MarketDataProvider {
  /** Source taxonomy: deterministic (historical/replay) vs live edge (realtime). */
  readonly mode: ProviderMode;
  /**
   * The as-of quote for `symbol`: the latest quote whose ts is <= `asOf`, or the
   * latest quote overall when `asOf` is omitted. Returns null when no quote is
   * known for the symbol (the caller fails closed — no price, no execution).
   */
  quote(symbol: string, asOf?: string): Quote | null;
}

/** Normalize a quote's price to the canonical 8dp string (idempotent). */
function normalize(q: Quote): Quote {
  return { symbol: q.symbol, ts: q.ts, price: quantizePrice(Number(q.price)) };
}

/**
 * Deterministic as-of lookup over a per-symbol series. Series are sorted by (ts,
 * price) on construction so the lookup is stable regardless of input order; ties
 * on ts resolve by price then by original index for byte-stable determinism.
 */
function buildStore(quotes: Quote[]): Map<string, Quote[]> {
  const bySymbol = new Map<string, Quote[]>();
  for (const raw of quotes) {
    const q = normalize(raw);
    const list = bySymbol.get(q.symbol);
    if (list) list.push(q);
    else bySymbol.set(q.symbol, [q]);
  }
  for (const list of bySymbol.values()) {
    list.sort((a, b) => a.ts.localeCompare(b.ts) || a.price.localeCompare(b.price));
  }
  return bySymbol;
}

function asOfLookup(
  store: Map<string, Quote[]>,
  symbol: string,
  asOf?: string,
): Quote | null {
  const list = store.get(symbol);
  if (list === undefined || list.length === 0) return null;
  if (asOf === undefined) return list[list.length - 1]!;
  // Latest quote at or before asOf (linear scan from the end; series are small and
  // this stays allocation-free and obviously deterministic).
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const q = list[i]!;
    if (q.ts <= asOf) return q;
  }
  return null;
}

/** Deterministic as-of provider over a fixed quote store (the default). */
export class HistoricalProvider implements MarketDataProvider {
  readonly mode: ProviderMode = "historical";
  private readonly store: Map<string, Quote[]>;

  constructor(quotes: Quote[]) {
    this.store = buildStore(quotes);
  }

  quote(symbol: string, asOf?: string): Quote | null {
    return asOfLookup(this.store, symbol, asOf);
  }
}

/**
 * Deterministic provider that replays a recorded quote LOG. Behaviourally an
 * as-of lookup (same input -> same output), but framed as replaying exactly the
 * recorded stream — so a replay run reconstructs the original prices verbatim.
 */
export class ReplayProvider implements MarketDataProvider {
  readonly mode: ProviderMode = "replay";
  private readonly store: Map<string, Quote[]>;

  constructor(recordedLog: Quote[]) {
    this.store = buildStore(recordedLog);
  }

  quote(symbol: string, asOf?: string): Quote | null {
    return asOfLookup(this.store, symbol, asOf);
  }
}

/**
 * A push feed of live quotes (WebSocket, FIX, vendor SDK, ...), injected into the
 * RealtimeProvider so the provider stays pure-by-construction: the transport owns
 * the clock/network/IO, the provider only reads the latest cached mark. `latest`
 * is non-blocking — it returns the most recent quote the transport has buffered
 * for `symbol`, or null if none has arrived yet (the caller fails closed on null).
 */
export interface RealtimeQuoteTransport {
  /** Most recent quote buffered for `symbol`, or null if none seen yet. */
  latest(symbol: string): Quote | null;
}

/**
 * Real-time market data (Phase 7) — a REAL, wireable provider behind the unchanged
 * MarketDataProvider abstraction, with the live edge isolated in an injected
 * transport (so determinism is never injected with a clock/network: the
 * deterministic path uses the historical/replay providers and never constructs
 * this with a transport). DEFAULT-OFF: constructed with NO transport it stays
 * interface-only and quote() throws, exactly as in Phase 6 — the stage converts
 * that throw into a fail-closed "no price" outcome, so even an accidental wiring
 * can never size an order against a missing mark.
 */
export class RealtimeProvider implements MarketDataProvider {
  readonly mode: ProviderMode = "realtime";

  constructor(private readonly transport?: RealtimeQuoteTransport) {}

  quote(symbol: string, _asOf?: string): Quote | null {
    if (this.transport === undefined) {
      throw new Error(
        "RealtimeProvider is interface-only — no live market-data feed transport is wired",
      );
    }
    const q = this.transport.latest(symbol);
    return q === null ? null : normalize(q);
  }
}

/**
 * Deterministic demo quotes for the runtime-continuity chain (BTC-PERP, ETH-PERP),
 * aligned to the demo FeatureSnapshot timestamp. Fixed values -> the market layer
 * is deterministic for the demo lineage without coupling to feature internals
 * (features carry EMAs/RSI/vol, not a clean spot price).
 */
export const DEMO_QUOTES: Quote[] = [
  { symbol: "BTC-PERP", ts: "2026-06-01T00:00:00.000Z", price: quantizePrice(30000) },
  { symbol: "ETH-PERP", ts: "2026-06-01T00:00:00.000Z", price: quantizePrice(1850) },
];

/** A ready-made deterministic provider over the demo quotes. */
export function demoMarketDataProvider(): MarketDataProvider {
  return new HistoricalProvider(DEMO_QUOTES);
}
