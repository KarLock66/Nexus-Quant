/**
 * Binance USDⓈ-M Futures connector — SECONDARY venue (deep perp liquidity +
 * rich public WebSocket streams that map 1:1 to the Phase 9 tick feed).
 *
 * REST base: https://fapi.binance.com
 * WS:        wss://fstream.binance.com
 *
 * Venue notes (documented behaviors, not tunables):
 *  - Only USDⓈ-M perpetuals are ingested (BTC-PERP -> BTCUSDT, ETH-PERP ->
 *    ETHUSDT). SPOT candle requests return [] with an info log; options are not
 *    served here (capability `optionChain: false`).
 *  - Open interest history (`/futures/data/openInterestHist`) carries both base
 *    (`sumOpenInterest`) and USD (`sumOpenInterestValue`) — only ~30 days of
 *    history is published (documented limitation; persistence upserts on ts).
 *  - Long/short ratio is published in three scopes (global accounts, top-trader
 *    accounts, top-trader positions) → mapped to the three LsRatioScope values.
 *  - Depth (`/fapi/v1/depth`) qty is base-asset → ±0.5% USD depth = Σ price*qty.
 *  - WS: <symbol>@aggTrade (trades), @bookTicker (best bid/ask), @markPrice@1s
 *    (mark + funding rate), @kline_<interval> (candles; emitted on close only).
 *
 * Discipline (identical to the Deribit connector):
 *  - All numerics leave this module as decimal strings (no float drift across
 *    borders; floats only map venue JSON transiently).
 *  - Fail-closed: malformed/missing critical fields throw a typed
 *    BinanceApiError (or return []/null WITH a logged reason where allowed).
 */

import WebSocket from "ws";
import type { AssetType, LsRatioScope, Timeframe } from "@nexus/core";
import type {
  CandleBackfillRequest,
  ConnectorCapabilities,
  ExchangeConnector,
  FlowBackfillRequest,
  LiveHandlers,
  LiveStreamRequest,
  LiveSubscription,
  NormalizedCandle,
  NormalizedFundingRate,
  NormalizedLiquidity,
  NormalizedLongShortRatio,
  NormalizedOpenInterest,
  NormalizedOptionChain,
} from "./types.js";

// ── Constants ───────────────────────────────────────────────────────────────

const EXCHANGE = "BINANCE" as const;
const REST_BASE = "https://fapi.binance.com";
const WS_BASE = "wss://fstream.binance.com/stream";

const REQUEST_TIMEOUT_MS = 15_000;
const MAX_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 500;
const RATE_LIMIT_INTERVAL_MS = 120; // inter-request spacing (weight-limit safe)
const MAX_BARS_PER_REQUEST = 1_500; // klines hard cap
const FUNDING_PAGE = 1_000; // fundingRate rows per request
const FUNDING_INTERVAL_MS = 8 * 60 * 60 * 1_000;
const FLOW_HIST_LIMIT = 500; // OI/LSR history rows per request (venue cap)
const DEPTH_LIMIT = 100;
const DEPTH_BAND = 0.005; // ±0.5% of mid
const WS_RECONNECT_MIN_MS = 1_000;
const WS_RECONNECT_MAX_MS = 60_000;

/** Canonical -> Binance USDⓈ-M perpetual symbols. */
const PERP_SYMBOLS: Readonly<Record<string, string>> = {
  "BTC-PERP": "BTCUSDT",
  "ETH-PERP": "ETHUSDT",
};

/** Timeframe -> Binance kline interval. */
const INTERVAL_MAP: Readonly<Record<Timeframe, string>> = {
  M1: "1m",
  M5: "5m",
  M15: "15m",
  H1: "1h",
  H4: "4h",
  D1: "1d",
};

const TIMEFRAME_MS: Readonly<Record<Timeframe, number>> = {
  M1: 60_000,
  M5: 300_000,
  M15: 900_000,
  H1: 3_600_000,
  H4: 14_400_000,
  D1: 86_400_000,
};

/** OI/LSR history period (matches the H1 flow cadence). */
const FLOW_PERIOD = "1h";

/** LSR scope -> Binance data endpoint. */
const LSR_ENDPOINTS: ReadonlyArray<{ scope: LsRatioScope; path: string }> = [
  { scope: "GLOBAL_ACCOUNTS", path: "/futures/data/globalLongShortAccountRatio" },
  { scope: "TOP_TRADER_ACCOUNTS", path: "/futures/data/topLongShortAccountRatio" },
  { scope: "TOP_TRADER_POSITIONS", path: "/futures/data/topLongShortPositionRatio" },
];

