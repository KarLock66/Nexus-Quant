/**
 * Deribit connector tests — pure mapping only.
 * Network-free: every REST call goes through a stubbed global fetch with
 * inline fixture payloads shaped like real Deribit JSON-RPC envelopes.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import createDefault, {
  black76Greeks,
  createDeribitConnector,
  DeribitApiError,
  parseOptionInstrument,
  toDecimalString,
} from "./deribit.js";

// ── Fixture helpers ─────────────────────────────────────────────────────────

function rpcResponse(result: unknown, status = 200): Response {
  return new Response(
    JSON.stringify({ jsonrpc: "2.0", id: 1, result, usIn: 1, usOut: 2, usDiff: 1, testnet: false }),
    { status, headers: { "content-type": "application/json" } },
  );
}

function stubFetch(handler: (url: URL) => Response): ReturnType<typeof vi.fn> {
  const mock = vi.fn(async (input: unknown): Promise<Response> => {
    return handler(new URL(String(input)));
  });
  vi.stubGlobal("fetch", mock);
  return mock;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

// ── Identity & capabilities ─────────────────────────────────────────────────

describe("createDeribitConnector", () => {
  it("exposes DERIBIT identity and correct capabilities (no LSR)", () => {
    const c = createDeribitConnector();
    expect(c.exchange).toBe("DERIBIT");
    expect(c.capabilities).toEqual({
      candles: true,
      funding: true,
      openInterest: true,
      longShortRatio: false,
      optionChain: true,
      liquidity: true,
    });
  });

  it("default export is the factory", () => {
    expect(createDefault).toBe(createDeribitConnector);
  });
});

// ── Decimal-string discipline ───────────────────────────────────────────────

describe("toDecimalString", () => {
  it("trims trailing zeros without corrupting integers", () => {
    expect(toDecimalString(100, 8)).toBe("100");
    expect(toDecimalString(100.5, 8)).toBe("100.5");
    expect(toDecimalString(1.5, 8)).toBe("1.5");
    expect(toDecimalString(0, 4)).toBe("0");
  });

  it("renders small magnitudes without exponent notation", () => {
    expect(toDecimalString(1e-7, 10)).toBe("0.0000001");
    expect(toDecimalString(-0.000025, 10)).toBe("-0.000025");
  });

  it("normalizes negative zero and rejects non-finite input", () => {
    expect(toDecimalString(-1e-10, 6)).toBe("0");
    expect(() => toDecimalString(Number.NaN, 8)).toThrow(DeribitApiError);
    expect(() => toDecimalString(Number.POSITIVE_INFINITY, 8)).toThrow(DeribitApiError);
  });
});

// ── Option instrument parsing ───────────────────────────────────────────────

describe("parseOptionInstrument", () => {
  it("parses two-digit days, large strikes, and calls", () => {
    const p = parseOptionInstrument("BTC-27JUN26-100000-C");
    expect(p).not.toBeNull();
    expect(p?.underlying).toBe("BTC");
    expect(p?.expiry.toISOString()).toBe("2026-06-27T08:00:00.000Z"); // 08:00 UTC expiry
    expect(p?.strike).toBe("100000");
    expect(p?.strikeNum).toBe(100000);
    expect(p?.optionType).toBe("CALL");
  });

  it("parses single-digit days and puts", () => {
    const p = parseOptionInstrument("ETH-1MAY26-2400-P");
    expect(p).not.toBeNull();
    expect(p?.expiry.toISOString()).toBe("2026-05-01T08:00:00.000Z");
    expect(p?.strike).toBe("2400");
    expect(p?.optionType).toBe("PUT");
  });

  it("normalizes 'd' fractional strike markers to a decimal point", () => {
    const p = parseOptionInstrument("ETH-27JUN26-3d5-C");
    expect(p?.strike).toBe("3.5");
    expect(p?.strikeNum).toBe(3.5);
  });

  it("rejects non-option and calendar-invalid names", () => {
    expect(parseOptionInstrument("BTC-PERPETUAL")).toBeNull();
    expect(parseOptionInstrument("BTC-31FEB26-100000-C")).toBeNull(); // invalid date
    expect(parseOptionInstrument("BTC-27XXX26-100000-C")).toBeNull(); // bad month
    expect(parseOptionInstrument("BTC-27JUN26-100000-X")).toBeNull(); // bad type
    expect(parseOptionInstrument("")).toBeNull();
  });
});

// ── Black-76 greeks ─────────────────────────────────────────────────────────

describe("black76Greeks", () => {
  const base = { forward: 100_000, strike: 100_000, iv: 0.55, ttYears: 30 / 365 };

  it("produces sane ATM greeks", () => {
    const call = black76Greeks({ ...base, optionType: "CALL" });
    const put = black76Greeks({ ...base, optionType: "PUT" });
    expect(call).not.toBeNull();
    expect(put).not.toBeNull();
    if (call === null || put === null) return;
    expect(call.delta).toBeGreaterThan(0);
    expect(call.delta).toBeLessThan(1);
    expect(put.delta).toBeGreaterThan(-1);
    expect(put.delta).toBeLessThan(0);
    expect(call.delta - put.delta).toBeCloseTo(1, 9); // N(d1) - (N(d1) - 1)
    expect(call.gamma).toBeGreaterThan(0);
    expect(call.gamma).toBeCloseTo(put.gamma, 12); // gamma is type-independent
    expect(call.vega).toBeGreaterThan(0);
    expect(call.thetaPerDay).toBeLessThan(0);
  });

  it("deep ITM call delta approaches 1; deep OTM approaches 0", () => {
    const itm = black76Greeks({ ...base, optionType: "CALL", strike: 50_000 });
    const otm = black76Greeks({ ...base, optionType: "CALL", strike: 200_000 });
    expect(itm?.delta).toBeGreaterThan(0.95);
    expect(otm?.delta).toBeLessThan(0.05);
  });

  it("returns null for expired or degenerate inputs (greeks omitted, not garbage)", () => {
    expect(black76Greeks({ ...base, optionType: "CALL", ttYears: 0 })).toBeNull();
    expect(black76Greeks({ ...base, optionType: "CALL", ttYears: -1 })).toBeNull();
    expect(black76Greeks({ ...base, optionType: "CALL", iv: 0 })).toBeNull();
    expect(black76Greeks({ ...base, optionType: "PUT", forward: 0 })).toBeNull();
    expect(black76Greeks({ ...base, optionType: "PUT", strike: Number.NaN })).toBeNull();
  });
});

// ── Candles ─────────────────────────────────────────────────────────────────

describe("fetchCandles", () => {
  const T0 = Date.UTC(2026, 0, 1, 0, 0, 0); // 2026-01-01T00:00:00Z

  it("returns [] for SPOT without any network call", async () => {
    const mock = stubFetch(() => rpcResponse({}));
    const c = createDeribitConnector();
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
    stubFetch(() => rpcResponse({}));
    const c = createDeribitConnector();
    await expect(
      c.fetchCandles({
        symbol: "SOL-PERP",
        assetType: "PERP",
        timeframe: "M5",
        from: new Date(T0),
        to: new Date(T0 + 300_000),
      }),
    ).rejects.toBeInstanceOf(DeribitApiError);
  });

  it("maps chart payload to normalized candles (decimal strings, UTC bar-open ts)", async () => {
    const ticks = [T0, T0 + 300_000, T0 + 600_000];
    const mock = stubFetch((url) => {
      expect(url.pathname).toBe("/api/v2/public/get_tradingview_chart_data");
      expect(url.searchParams.get("instrument_name")).toBe("BTC-PERPETUAL");
      expect(url.searchParams.get("resolution")).toBe("5");
      return rpcResponse({
        status: "ok",
        ticks,
        open: [50_000.5, 50_010, 50_020.25],
        high: [50_050, 50_060.5, 50_070],
        low: [49_990.75, 50_000, 50_010],
        close: [50_010, 50_020.25, 50_030],
        volume: [12.5, 0, 7.25],
        cost: [1, 1, 1],
      });
    });
    const c = createDeribitConnector();
    const out = await c.fetchCandles({
      symbol: "BTC-PERP",
      assetType: "PERP",
      timeframe: "M5",
      from: new Date(T0),
      to: new Date(T0 + 600_000),
    });
    expect(mock).toHaveBeenCalledTimes(1);
    expect(out).toHaveLength(3);
    const first = out[0];
    expect(first).toBeDefined();
    if (first === undefined) return;
    expect(first.exchange).toBe("DERIBIT");
    expect(first.symbol).toBe("BTC-PERP"); // canonical, not venue-native
    expect(first.assetType).toBe("PERP");
    expect(first.timeframe).toBe("M5");
    expect(first.ts.toISOString()).toBe("2026-01-01T00:00:00.000Z");
    expect(first.open).toBe("50000.5");
    expect(first.high).toBe("50050");
    expect(first.low).toBe("49990.75");
    expect(first.close).toBe("50010");
    expect(first.volume).toBe("12.5");
    expect(first.trades).toBeUndefined(); // not provided by Deribit chart data
    expect(out[1]?.volume).toBe("0");
  });

  it("paginates in <=5000-bar windows and dedupes/sorts the result", async () => {
    const TF_MS = 60_000;
    const BARS = 7_000;
    const toMs = T0 + (BARS - 1) * TF_MS;
    const mock = stubFetch((url) => {
      const start = Number(url.searchParams.get("start_timestamp"));
      const end = Number(url.searchParams.get("end_timestamp"));
      expect(end - start).toBeLessThanOrEqual(4_999 * TF_MS); // never >5000 bars
      const ticks: number[] = [];
      for (let t = start; t <= end; t += TF_MS) ticks.push(t);
      const n = ticks.length;
      return rpcResponse({
        status: "ok",
        ticks,
        open: new Array<number>(n).fill(50_000.5),
        high: new Array<number>(n).fill(50_001),
        low: new Array<number>(n).fill(49_999.75),
        close: new Array<number>(n).fill(50_000.25),
        volume: new Array<number>(n).fill(3.125),
      });
    });
    const c = createDeribitConnector();
    const out = await c.fetchCandles({
      symbol: "ETH-PERP",
      assetType: "PERP",
      timeframe: "M1",
      from: new Date(T0),
      to: new Date(toMs),
    });
    expect(mock).toHaveBeenCalledTimes(2); // 5000 + 2000 bars
    expect(out).toHaveLength(BARS); // no duplicates across page boundaries
    expect(out[0]?.ts.getTime()).toBe(T0);
    expect(out[BARS - 1]?.ts.getTime()).toBe(toMs);
    for (let i = 1; i < out.length; i++) {
      expect(out[i]?.ts.getTime()).toBe(T0 + i * TF_MS); // strictly increasing
    }
  });

  it("skips no_data windows without failing", async () => {
    stubFetch(() => rpcResponse({ status: "no_data", ticks: [], open: [], high: [], low: [], close: [], volume: [] }));
    const c = createDeribitConnector();
    const out = await c.fetchCandles({
      symbol: "BTC-PERP",
      assetType: "PERP",
      timeframe: "H1",
      from: new Date(T0),
      to: new Date(T0 + 3_600_000),
    });
    expect(out).toEqual([]);
  });
});

// ── Funding ─────────────────────────────────────────────────────────────────

describe("fetchFundingRates", () => {
  const T0 = Date.UTC(2026, 0, 1, 0, 0, 0);
  const H8 = 8 * 3_600_000;

  it("maps 8h funding records (rate as decimal string, nextTs = ts + 8h)", async () => {
    const mock = stubFetch((url) => {
      expect(url.pathname).toBe("/api/v2/public/get_funding_rate_history");
      expect(url.searchParams.get("instrument_name")).toBe("BTC-PERPETUAL");
      return rpcResponse([
        { timestamp: T0, index_price: 100_000, prev_index_price: 99_900, interest_8h: 0.0001, interest_1h: 0.0000125 },
        { timestamp: T0 + H8, index_price: 100_100, prev_index_price: 100_000, interest_8h: -0.000025, interest_1h: -0.000003 },
      ]);
    });
    const c = createDeribitConnector();
    const out = await c.fetchFundingRates({
      symbol: "BTC-PERP",
      from: new Date(T0),
      to: new Date(T0 + 24 * 3_600_000),
    });
    expect(mock).toHaveBeenCalledTimes(1);
    expect(out).toHaveLength(2);
    expect(out[0]?.exchange).toBe("DERIBIT");
    expect(out[0]?.symbol).toBe("BTC-PERP");
    expect(out[0]?.ts.toISOString()).toBe("2026-01-01T00:00:00.000Z");
    expect(out[0]?.rate).toBe("0.0001");
    expect(out[0]?.nextTs?.toISOString()).toBe("2026-01-01T08:00:00.000Z");
    expect(out[1]?.rate).toBe("-0.000025");
  });
});

// ── Open interest ───────────────────────────────────────────────────────────

describe("fetchOpenInterest", () => {
  const T0 = Date.UTC(2026, 5, 12, 8, 0, 0);

  it("converts USD-quoted perp OI: value = raw USD, base = USD / index_price (8dp)", async () => {
    stubFetch((url) => {
      expect(url.pathname).toBe("/api/v2/public/ticker");
      expect(url.searchParams.get("instrument_name")).toBe("BTC-PERPETUAL");
      return rpcResponse({ timestamp: T0, open_interest: 500_000_000, index_price: 100_000 });
    });
    const c = createDeribitConnector();
    const out = await c.fetchOpenInterest({
      symbol: "BTC-PERP",
      from: new Date(T0 - 3_600_000),
      to: new Date(T0),
    });
    expect(out).toHaveLength(1); // snapshot-only: Deribit has no OI history API
    expect(out[0]?.openInterestValue).toBe("500000000");
    expect(out[0]?.openInterest).toBe("5000");
    expect(out[0]?.ts.toISOString()).toBe(new Date(T0).toISOString());
  });

  it("fails closed when index_price is missing", async () => {
    stubFetch(() => rpcResponse({ timestamp: T0, open_interest: 500_000_000 }));
    const c = createDeribitConnector();
    await expect(
      c.fetchOpenInterest({ symbol: "BTC-PERP", from: new Date(T0), to: new Date(T0) }),
    ).rejects.toBeInstanceOf(DeribitApiError);
  });

  it("floors the snapshot ts to the hour grid (idempotent identity)", async () => {
    // Venue clock mid-hour (08:37:12.345) must floor back to 08:00 so repeated
    // polls within the slot share the (exchange, symbol, ts) PK and overwrite.
    const offGrid = T0 + 37 * 60_000 + 12_000 + 345;
    stubFetch(() =>
      rpcResponse({ timestamp: offGrid, open_interest: 500_000_000, index_price: 100_000 }),
    );
    const c = createDeribitConnector();
    const out = await c.fetchOpenInterest({
      symbol: "BTC-PERP",
      from: new Date(T0),
      to: new Date(T0 + 3_600_000),
    });
    expect(out).toHaveLength(1);
    expect(out[0]?.ts.toISOString()).toBe(new Date(T0).toISOString());
  });
});

// ── Long/short ratio (capability-gated) ─────────────────────────────────────

describe("fetchLongShortRatios", () => {
  it("returns [] without any network call (Deribit publishes none)", async () => {
    const mock = stubFetch(() => rpcResponse({}));
    const c = createDeribitConnector();
    const out = await c.fetchLongShortRatios({
      symbol: "BTC-PERP",
      from: new Date(0),
      to: new Date(1),
    });
    expect(out).toEqual([]);
    expect(mock).not.toHaveBeenCalled();
  });
});

// ── Option chain ────────────────────────────────────────────────────────────

describe("fetchOptionChain", () => {
  const NOW = new Date("2026-06-12T08:00:00.000Z"); // 26JUN26 = 14d out, 31JUL26 = 49d out

  function chainFixture(): unknown[] {
    const common = { underlying_price: 100_000 };
    return [
      {
        instrument_name: "BTC-26JUN26-100000-C",
        mark_price: 0.05375,
        mark_iv: 50, // percent — connector must divide by 100
        open_interest: 1_000,
        volume: 10.5,
        bid_price: 0.0525,
        ask_price: 0.055,
        ...common,
      },
      { instrument_name: "BTC-26JUN26-100000-P", mark_price: 0.052, mark_iv: 50, open_interest: 500, volume: 4, bid_price: 0.051, ask_price: 0.053, ...common },
      { instrument_name: "BTC-31JUL26-100000-C", mark_price: 0.09, mark_iv: 60, open_interest: 200, volume: 2, bid_price: 0.089, ask_price: 0.091, ...common },
      { instrument_name: "BTC-31JUL26-100000-P", mark_price: 0.088, mark_iv: 60, open_interest: 300, volume: 1, bid_price: 0.087, ask_price: 0.089, ...common },
      // no mark_iv: contract kept, iv/greeks omitted, OI still counted
      { instrument_name: "BTC-26JUN26-110000-C", mark_price: 0.012, mark_iv: null, open_interest: 50, volume: 0, bid_price: null, ask_price: null, ...common },
      // unparseable instrument: skipped with a logged warning
      { instrument_name: "BTC-PERPETUAL", mark_price: 100_000, mark_iv: null, open_interest: 1, volume: 1, underlying_price: 100_000 },
    ];
  }

  it("maps the bulk book summary into a full normalized chain", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    stubFetch((url) => {
      expect(url.pathname).toBe("/api/v2/public/get_book_summary_by_currency");
      expect(url.searchParams.get("currency")).toBe("BTC");
      expect(url.searchParams.get("kind")).toBe("option");
      return rpcResponse(chainFixture());
    });

    const c = createDeribitConnector();
    const chain = await c.fetchOptionChain("BTC");
    expect(chain).not.toBeNull();
    if (chain === null) return;

    expect(chain.exchange).toBe("DERIBIT");
    expect(chain.underlying).toBe("BTC");
    expect(chain.ts.getTime()).toBe(NOW.getTime());
    expect(chain.spot).toBe("100000"); // median of underlying_price
    expect(chain.contracts).toHaveLength(5); // perp row skipped

    // put/call OI ratio: (500 + 300) / (1000 + 200 + 50) = 0.64
    expect(chain.putCallRatio).toBe("0.64");

    // term structure: ATM IV per expiry, ascending
    expect(chain.termStructure).toEqual([
      { expiry: "2026-06-26T08:00:00.000Z", atmIv: "0.5" },
      { expiry: "2026-07-31T08:00:00.000Z", atmIv: "0.6" },
    ]);

    // ivAtm30d: linear interpolation 14d..49d to 30d = 0.5 + 0.1 * 16/35
    expect(chain.ivAtm30d).toBe("0.545714");

    // Phase-3-scoped aggregates are omitted, never guessed
    expect(chain.skew25d).toBeUndefined();
    expect(chain.totalGammaExposure).toBeUndefined();

    const call = chain.contracts.find(
      (x) => x.strike === "100000" && x.optionType === "CALL" && x.expiry.toISOString() === "2026-06-26T08:00:00.000Z",
    );
    expect(call).toBeDefined();
    if (call === undefined) return;
    expect(call.iv).toBe("0.5"); // 50% -> 0.5
    expect(call.markPrice).toBe("0.05375");
    expect(call.bid).toBe("0.0525");
    expect(call.ask).toBe("0.055");
    expect(call.openInterest).toBe("1000");
    expect(call.volume).toBe("10.5");
    const callDelta = Number(call.delta);
    expect(callDelta).toBeGreaterThan(0);
    expect(callDelta).toBeLessThan(1);
    expect(Number(call.gamma)).toBeGreaterThan(0);
    expect(Number(call.theta)).toBeLessThan(0);
    expect(Number(call.vega)).toBeGreaterThan(0);

    const put = chain.contracts.find(
      (x) => x.strike === "100000" && x.optionType === "PUT" && x.expiry.toISOString() === "2026-06-26T08:00:00.000Z",
    );
    expect(put).toBeDefined();
    if (put === undefined) return;
    const putDelta = Number(put.delta);
    expect(putDelta).toBeGreaterThan(-1);
    expect(putDelta).toBeLessThan(0);
    expect(callDelta - putDelta).toBeCloseTo(1, 6); // same strike/expiry/iv

    const noIv = chain.contracts.find((x) => x.strike === "110000");
    expect(noIv).toBeDefined();
    expect(noIv?.iv).toBeUndefined();
    expect(noIv?.delta).toBeUndefined(); // no iv -> no greeks (omitted, not faked)
  });

  it("returns null ivAtm30d-free chain with a single expiry", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    stubFetch(() =>
      rpcResponse([
        {
          instrument_name: "BTC-26JUN26-100000-C",
          mark_price: 0.05,
          mark_iv: 50,
          open_interest: 10,
          volume: 1,
          bid_price: 0.049,
          ask_price: 0.051,
          underlying_price: 100_000,
        },
      ]),
    );
    const c = createDeribitConnector();
    const chain = await c.fetchOptionChain("BTC");
    expect(chain).not.toBeNull();
    expect(chain?.ivAtm30d).toBeUndefined(); // <2 expiries -> no interpolation
    expect(chain?.termStructure).toHaveLength(1);
    expect(chain?.putCallRatio).toBe("0"); // zero put OI over positive call OI
  });

  it("fails closed (null) on an empty or unparseable chain", async () => {
    stubFetch(() => rpcResponse([]));
    const c = createDeribitConnector();
    expect(await c.fetchOptionChain("BTC")).toBeNull();
  });

  it("returns null for unsupported underlyings without a network call", async () => {
    const mock = stubFetch(() => rpcResponse([]));
    const c = createDeribitConnector();
    expect(await c.fetchOptionChain("SOL")).toBeNull();
    expect(mock).not.toHaveBeenCalled();
  });
});

// ── Liquidity ───────────────────────────────────────────────────────────────

describe("fetchLiquidity", () => {
  const T0 = Date.UTC(2026, 5, 12, 8, 0, 0);

  it("sums USD depth within +/-0.5% of mid and computes spreadBps", async () => {
    stubFetch((url) => {
      expect(url.pathname).toBe("/api/v2/public/get_order_book");
      expect(url.searchParams.get("instrument_name")).toBe("BTC-PERPETUAL");
      expect(url.searchParams.get("depth")).toBe("50");
      return rpcResponse({
        timestamp: T0,
        best_bid_price: 99_990,
        best_ask_price: 100_010,
        // mid = 100000, band = [99500, 100500]; amounts are USD for perps
        bids: [
          [99_990, 1_000_000],
          [99_600, 500_000],
          [99_400, 250_000], // outside band — excluded
        ],
        asks: [
          [100_010, 800_000],
          [100_400, 200_000],
          [100_600, 100_000], // outside band — excluded
        ],
      });
    });
    const c = createDeribitConnector();
    const out = await c.fetchLiquidity("BTC-PERP");
    expect(out).not.toBeNull();
    if (out === null) return;
    expect(out.exchange).toBe("DERIBIT");
    expect(out.symbol).toBe("BTC-PERP");
    expect(out.ts.toISOString()).toBe(new Date(T0).toISOString());
    expect(out.bidDepthUsd).toBe("1500000");
    expect(out.askDepthUsd).toBe("1000000");
    expect(out.spreadBps).toBe("2"); // 20 / 100000 * 10000
  });

  it("returns null for unsupported symbols without a network call", async () => {
    const mock = stubFetch(() => rpcResponse({}));
    const c = createDeribitConnector();
    expect(await c.fetchLiquidity("BTC-USDT")).toBeNull();
    expect(mock).not.toHaveBeenCalled();
  });

  it("fails closed (null) on a crossed or empty book", async () => {
    stubFetch(() =>
      rpcResponse({ timestamp: T0, best_bid_price: 100_020, best_ask_price: 100_010, bids: [], asks: [] }),
    );
    const c = createDeribitConnector();
    expect(await c.fetchLiquidity("BTC-PERP")).toBeNull();
  });
});
