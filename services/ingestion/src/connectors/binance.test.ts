/**
 * Binance USDⓈ-M connector tests — pure mapping only.
 * Network-free: every REST call goes through a stubbed global fetch with inline
 * fixture payloads shaped like real Binance futures JSON.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import createDefault, {
  BinanceApiError,
  createBinanceConnector,
  toDecimalString,
} from "./binance.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function stubFetch(handler: (url: URL) => Response): ReturnType<typeof vi.fn> {
  const mock = vi.fn(async (input: unknown): Promise<Response> => handler(new URL(String(input))));
  vi.stubGlobal("fetch", mock);
  return mock;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

// ── Identity & capabilities ─────────────────────────────────────────────────

describe("createBinanceConnector", () => {
  it("exposes BINANCE identity and correct capabilities (no option chain)", () => {
    const c = createBinanceConnector();
    expect(c.exchange).toBe("BINANCE");
    expect(c.capabilities).toEqual({
      candles: true,
      funding: true,
      openInterest: true,
      longShortRatio: true,
      optionChain: false,
      liquidity: true,
    });
  });

  it("default export is the factory", () => {
    expect(createDefault).toBe(createBinanceConnector);
  });
});

// ── Decimal-string discipline ───────────────────────────────────────────────

describe("toDecimalString", () => {
  it("accepts numbers and numeric strings, trims trailing zeros", () => {
    expect(toDecimalString(100, 8)).toBe("100");
    expect(toDecimalString("100.50000000", 8)).toBe("100.5");
    expect(toDecimalString("0.00010000", 10)).toBe("0.0001");
    expect(toDecimalString(0, 4)).toBe("0");
  });

  it("normalizes negative zero and rejects non-finite input", () => {
    expect(toDecimalString(-1e-10, 6)).toBe("0");
    expect(() => toDecimalString(Number.NaN, 8)).toThrow(BinanceApiError);
    expect(() => toDecimalString("not-a-number", 8)).toThrow(BinanceApiError);
  });
});

// ── Candles ─────────────────────────────────────────────────────────────────

describe("fetchCandles", () => {
  const T0 = Date.UTC(2026, 0, 1, 0, 0, 0);

  it("returns [] for SPOT without any network call", async () => {
    const mock = stubFetch(() => jsonResponse([]));
    const c = createBinanceConnector();
    const out = await c.fetchCandles({
      symbol: "BTC-USDT",
      assetType: "SPOT",
      timeframe: "H1",
      from: new Date(T0),
      to: new Date(T0 + 3_600_000),
    });
    expect(out).toEqual([]);
    expect(mock).not.toHaveBeenCalled();
  });

  it("throws a typed error for unsupported symbols", async () => {
    stubFetch(() => jsonResponse([]));
    const c = createBinanceConnector();
    await expect(
      c.fetchCandles({
        symbol: "SOL-PERP",
        assetType: "PERP",
        timeframe: "M5",
        from: new Date(T0),
        to: new Date(T0 + 300_000),
      }),
    ).rejects.toBeInstanceOf(BinanceApiError);
  });

  it("maps kline rows to normalized candles (canonical symbol, UTC bar-open ts)", async () => {
    const mock = stubFetch((url) => {
      expect(url.pathname).toBe("/fapi/v1/klines");
      expect(url.searchParams.get("symbol")).toBe("BTCUSDT");
      expect(url.searchParams.get("interval")).toBe("5m");
      // [openTime, o, h, l, c, v, closeTime, quoteVol, trades, ...]
      return jsonResponse([
        [T0, "50000.50", "50050.00", "49990.75", "50010.00", "12.50000000", T0 + 299_999, "1", 42, "1", "1", "0"],
        [T0 + 300_000, "50010.00", "50060.50", "50000.00", "50020.25", "0.00000000", T0 + 599_999, "1", 7, "1", "1", "0"],
      ]);
    });
    const c = createBinanceConnector();
    const out = await c.fetchCandles({
      symbol: "BTC-PERP",
      assetType: "PERP",
      timeframe: "M5",
      from: new Date(T0),
      to: new Date(T0 + 300_000),
    });
    expect(mock).toHaveBeenCalledTimes(1);
    expect(out).toHaveLength(2);
    const first = out[0];
    expect(first).toBeDefined();
    if (first === undefined) return;
    expect(first.exchange).toBe("BINANCE");
    expect(first.symbol).toBe("BTC-PERP"); // canonical, not venue-native
    expect(first.assetType).toBe("PERP");
    expect(first.timeframe).toBe("M5");
    expect(first.ts.toISOString()).toBe("2026-01-01T00:00:00.000Z");
    expect(first.open).toBe("50000.5");
    expect(first.high).toBe("50050");
    expect(first.low).toBe("49990.75");
    expect(first.close).toBe("50010");
    expect(first.volume).toBe("12.5");
    expect(first.trades).toBe(42);
    expect(out[1]?.volume).toBe("0");
  });
});

// ── Funding ─────────────────────────────────────────────────────────────────

describe("fetchFundingRates", () => {
  const T0 = Date.UTC(2026, 0, 1, 0, 0, 0);
  const H8 = 8 * 3_600_000;

  it("maps 8h funding rows (rate as decimal string, nextTs = ts + 8h)", async () => {
    const mock = stubFetch((url) => {
      expect(url.pathname).toBe("/fapi/v1/fundingRate");
      expect(url.searchParams.get("symbol")).toBe("BTCUSDT");
      return jsonResponse([
        { symbol: "BTCUSDT", fundingTime: T0, fundingRate: "0.00010000" },
        { symbol: "BTCUSDT", fundingTime: T0 + H8, fundingRate: "-0.00002500" },
      ]);
    });
    const c = createBinanceConnector();
    const out = await c.fetchFundingRates({
      symbol: "BTC-PERP",
      from: new Date(T0),
      to: new Date(T0 + 24 * 3_600_000),
    });
    expect(mock).toHaveBeenCalledTimes(1);
    expect(out).toHaveLength(2);
    expect(out[0]?.exchange).toBe("BINANCE");
    expect(out[0]?.ts.toISOString()).toBe("2026-01-01T00:00:00.000Z");
    expect(out[0]?.rate).toBe("0.0001");
    expect(out[0]?.nextTs?.toISOString()).toBe("2026-01-01T08:00:00.000Z");
    expect(out[1]?.rate).toBe("-0.000025");
  });
});

// ── Open interest ───────────────────────────────────────────────────────────

describe("fetchOpenInterest", () => {
  const T0 = Date.UTC(2026, 5, 12, 8, 0, 0);

  it("maps OI history (base + USD value) within the requested window", async () => {
    stubFetch((url) => {
      expect(url.pathname).toBe("/futures/data/openInterestHist");
      expect(url.searchParams.get("symbol")).toBe("BTCUSDT");
      expect(url.searchParams.get("period")).toBe("1h");
      return jsonResponse([
        { symbol: "BTCUSDT", sumOpenInterest: "5000.00000000", sumOpenInterestValue: "500000000.00", timestamp: T0 },
      ]);
    });
    const c = createBinanceConnector();
    const out = await c.fetchOpenInterest({
      symbol: "BTC-PERP",
      from: new Date(T0 - 3_600_000),
      to: new Date(T0),
    });
    expect(out).toHaveLength(1);
    expect(out[0]?.openInterest).toBe("5000");
    expect(out[0]?.openInterestValue).toBe("500000000");
    expect(out[0]?.ts.toISOString()).toBe(new Date(T0).toISOString());
  });
});

// ── Long/short ratio (3 scopes) ─────────────────────────────────────────────

describe("fetchLongShortRatios", () => {
  const T0 = Date.UTC(2026, 5, 12, 8, 0, 0);

  it("fetches the three scopes and tags each row with its LsRatioScope", async () => {
    const paths: string[] = [];
    stubFetch((url) => {
      paths.push(url.pathname);
      return jsonResponse([
        { longShortRatio: "1.250000", longAccount: "0.55", shortAccount: "0.45", timestamp: T0 },
      ]);
    });
    const c = createBinanceConnector();
    const out = await c.fetchLongShortRatios({
      symbol: "BTC-PERP",
      from: new Date(T0 - 3_600_000),
      to: new Date(T0),
    });
    expect(paths).toEqual([
      "/futures/data/globalLongShortAccountRatio",
      "/futures/data/topLongShortAccountRatio",
      "/futures/data/topLongShortPositionRatio",
    ]);
    expect(out).toHaveLength(3);
    expect(out.map((r) => r.scope).sort()).toEqual([
      "GLOBAL_ACCOUNTS",
      "TOP_TRADER_ACCOUNTS",
      "TOP_TRADER_POSITIONS",
    ]);
    expect(out[0]?.ratio).toBe("1.25");
    expect(out[0]?.longPct).toBe("0.55");
  });
});

// ── Liquidity ───────────────────────────────────────────────────────────────

describe("fetchLiquidity", () => {
  const T0 = Date.UTC(2026, 5, 12, 8, 0, 0);

  it("sums USD depth within +/-0.5% of mid (qty is base-asset) and computes spreadBps", async () => {
    stubFetch((url) => {
      expect(url.pathname).toBe("/fapi/v1/depth");
      expect(url.searchParams.get("symbol")).toBe("BTCUSDT");
      return jsonResponse({
        T: T0,
        E: T0,
        // mid = 100000, band = [99500, 100500]; qty is base (BTC)
        bids: [
          ["99990", "10"], // 999,900 USD
          ["99600", "5"], // 498,000 USD
          ["99400", "5"], // outside band — excluded
        ],
        asks: [
          ["100010", "8"], // 800,080 USD
          ["100400", "2"], // 200,800 USD
          ["100600", "1"], // outside band — excluded
        ],
      });
    });
    const c = createBinanceConnector();
    const out = await c.fetchLiquidity("BTC-PERP");
    expect(out).not.toBeNull();
    if (out === null) return;
    expect(out.exchange).toBe("BINANCE");
    expect(out.symbol).toBe("BTC-PERP");
    expect(out.bidDepthUsd).toBe("1497900"); // 999900 + 498000
    expect(out.askDepthUsd).toBe("1000880"); // 800080 + 200800
    expect(out.spreadBps).toBe("2"); // 20 / 100000 * 10000
  });

  it("returns null for unsupported symbols without a network call", async () => {
    const mock = stubFetch(() => jsonResponse({}));
    const c = createBinanceConnector();
    expect(await c.fetchLiquidity("BTC-USDT")).toBeNull();
    expect(mock).not.toHaveBeenCalled();
  });
});

// ── Option chain (not served) ───────────────────────────────────────────────

describe("fetchOptionChain", () => {
  it("returns null without a network call", async () => {
    const mock = stubFetch(() => jsonResponse({}));
    const c = createBinanceConnector();
    expect(await c.fetchOptionChain("BTC")).toBeNull();
    expect(mock).not.toHaveBeenCalled();
  });
});