// ── Logging ─────────────────────────────────────────────────────────────────

type LogLevel = "info" | "warn" | "error";

function log(level: LogLevel, msg: string, extra?: Record<string, unknown>): void {
  console.log(
    JSON.stringify({
      ts: new Date().toISOString(),
      service: "ingestion",
      module: "connector.binance",
      level,
      msg,
      ...extra,
    }),
  );
}

// ── Errors ──────────────────────────────────────────────────────────────────

export class BinanceApiError extends Error {
  readonly endpoint: string;
  readonly httpStatus?: number;

  constructor(message: string, opts: { endpoint: string; httpStatus?: number }) {
    super(message);
    this.name = "BinanceApiError";
    this.endpoint = opts.endpoint;
    if (opts.httpStatus !== undefined) this.httpStatus = opts.httpStatus;
  }
}

// ── Decimal-string helpers ──────────────────────────────────────────────────

/**
 * Convert a venue value (number or numeric string) to a decimal string with at
 * most `dp` fractional digits, trailing zeros trimmed. Throws on non-finite
 * input (fail-closed) — identical contract to the Deribit connector.
 */
export function toDecimalString(value: number | string, dp: number): string {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) {
    throw new BinanceApiError(`non-finite numeric value: ${String(value)}`, {
      endpoint: "normalize",
    });
  }
  let out = n.toFixed(dp);
  if (out.includes(".")) out = out.replace(/0+$/, "").replace(/\.$/, "");
  if (out === "-0") out = "0";
  return out;
}

