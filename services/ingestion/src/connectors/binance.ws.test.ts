/**
 * Binance live-stream failure injection — malformed ticks are dropped fail-closed.
 * The `ws` module is mocked with a controllable fake socket so we can feed exact
 * frames and assert the handler never emits garbage or throws.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { createBinanceConnector } from "./binance.js";
import type { NormalizedQuote, NormalizedTick } from "./types.js";

const wsState = vi.hoisted(() => ({ instances: [] as Array<{ fire: (ev: string, ...a: unknown[]) => void }> }));

vi.mock("ws", () => {
  class FakeWS {
    static OPEN = 1;
    readyState = 1;
    private handlers: Record<string, Array<(...a: unknown[]) => void>> = {};
    constructor(public url: string) {
      wsState.instances.push(this as unknown as { fire: (ev: string, ...a: unknown[]) => void });
      setTimeout(() => this.fire("open"), 0);
    }
    on(ev: string, cb: (...a: unknown[]) => void): this {
      (this.handlers[ev] ??= []).push(cb);
      return this;
    }
    fire(ev: string, ...args: unknown[]): void {
      for (const cb of this.handlers[ev] ?? []) cb(...args);
    }
    send(): void {}
    close(): void {
      this.fire("close", 1000);
    }
    removeAllListeners(ev?: string): void {
      if (ev) delete this.handlers[ev];
      else this.handlers = {};
    }
  }
  return { default: FakeWS, WebSocket: FakeWS };
});

function frame(data: Record<string, unknown>): string {
  return JSON.stringify({ stream: "btcusdt@aggTrade", data });
}

afterEach(() => {
  wsState.instances.length = 0;
  vi.restoreAllMocks();
});

describe("binance streamLive — malformed tick fail-closed", () => {
  it("drops malformed aggTrade frames but emits valid ones (no crash)", async () => {
    const ticks: NormalizedTick[] = [];
    const errors: Error[] = [];
    const c = createBinanceConnector();
    const sub = await c.streamLive(
      { symbols: [{ symbol: "BTC-PERP", assetType: "PERP" }], timeframe: "H1" },
      { onTrade: (t) => ticks.push(t), onError: (e) => errors.push(e) },
    );
    const ws = wsState.instances[0]!;

    // Non-numeric price → dropped.
    ws.fire("message", frame({ e: "aggTrade", s: "BTCUSDT", a: 1, p: "not-a-number", q: "1", T: 1, m: false }));
    // Missing fields → dropped.
    ws.fire("message", frame({ e: "aggTrade", s: "BTCUSDT", a: 2 }));
    // Unknown symbol → dropped.
    ws.fire("message", frame({ e: "aggTrade", s: "DOGEUSDT", a: 3, p: "1", q: "1", T: 1, m: false }));
    // Not even JSON → dropped, no throw.
    ws.fire("message", "}{ broken");
    // Valid → emitted.
    ws.fire("message", frame({ e: "aggTrade", s: "BTCUSDT", a: 4, p: "30000.5", q: "0.25", T: 1717000000000, m: true }));

    expect(ticks).toHaveLength(1);
    expect(ticks[0]).toMatchObject({
      exchange: "BINANCE",
      symbol: "BTC-PERP",
      tradeId: "4",
      price: "30000.5",
      size: "0.25",
      side: "SELL", // m=true => buyer is maker => taker SOLD
    });
    expect(errors).toHaveLength(0);
    await sub.close();
  });

  it("drops malformed bookTicker frames, emits valid quotes", async () => {
    const quotes: NormalizedQuote[] = [];
    const c = createBinanceConnector();
    const sub = await c.streamLive(
      { symbols: [{ symbol: "BTC-PERP", assetType: "PERP" }], timeframe: "H1" },
      { onQuote: (q) => quotes.push(q) },
    );
    const ws = wsState.instances[0]!;

    // Crossed book (ask < bid) → dropped.
    ws.fire("message", JSON.stringify({ stream: "btcusdt@bookTicker", data: { e: "bookTicker", s: "BTCUSDT", b: "30010", B: "1", a: "30000", A: "1", T: 1 } }));
    // Missing venue ts (T/E) → dropped (ts is a PK component; never fabricate a clock).
    ws.fire("message", JSON.stringify({ stream: "btcusdt@bookTicker", data: { e: "bookTicker", s: "BTCUSDT", b: "29999", B: "2", a: "30001", A: "3" } }));
    // Valid → emitted.
    ws.fire("message", JSON.stringify({ stream: "btcusdt@bookTicker", data: { e: "bookTicker", s: "BTCUSDT", b: "29999", B: "2", a: "30001", A: "3", T: 1717000000000 } }));

    expect(quotes).toHaveLength(1);
    expect(quotes[0]).toMatchObject({ exchange: "BINANCE", symbol: "BTC-PERP", bestBid: "29999", bestAsk: "30001" });
    await sub.close();
  });
});