function finiteOrUndefined(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string") {
    const n = Number(value);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Venue payload shapes (subset consumed) ──────────────────────────────────

type KlineRow = [
  number, // open time
  string, // open
  string, // high
  string, // low
  string, // close
  string, // volume (base)
  number, // close time
  string, // quote volume
  number, // trades
  ...unknown[]
];

interface FundingRow {
  symbol: string;
  fundingTime: number;
  fundingRate: string;
}

interface OpenInterestHistRow {
  symbol: string;
  sumOpenInterest: string; // base units
  sumOpenInterestValue: string; // USDT notional
  timestamp: number;
}

interface LongShortRow {
  longShortRatio: string;
  longAccount?: string;
  shortAccount?: string;
  longPosition?: string;
  shortPosition?: string;
  timestamp: number;
}

interface DepthResult {
  T?: number;
  E?: number;
  bids: Array<[string, string]>;
  asks: Array<[string, string]>;
}

// ── Connector ───────────────────────────────────────────────────────────────

class BinanceConnector implements ExchangeConnector {
  readonly exchange = EXCHANGE;
  readonly capabilities: ConnectorCapabilities = {
    candles: true,
    funding: true,
    openInterest: true,
    longShortRatio: true,
    optionChain: false, // Binance options live on a separate (eapi) venue
    liquidity: true,
  };

  private lastRequestAt = 0;

  // ── REST plumbing ────────────────────────────────────────────────────────

  private async throttle(): Promise<void> {
    const now = Date.now();
    const earliest = this.lastRequestAt + RATE_LIMIT_INTERVAL_MS;
    this.lastRequestAt = Math.max(now, earliest);
    const wait = earliest - now;
    if (wait > 0) await sleep(wait);
  }

  /**
   * GET with 15s timeout; retries up to MAX_RETRIES on 429/418/5xx/network/
   * timeout with exponential backoff. Other 4xx are fatal (no retry). Throws
   * BinanceApiError after exhaustion.
   */
  private async restGet<T>(path: string, params: Record<string, string>): Promise<T> {
    const qs = new URLSearchParams(params).toString();
    const url = `${REST_BASE}${path}${qs ? `?${qs}` : ""}`;
    let lastErr: BinanceApiError | undefined;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (attempt > 0) {
        const backoffMs = RETRY_BASE_DELAY_MS * 2 ** (attempt - 1);
        log("warn", "retrying binance request", {
          endpoint: path,
          attempt,
          backoffMs,
          lastError: lastErr?.message,
        });
        await sleep(backoffMs);
      }
      await this.throttle();

      let res: Response;
      try {
        res = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      } catch (err) {
        lastErr = new BinanceApiError(
          `network/timeout failure: ${err instanceof Error ? err.message : String(err)}`,
          { endpoint: path },
        );
        continue;
      }

      if (res.status === 429 || res.status === 418 || res.status >= 500) {
        lastErr = new BinanceApiError(`HTTP ${res.status} from Binance`, {
          endpoint: path,
          httpStatus: res.status,
        });
        continue;
      }
      if (!res.ok) {
        let detail = "";
        try {
          detail = await res.text();
        } catch {
          // best-effort
        }
        throw new BinanceApiError(`HTTP ${res.status} from Binance${detail ? `: ${detail}` : ""}`, {
          endpoint: path,
          httpStatus: res.status,
        });
      }

      try {
        return (await res.json()) as T;
      } catch (err) {
        lastErr = new BinanceApiError(
          `invalid JSON body: ${err instanceof Error ? err.message : String(err)}`,
          { endpoint: path, httpStatus: res.status },
        );
        continue;
      }
    }

    throw lastErr ?? new BinanceApiError("request failed after retries", { endpoint: path });
  }

  private requirePerpSymbol(symbol: string, endpoint: string): string {
    const native = PERP_SYMBOLS[symbol];
    if (native === undefined) {
      throw new BinanceApiError(
        `unsupported symbol for Binance: ${symbol} (supported: ${Object.keys(PERP_SYMBOLS).join(", ")})`,
        { endpoint },
      );
    }
    return native;
  }

  // ── Candles ────────────────────────────────────────────────────────────────

  async fetchCandles(req: CandleBackfillRequest): Promise<NormalizedCandle[]> {
    if (req.assetType === "SPOT") {
      log("info", "spot candles not served by the binance futures connector, returning empty", {
        symbol: req.symbol,
        timeframe: req.timeframe,
      });
      return [];
    }
    const native = this.requirePerpSymbol(req.symbol, "/fapi/v1/klines");
    const interval = INTERVAL_MAP[req.timeframe];
    const tfMs = TIMEFRAME_MS[req.timeframe];
    const fromMs = req.from.getTime();
    const toMs = req.to.getTime();
    if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs < fromMs) {
      throw new BinanceApiError(
        `invalid candle window: from=${req.from.toISOString()} to=${req.to.toISOString()}`,
        { endpoint: "/fapi/v1/klines" },
      );
    }

    const out = new Map<number, NormalizedCandle>();
    const windowMs = MAX_BARS_PER_REQUEST * tfMs;
    let pages = 0;

    for (let cursor = fromMs; cursor <= toMs; cursor += windowMs) {
      const chunkEnd = Math.min(cursor + windowMs - tfMs, toMs);
      const rows = await this.restGet<KlineRow[]>("/fapi/v1/klines", {
        symbol: native,
        interval,
        startTime: String(cursor),
        endTime: String(chunkEnd),
        limit: String(MAX_BARS_PER_REQUEST),
      });
      pages++;
      for (const row of rows) {
        const ts = row[0];
        const open = finiteOrUndefined(row[1]);
        const high = finiteOrUndefined(row[2]);
        const low = finiteOrUndefined(row[3]);
        const close = finiteOrUndefined(row[4]);
        const volume = finiteOrUndefined(row[5]);
        const trades = typeof row[8] === "number" ? row[8] : undefined;
        if (
          !Number.isFinite(ts) ||
          open === undefined ||
          high === undefined ||
          low === undefined ||
          close === undefined ||
          volume === undefined
        ) {
          throw new BinanceApiError("malformed kline row", { endpoint: "/fapi/v1/klines" });
        }
        if (ts < fromMs || ts > toMs) continue;
        out.set(ts, {
          exchange: EXCHANGE,
          symbol: req.symbol,
          assetType: req.assetType,
          timeframe: req.timeframe,
          ts: new Date(ts),
          open: toDecimalString(open, 8),
          high: toDecimalString(high, 8),
          low: toDecimalString(low, 8),
          close: toDecimalString(close, 8),
          volume: toDecimalString(volume, 8),
          ...(trades !== undefined ? { trades } : {}),
        });
      }
    }

    const candles = [...out.values()].sort((a, b) => a.ts.getTime() - b.ts.getTime());
    log("info", "fetched binance candles", {
      symbol: req.symbol,
      timeframe: req.timeframe,
      pages,
      bars: candles.length,
    });
    return candles;
  }

  // ── Funding ────────────────────────────────────────────────────────────────

  async fetchFundingRates(req: FlowBackfillRequest): Promise<NormalizedFundingRate[]> {
    const native = this.requirePerpSymbol(req.symbol, "/fapi/v1/fundingRate");
    const fromMs = req.from.getTime();
    const toMs = req.to.getTime();
    if (toMs < fromMs) {
      throw new BinanceApiError("invalid funding window (to < from)", {
        endpoint: "/fapi/v1/fundingRate",
      });
    }

    const out = new Map<number, NormalizedFundingRate>();
    // Page forward by the row cap (8h cadence => FUNDING_PAGE*8h per request).
    const windowMs = FUNDING_PAGE * FUNDING_INTERVAL_MS;
    for (let cursor = fromMs; cursor <= toMs; cursor += windowMs) {
      const chunkEnd = Math.min(cursor + windowMs, toMs);
      const rows = await this.restGet<FundingRow[]>("/fapi/v1/fundingRate", {
        symbol: native,
        startTime: String(cursor),
        endTime: String(chunkEnd),
        limit: String(FUNDING_PAGE),
      });
      for (const rec of rows) {
        const ts = finiteOrUndefined(rec.fundingTime);
        const rate = finiteOrUndefined(rec.fundingRate);
        if (ts === undefined || rate === undefined) {
          throw new BinanceApiError("funding row missing fundingTime/fundingRate", {
            endpoint: "/fapi/v1/fundingRate",
          });
        }
        if (ts < fromMs || ts > toMs) continue;
        out.set(ts, {
          exchange: EXCHANGE,
          symbol: req.symbol,
          ts: new Date(ts),
          rate: toDecimalString(rate, 10),
          nextTs: new Date(ts + FUNDING_INTERVAL_MS),
        });
      }
    }

    const rates = [...out.values()].sort((a, b) => a.ts.getTime() - b.ts.getTime());
    log("info", "fetched binance funding rates", { symbol: req.symbol, records: rates.length });
    return rates;
  }

  // ── Open interest ────────────────────────────────────────────────────────────

  async fetchOpenInterest(req: FlowBackfillRequest): Promise<NormalizedOpenInterest[]> {
    const native = this.requirePerpSymbol(req.symbol, "/futures/data/openInterestHist");
    const fromMs = req.from.getTime();
    const toMs = req.to.getTime();
    const rows = await this.restGet<OpenInterestHistRow[]>("/futures/data/openInterestHist", {
      symbol: native,
      period: FLOW_PERIOD,
      limit: String(FLOW_HIST_LIMIT),
      startTime: String(fromMs),
      endTime: String(toMs),
    });

    const out: NormalizedOpenInterest[] = [];
    for (const rec of rows) {
      const ts = finiteOrUndefined(rec.timestamp);
      const oiBase = finiteOrUndefined(rec.sumOpenInterest);
      const oiUsd = finiteOrUndefined(rec.sumOpenInterestValue);
      if (ts === undefined || oiBase === undefined || oiUsd === undefined) continue;
      if (ts < fromMs || ts > toMs) continue;
      out.push({
        exchange: EXCHANGE,
        symbol: req.symbol,
        ts: new Date(ts),
        openInterest: toDecimalString(oiBase, 8),
        openInterestValue: toDecimalString(oiUsd, 2),
      });
    }
    out.sort((a, b) => a.ts.getTime() - b.ts.getTime());
    log("info", "fetched binance open interest", { symbol: req.symbol, records: out.length });
    return out;
  }

  // ── Long/short ratio (3 scopes) ──────────────────────────────────────────────

  async fetchLongShortRatios(req: FlowBackfillRequest): Promise<NormalizedLongShortRatio[]> {
    const native = this.requirePerpSymbol(req.symbol, "/futures/data/globalLongShortAccountRatio");
    const fromMs = req.from.getTime();
    const toMs = req.to.getTime();

    const out: NormalizedLongShortRatio[] = [];
    for (const { scope, path } of LSR_ENDPOINTS) {
      const rows = await this.restGet<LongShortRow[]>(path, {
        symbol: native,
        period: FLOW_PERIOD,
        limit: String(FLOW_HIST_LIMIT),
        startTime: String(fromMs),
        endTime: String(toMs),
      });
      for (const rec of rows) {
        const ts = finiteOrUndefined(rec.timestamp);
        const ratio = finiteOrUndefined(rec.longShortRatio);
        if (ts === undefined || ratio === undefined) continue;
        if (ts < fromMs || ts > toMs) continue;
        const longPct = finiteOrUndefined(rec.longAccount ?? rec.longPosition);
        const shortPct = finiteOrUndefined(rec.shortAccount ?? rec.shortPosition);
        out.push({
          exchange: EXCHANGE,
          symbol: req.symbol,
          scope,
          ts: new Date(ts),
          ratio: toDecimalString(ratio, 6),
          ...(longPct !== undefined ? { longPct: toDecimalString(longPct, 6) } : {}),
          ...(shortPct !== undefined ? { shortPct: toDecimalString(shortPct, 6) } : {}),
        });
      }
    }
    out.sort((a, b) => a.ts.getTime() - b.ts.getTime());
    log("info", "fetched binance long/short ratios", { symbol: req.symbol, records: out.length });
    return out;
  }

  // ── Option chain (not served here) ───────────────────────────────────────────

  async fetchOptionChain(underlying: string): Promise<NormalizedOptionChain | null> {
    log("info", "binance futures connector serves no option chain (use the eapi venue)", {
      underlying,
    });
    return null;
  }

  // ── Liquidity ────────────────────────────────────────────────────────────────

  async fetchLiquidity(symbol: string): Promise<NormalizedLiquidity | null> {
    const native = PERP_SYMBOLS[symbol];
    if (native === undefined) {
      log("info", "liquidity unsupported for symbol on binance", { symbol });
      return null;
    }
    const book = await this.restGet<DepthResult>("/fapi/v1/depth", {
      symbol: native,
      limit: String(DEPTH_LIMIT),
    });

    const bestBid = finiteOrUndefined(book.bids[0]?.[0]);
    const bestAsk = finiteOrUndefined(book.asks[0]?.[0]);
    const tsMs = finiteOrUndefined(book.T ?? book.E) ?? Date.now();
    if (bestBid === undefined || bestAsk === undefined || bestBid <= 0 || bestAsk <= 0 || bestAsk < bestBid) {
      log("warn", "binance order book unusable — missing/crossed best bid/ask", { symbol });
      return null;
    }

    const mid = (bestBid + bestAsk) / 2;
    const lo = mid * (1 - DEPTH_BAND);
    const hi = mid * (1 + DEPTH_BAND);
    // Futures depth qty is base-asset → USD notional = price * qty.
    let bidDepthUsd = 0;
    for (const [p, q] of book.bids) {
      const price = finiteOrUndefined(p);
      const qty = finiteOrUndefined(q);
      if (price === undefined || qty === undefined) continue;
      if (price >= lo) bidDepthUsd += price * qty;
    }
    let askDepthUsd = 0;
    for (const [p, q] of book.asks) {
      const price = finiteOrUndefined(p);
      const qty = finiteOrUndefined(q);
      if (price === undefined || qty === undefined) continue;
      if (price <= hi) askDepthUsd += price * qty;
    }
    const spreadBps = ((bestAsk - bestBid) / mid) * 10_000;

    return {
      exchange: EXCHANGE,
      symbol,
      ts: new Date(tsMs),
      bidDepthUsd: toDecimalString(bidDepthUsd, 2),
      askDepthUsd: toDecimalString(askDepthUsd, 2),
      spreadBps: toDecimalString(spreadBps, 4),
    };
  }

  // ── Live streaming (WS) ──────────────────────────────────────────────────────

  /**
   * Subscribes (combined stream) to <symbol>@kline_<interval> (candles, emitted
   * on close), @aggTrade (ticks), @bookTicker (best bid/ask), and @markPrice@1s
   * (mark + funding). Auto-reconnects with exponential backoff (1s..60s) and
   * resubscribes; resolves once the socket is first open.
   */
  async streamLive(req: LiveStreamRequest, handlers: LiveHandlers): Promise<LiveSubscription> {
    const interval = INTERVAL_MAP[req.timeframe];
    const timeframe = req.timeframe;
    const streams: string[] = [];
    const symbolByNative = new Map<string, { symbol: string; assetType: AssetType }>();
    for (const s of req.symbols) {
      if (s.assetType === "SPOT") {
        log("info", "skipping spot symbol for binance live stream", { symbol: s.symbol });
        continue;
      }
      const native = PERP_SYMBOLS[s.symbol];
      if (native === undefined) {
        log("warn", "skipping unsupported symbol for binance live stream", { symbol: s.symbol });
        continue;
      }
      const lower = native.toLowerCase();
      symbolByNative.set(native, { symbol: s.symbol, assetType: s.assetType });
      streams.push(`${lower}@kline_${interval}`);
      if (handlers.onTrade !== undefined) streams.push(`${lower}@aggTrade`);
      if (handlers.onQuote !== undefined) streams.push(`${lower}@bookTicker`);
      if (handlers.onQuote !== undefined || handlers.onFunding !== undefined) {
        streams.push(`${lower}@markPrice@1s`);
      }
    }
    if (streams.length === 0) {
      throw new BinanceApiError("no streamable symbols for binance live stream", { endpoint: "ws" });
    }
    const url = `${WS_BASE}?streams=${streams.join("/")}`;

    let ws: WebSocket | null = null;
    let closed = false;
    let reconnectDelayMs = WS_RECONNECT_MIN_MS;
    let reconnectTimer: NodeJS.Timeout | null = null;
    // Latest mark per native symbol (markPrice arrives separately from bookTicker).
    const latestMark = new Map<string, number>();

    const metaFor = (s: unknown): { symbol: string; assetType: AssetType } | undefined =>
      typeof s === "string" ? symbolByNative.get(s) : undefined;

    const handlePayload = (d: Record<string, unknown>): void => {
      const eventType = d["e"];
      if (eventType === "kline") {
        const k = d["k"] as Record<string, unknown> | undefined;
        if (k === undefined || k["x"] !== true) return; // only closed candles
        const meta = metaFor(k["s"]);
        if (meta === undefined) return;
        const ts = finiteOrUndefined(k["t"]);
        const open = finiteOrUndefined(k["o"]);
        const high = finiteOrUndefined(k["h"]);
        const low = finiteOrUndefined(k["l"]);
        const close = finiteOrUndefined(k["c"]);
        const volume = finiteOrUndefined(k["v"]);
        if (ts === undefined || open === undefined || high === undefined || low === undefined || close === undefined || volume === undefined) {
          log("warn", "ws kline payload malformed, dropping", { symbol: meta.symbol });
          return;
        }
        const trades = finiteOrUndefined(k["n"]);
        handlers.onCandle?.({
          exchange: EXCHANGE,
          symbol: meta.symbol,
          assetType: meta.assetType,
          timeframe,
          ts: new Date(ts),
          open: toDecimalString(open, 8),
          high: toDecimalString(high, 8),
          low: toDecimalString(low, 8),
          close: toDecimalString(close, 8),
          volume: toDecimalString(volume, 8),
          ...(trades !== undefined ? { trades: Math.round(trades) } : {}),
        });
        return;
      }
      if (eventType === "aggTrade") {
        if (handlers.onTrade === undefined) return;
        const meta = metaFor(d["s"]);
        if (meta === undefined) return;
        const price = finiteOrUndefined(d["p"]);
        const qty = finiteOrUndefined(d["q"]);
        const tsMs = finiteOrUndefined(d["T"]);
        const aggId = d["a"];
        if (price === undefined || price <= 0 || qty === undefined || tsMs === undefined) return;
        handlers.onTrade({
          exchange: EXCHANGE,
          symbol: meta.symbol,
          ts: new Date(tsMs),
          tradeId: aggId !== undefined ? String(aggId) : `${tsMs}-${toDecimalString(price, 8)}`,
          price: toDecimalString(price, 8),
          size: toDecimalString(qty, 8), // already base-asset
          // m = buyer is maker => the aggressor (taker) SOLD.
          side: d["m"] === true ? "SELL" : "BUY",
        });
        return;
      }
      if (eventType === "bookTicker") {
        if (handlers.onQuote === undefined) return;
        const native = typeof d["s"] === "string" ? (d["s"] as string) : undefined;
        const meta = metaFor(native);
        if (meta === undefined || native === undefined) return;
        const bid = finiteOrUndefined(d["b"]);
        const ask = finiteOrUndefined(d["a"]);
        const bidQty = finiteOrUndefined(d["B"]);
        const askQty = finiteOrUndefined(d["A"]);
        // ts is part of the OrderbookSnapshot PK — drop the frame when the venue
        // omits it (fail-closed) rather than fabricating a non-reproducible clock.
        const tsMs = finiteOrUndefined(d["T"] ?? d["E"]);
        if (tsMs === undefined) return;
        if (bid === undefined || ask === undefined || bid <= 0 || ask <= 0 || ask < bid) return;
        const mid = (bid + ask) / 2;
        const spreadBps = mid > 0 ? ((ask - bid) / mid) * 10_000 : 0;
        const mark = latestMark.get(native);
        handlers.onQuote({
          exchange: EXCHANGE,
          symbol: meta.symbol,
          ts: new Date(tsMs),
          bestBid: toDecimalString(bid, 8),
          bestAsk: toDecimalString(ask, 8),
          bestBidSize: toDecimalString(bidQty ?? 0, 8),
          bestAskSize: toDecimalString(askQty ?? 0, 8),
          ...(mark !== undefined ? { markPrice: toDecimalString(mark, 8) } : {}),
          spreadBps: toDecimalString(spreadBps, 4),
        });
        return;
      }
      if (eventType === "markPriceUpdate") {
        const native = typeof d["s"] === "string" ? (d["s"] as string) : undefined;
        const meta = metaFor(native);
        if (meta === undefined || native === undefined) return;
        const mark = finiteOrUndefined(d["p"]);
        if (mark !== undefined) latestMark.set(native, mark); // mark cache needs no ts
        const funding = finiteOrUndefined(d["r"]);
        // FundingRate ts is part of its PK — only emit when the venue gives a ts
        // (drop fail-closed; never substitute a wall clock for missing PK data).
        const tsMs = finiteOrUndefined(d["E"]);
        if (handlers.onFunding !== undefined && funding !== undefined && tsMs !== undefined) {
          handlers.onFunding({
            exchange: EXCHANGE,
            symbol: meta.symbol,
            ts: new Date(tsMs),
            rate: toDecimalString(funding, 10),
            ...(finiteOrUndefined(d["T"]) !== undefined ? { nextTs: new Date(finiteOrUndefined(d["T"])!) } : {}),
          });
        }
      }
    };

    const handleMessage = (raw: WebSocket.RawData): void => {
      let msg: unknown;
      try {
        msg = JSON.parse(raw.toString());
      } catch (err) {
        log("warn", "ws message not JSON, ignoring", {
          error: err instanceof Error ? err.message : String(err),
        });
        return;
      }
      try {
        // Combined-stream envelope: { stream, data: {...} }.
        const env = msg as { data?: unknown };
        const data = env.data;
        if (data !== undefined && typeof data === "object" && data !== null) {
          handlePayload(data as Record<string, unknown>);
        }
      } catch (err) {
        const e = err instanceof Error ? err : new Error(String(err));
        log("error", "ws message handling failed", { error: e.message });
        handlers.onError?.(e);
      }
    };

    const scheduleReconnect = (): void => {
      if (closed) return;
      const delay = reconnectDelayMs;
      reconnectDelayMs = Math.min(reconnectDelayMs * 2, WS_RECONNECT_MAX_MS);
      log("info", "scheduling binance ws reconnect", { delayMs: delay });
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connect();
      }, delay);
    };

    let connect: () => void = () => undefined;

    const openPromise = new Promise<void>((resolve) => {
      connect = (): void => {
        if (closed) return;
        const socket = new WebSocket(url);
        ws = socket;

        socket.on("open", () => {
          reconnectDelayMs = WS_RECONNECT_MIN_MS;
          log("info", "binance ws connected", { streams: streams.length });
          handlers.onConnected?.();
          resolve();
        });
        socket.on("message", handleMessage);
        socket.on("error", (err: Error) => {
          log("error", "binance ws error", { error: err.message });
          handlers.onError?.(err);
        });
        socket.on("close", (code: number) => {
          const reason = `binance ws closed (code=${code})`;
          log("warn", reason, { willReconnect: !closed });
          handlers.onDisconnected?.(reason);
          if (!closed) scheduleReconnect();
        });
      };
      connect();
    });

    await openPromise;

    return {
      close: async (): Promise<void> => {
        closed = true;
        if (reconnectTimer !== null) {
          clearTimeout(reconnectTimer);
          reconnectTimer = null;
        }
        if (ws !== null) {
          try {
            ws.removeAllListeners("close");
            ws.close(1000, "client close");
          } catch (err) {
            log("warn", "error closing binance ws", {
              error: err instanceof Error ? err.message : String(err),
            });
          }
          ws = null;
        }
        log("info", "binance ws subscription closed");
      },
    };
  }
}

// ── Factory ─────────────────────────────────────────────────────────────────

export function createBinanceConnector(): ExchangeConnector {
  return new BinanceConnector();
}

export default createBinanceConnector;
