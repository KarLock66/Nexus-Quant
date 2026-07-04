/**
 * Deribit connector — PRIMARY venue (options reference + crypto-native derivatives).
 *
 * REST base: https://www.deribit.com/api/v2 (JSON-RPC-over-HTTP envelopes)
 * WS:        wss://www.deribit.com/ws/api/v2
 *
 * Venue notes (documented behaviors, not tunables):
 *  - Deribit lists no canonical SPOT pairs we ingest — SPOT candle requests
 *    return [] with an info log (capability stays true for PERP candles).
 *  - Deribit publishes NO long/short ratio — capability-gated (`longShortRatio:
 *    false`), fetchLongShortRatios returns [] with an info log.
 *  - Perp open interest is quoted in USD: `openInterestValue` = raw
 *    `open_interest`, `openInterest` (base units) = open_interest / index_price
 *    at 8dp. The public API exposes no OI history — fetchOpenInterest returns a
 *    single current snapshot regardless of the requested window (documented
 *    limitation; persistence upserts on (exchange, symbol, ts)).
 *  - Order-book sizes for perps are USD notional, so ±0.5% depth sums are
 *    already in USD.
 *  - Bulk option summaries (`get_book_summary_by_currency`) carry mark_iv
 *    (percent) but no greeks — greeks are computed locally via Black-76
 *    (r = 0, forward = per-contract underlying_price), see black76Greeks().
 *  - skew25d is intentionally omitted: it needs a delta-bucketed vol surface
 *    (25-delta call/put buckets per expiry), which is Phase 3 scope.
 *  - totalGammaExposure is intentionally omitted: it requires dealer
 *    positioning assumptions not derivable from the bulk endpoint.
 *
 * Discipline:
 *  - All numerics leave this module as decimal strings (no float drift across
 *    borders; floats are only used transiently to map venue JSON).
 *  - Fail-closed: malformed/missing critical payload fields throw a typed
 *    DeribitApiError (or return null/[] WITH a logged reason where the
 *    contract allows it) — never silently degrade.
 */

import WebSocket from "ws";
import type { AssetType, OptionType, Timeframe } from "@nexus/core";
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
  NormalizedOptionContract,
} from "./types.js";

// ── Constants ───────────────────────────────────────────────────────────────

const EXCHANGE = "DERIBIT" as const;
const REST_BASE = "https://www.deribit.com/api/v2";
const WS_URL = "wss://www.deribit.com/ws/api/v2";

const REQUEST_TIMEOUT_MS = 15_000;
const MAX_RETRIES = 3; // retries after the initial attempt
const RETRY_BASE_DELAY_MS = 500;
const RATE_LIMIT_INTERVAL_MS = 100; // simple inter-request spacing
const MAX_BARS_PER_REQUEST = 5_000;
const FUNDING_WINDOW_MS = 30 * 24 * 60 * 60 * 1_000; // 30d windows (~90 8h records)
const FUNDING_INTERVAL_MS = 8 * 60 * 60 * 1_000;
const DAY_MS = 24 * 60 * 60 * 1_000;
/** 365-day year convention for time-to-expiry and theta-per-day. */
const YEAR_MS = 365 * DAY_MS;
/**
 * OI snapshot identity grid. Deribit publishes only a CURRENT OI snapshot
 * stamped with the venue's free-running response clock; flooring that ts to a
 * fixed grid before persistence gives the snapshot a DETERMINISTIC identity, so
 * repeated polls within the same slot collapse onto one (exchange, symbol, ts)
 * PK and OVERWRITE instead of inserting a near-duplicate row (idempotent
 * re-runs). 1h matches the OI poll cadence and the demo connector's grid.
 */
const OI_SNAPSHOT_GRID_MS = 60 * 60 * 1_000;
const DEPTH_BAND = 0.005; // ±0.5% of mid
const WS_HEARTBEAT_INTERVAL_S = 30;
const WS_RECONNECT_MIN_MS = 1_000;
const WS_RECONNECT_MAX_MS = 60_000;

/** Canonical -> Deribit-native perp instruments. */
const PERP_INSTRUMENTS: Readonly<Record<string, string>> = {
  "BTC-PERP": "BTC-PERPETUAL",
  "ETH-PERP": "ETH-PERPETUAL",
};

const OPTION_UNDERLYINGS: ReadonlySet<string> = new Set(["BTC", "ETH"]);

/** Timeframe -> TradingView chart resolution. */
const RESOLUTION_MAP: Readonly<Record<Timeframe, string>> = {
  M1: "1",
  M5: "5",
  M15: "15",
  H1: "60",
  H4: "240",
  D1: "1D",
};

const TIMEFRAME_MS: Readonly<Record<Timeframe, number>> = {
  M1: 60_000,
  M5: 300_000,
  M15: 900_000,
  H1: 3_600_000,
  H4: 14_400_000,
  D1: 86_400_000,
};

const MONTHS: Readonly<Record<string, number>> = {
  JAN: 0,
  FEB: 1,
  MAR: 2,
  APR: 3,
  MAY: 4,
  JUN: 5,
  JUL: 6,
  AUG: 7,
  SEP: 8,
  OCT: 9,
  NOV: 10,
  DEC: 11,
};

/** Deribit options expire 08:00 UTC on the expiry date. */
const EXPIRY_HOUR_UTC = 8;

// ── Logging ─────────────────────────────────────────────────────────────────

type LogLevel = "info" | "warn" | "error";

function log(level: LogLevel, msg: string, extra?: Record<string, unknown>): void {
  console.log(
    JSON.stringify({
      ts: new Date().toISOString(),
      service: "ingestion",
      module: "connector.deribit",
      level,
      msg,
      ...extra,
    }),
  );
}

// ── Errors ──────────────────────────────────────────────────────────────────

export class DeribitApiError extends Error {
  readonly endpoint: string;
  readonly httpStatus?: number;
  readonly rpcCode?: number;

  constructor(
    message: string,
    opts: { endpoint: string; httpStatus?: number; rpcCode?: number },
  ) {
    super(message);
    this.name = "DeribitApiError";
    this.endpoint = opts.endpoint;
    if (opts.httpStatus !== undefined) this.httpStatus = opts.httpStatus;
    if (opts.rpcCode !== undefined) this.rpcCode = opts.rpcCode;
  }
}

// ── Decimal-string helpers ──────────────────────────────────────────────────

/**
 * Convert a venue float to a decimal string with at most `dp` fractional
 * digits, trailing zeros trimmed. Throws on non-finite input (fail-closed).
 */
export function toDecimalString(value: number, dp: number): string {
  if (!Number.isFinite(value)) {
    throw new DeribitApiError(`non-finite numeric value: ${String(value)}`, {
      endpoint: "normalize",
    });
  }
  const fixed = value.toFixed(dp);
  let out = fixed;
  if (out.includes(".")) {
    out = out.replace(/0+$/, "").replace(/\.$/, "");
  }
  if (out === "-0") out = "0";
  return out;
}

function finiteOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

// ── Option instrument parsing ───────────────────────────────────────────────

export interface ParsedOptionInstrument {
  underlying: string;
  /** UTC expiry — Deribit options expire 08:00 UTC on the expiry date. */
  expiry: Date;
  strike: string; // decimal string ("d" fractional marker normalized to ".")
  strikeNum: number;
  optionType: OptionType;
}

const OPTION_NAME_RE = /^([A-Z]+)-(\d{1,2})([A-Z]{3})(\d{2})-(\d+(?:d\d+)?)-([CP])$/;

/**
 * Parse a Deribit option instrument name, e.g. "BTC-27JUN26-100000-C" or
 * "ETH-1MAY26-2400-P" (single-digit days allowed). Returns null when the
 * name is not a valid option instrument.
 */
export function parseOptionInstrument(name: string): ParsedOptionInstrument | null {
  const m = OPTION_NAME_RE.exec(name);
  if (m === null) return null;
  const [, underlying, dayStr, monStr, yearStr, strikeRaw, cp] = m;
  if (
    underlying === undefined ||
    dayStr === undefined ||
    monStr === undefined ||
    yearStr === undefined ||
    strikeRaw === undefined ||
    cp === undefined
  ) {
    return null;
  }
  const month = MONTHS[monStr];
  if (month === undefined) return null;
  const day = Number(dayStr);
  const year = 2000 + Number(yearStr);
  const expiry = new Date(Date.UTC(year, month, day, EXPIRY_HOUR_UTC, 0, 0, 0));
  // Reject calendar-invalid dates (e.g. 31FEB rolls over in Date.UTC).
  if (expiry.getUTCDate() !== day || expiry.getUTCMonth() !== month) return null;
  const strike = strikeRaw.replace("d", ".");
  const strikeNum = Number(strike);
  if (!Number.isFinite(strikeNum) || strikeNum <= 0) return null;
  return {
    underlying,
    expiry,
    strike,
    strikeNum,
    optionType: cp === "C" ? "CALL" : "PUT",
  };
}

// ── Black-76 greeks (r = 0) ─────────────────────────────────────────────────

/** Standard normal PDF. */
function normPdf(x: number): number {
  return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
}

/**
 * Standard normal CDF — Zelen & Severo polynomial approximation
 * (Abramowitz & Stegun 26.2.17), |error| < 7.5e-8. Network-free, no deps.
 */
function normCdf(x: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const poly =
    t *
    (0.319381530 +
      t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  const tail = normPdf(Math.abs(x)) * poly;
  return x >= 0 ? 1 - tail : tail;
}

export interface Black76GreeksResult {
  delta: number; // CALL in (0,1), PUT in (-1,0)
  gamma: number; // d(delta)/d(forward)
  thetaPerDay: number; // per calendar day (365-day year)
  vega: number; // per 1 vol point (i.e. per 1% IV move)
}

/**
 * Black-76 greeks with r = 0 (Deribit options are coin-margined; we treat the
 * per-contract underlying_price as the forward and discounting as 1):
 *   d1 = (ln(F/K) + 0.5σ²T) / (σ√T)
 *   call delta = N(d1), put delta = N(d1) - 1
 *   gamma = φ(d1) / (F σ √T)
 *   theta/day = -(F φ(d1) σ) / (2√T) / 365   (same for call and put at r=0)
 *   vega/1%  = F φ(d1) √T / 100
 * Returns null for non-positive/non-finite inputs (expired or degenerate
 * contracts) — callers omit greek fields rather than emitting garbage.
 */
export function black76Greeks(input: {
  optionType: OptionType;
  forward: number;
  strike: number;
  iv: number; // decimal, e.g. 0.55 for 55%
  ttYears: number;
}): Black76GreeksResult | null {
  const { optionType, forward, strike, iv, ttYears } = input;
  if (
    !Number.isFinite(forward) ||
    !Number.isFinite(strike) ||
    !Number.isFinite(iv) ||
    !Number.isFinite(ttYears) ||
    forward <= 0 ||
    strike <= 0 ||
    iv <= 0 ||
    ttYears <= 0
  ) {
    return null;
  }
  const sqrtT = Math.sqrt(ttYears);
  const d1 = (Math.log(forward / strike) + 0.5 * iv * iv * ttYears) / (iv * sqrtT);
  const pdfD1 = normPdf(d1);
  const delta = optionType === "CALL" ? normCdf(d1) : normCdf(d1) - 1;
  const gamma = pdfD1 / (forward * iv * sqrtT);
  const thetaPerDay = -((forward * pdfD1 * iv) / (2 * sqrtT)) / 365;
  const vega = (forward * pdfD1 * sqrtT) / 100;
  return { delta, gamma, thetaPerDay, vega };
}

// ── Small math helpers ──────────────────────────────────────────────────────

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid] ?? null;
  const lo = sorted[mid - 1];
  const hi = sorted[mid];
  return lo !== undefined && hi !== undefined ? (lo + hi) / 2 : null;
}

/**
 * Linear interpolation of ATM IV to `targetDays`. Clamps to the nearest
 * endpoint outside the observed expiry range (documented choice — no
 * extrapolation beyond the curve). Returns null with fewer than 2 points.
 */
function interpolateIv(
  points: ReadonlyArray<{ days: number; iv: number }>,
  targetDays: number,
): number | null {
  if (points.length < 2) return null;
  const sorted = [...points].sort((a, b) => a.days - b.days);
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  if (first === undefined || last === undefined) return null;
  if (targetDays <= first.days) return first.iv;
  if (targetDays >= last.days) return last.iv;
  for (let i = 0; i < sorted.length - 1; i++) {
    const a = sorted[i];
    const b = sorted[i + 1];
    if (a === undefined || b === undefined) continue;
    if (targetDays >= a.days && targetDays <= b.days) {
      if (b.days === a.days) return a.iv;
      const w = (targetDays - a.days) / (b.days - a.days);
      return a.iv + w * (b.iv - a.iv);
    }
  }
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Venue payload shapes (subset of fields we consume) ──────────────────────

interface DeribitRpcEnvelope<T> {
  jsonrpc?: string;
  id?: number;
  result?: T;
  error?: { code: number; message: string };
}

interface ChartDataResult {
  status: string; // "ok" | "no_data"
  ticks: number[]; // bar OPEN times, epoch ms
  open: number[];
  high: number[];
  low: number[];
  close: number[];
  volume: number[];
  cost?: number[];
}

interface FundingRateRecord {
  timestamp: number; // epoch ms
  interest_8h: number;
  interest_1h?: number;
  index_price?: number;
  prev_index_price?: number;
}

interface TickerResult {
  timestamp: number;
  open_interest: number; // USD notional for perps
  index_price: number;
}

interface BookSummaryEntry {
  instrument_name: string;
  mark_price?: number | null;
  mark_iv?: number | null; // percent, e.g. 55.4
  open_interest?: number | null;
  volume?: number | null;
  bid_price?: number | null;
  ask_price?: number | null;
  underlying_price?: number | null;
}

interface OrderBookResult {
  timestamp: number;
  best_bid_price: number;
  best_ask_price: number;
  bids: Array<[number, number]>; // [price, amount-USD] for perps
  asks: Array<[number, number]>;
}

interface ChartNotificationData {
  tick: number; // bar OPEN time, epoch ms
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  cost?: number;
}

/** `ticker.{instrument}.{interval}` payload (subset consumed). */
interface TickerNotificationData {
  timestamp: number;
  best_bid_price?: number | null;
  best_ask_price?: number | null;
  best_bid_amount?: number | null; // USD notional for perps
  best_ask_amount?: number | null;
  mark_price?: number | null;
  index_price?: number | null;
  current_funding?: number | null; // instantaneous funding (perp)
  funding_8h?: number | null; // 8h funding rate
}

/** One entry of a `trades.{instrument}.{interval}` payload array. */
interface TradeNotificationEntry {
  trade_id?: string | number;
  price?: number;
  amount?: number; // USD notional for perps
  direction?: string; // "buy" | "sell" (taker side)
  timestamp?: number;
}

interface WsInboundMessage {
  id?: number;
  method?: string;
  params?: {
    type?: string;
    channel?: string;
    // Channel-dependent: chart -> ChartNotificationData, ticker -> object,
    // trades -> array. Narrowed per channel kind in handleMessage.
    data?: unknown;
  };
  error?: { code: number; message: string };
}

// ── Connector ───────────────────────────────────────────────────────────────

class DeribitConnector implements ExchangeConnector {
  readonly exchange = EXCHANGE;
  readonly capabilities: ConnectorCapabilities = {
    candles: true,
    funding: true,
    openInterest: true,
    longShortRatio: false, // Deribit publishes no LSR — capability-gated
    optionChain: true,
    liquidity: true,
  };

  private lastRequestAt = 0;

  // ── REST plumbing ────────────────────────────────────────────────────────

  /** Simple inter-request spacing (100ms) to respect venue rate limits. */
  private async throttle(): Promise<void> {
    const now = Date.now();
    const earliest = this.lastRequestAt + RATE_LIMIT_INTERVAL_MS;
    this.lastRequestAt = Math.max(now, earliest);
    const wait = earliest - now;
    if (wait > 0) await sleep(wait);
  }

  /**
   * GET with 15s timeout; retries up to MAX_RETRIES times with exponential
   * backoff on 429/5xx/network/timeout. JSON-RPC errors and other 4xx are
   * fatal (no retry). Throws DeribitApiError after exhaustion.
   */
  private async restGet<T>(path: string, params: Record<string, string>): Promise<T> {
    const url = `${REST_BASE}${path}?${new URLSearchParams(params).toString()}`;
    let lastErr: DeribitApiError | undefined;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (attempt > 0) {
        const backoffMs = RETRY_BASE_DELAY_MS * 2 ** (attempt - 1);
        log("warn", "retrying deribit request", {
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
        lastErr = new DeribitApiError(
          `network/timeout failure: ${err instanceof Error ? err.message : String(err)}`,
          { endpoint: path },
        );
        continue; // transient
      }

      if (res.status === 429 || res.status >= 500) {
        lastErr = new DeribitApiError(`HTTP ${res.status} from Deribit`, {
          endpoint: path,
          httpStatus: res.status,
        });
        continue; // transient
      }

      let body: unknown;
      try {
        body = await res.json();
      } catch (err) {
        lastErr = new DeribitApiError(
          `invalid JSON body: ${err instanceof Error ? err.message : String(err)}`,
          { endpoint: path, httpStatus: res.status },
        );
        continue;
      }

      const envelope = body as DeribitRpcEnvelope<T>;
      if (envelope.error !== undefined) {
        throw new DeribitApiError(
          `Deribit RPC error ${envelope.error.code}: ${envelope.error.message}`,
          { endpoint: path, httpStatus: res.status, rpcCode: envelope.error.code },
        );
      }
      if (!res.ok) {
        throw new DeribitApiError(`HTTP ${res.status} from Deribit`, {
          endpoint: path,
          httpStatus: res.status,
        });
      }
      if (envelope.result === undefined) {
        throw new DeribitApiError("missing result in Deribit response", {
          endpoint: path,
          httpStatus: res.status,
        });
      }
      return envelope.result;
    }

    throw (
      lastErr ??
      new DeribitApiError("request failed after retries", { endpoint: path })
    );
  }

  private requirePerpInstrument(symbol: string, endpoint: string): string {
    const instrument = PERP_INSTRUMENTS[symbol];
    if (instrument === undefined) {
      throw new DeribitApiError(
        `unsupported symbol for Deribit: ${symbol} (supported: ${Object.keys(PERP_INSTRUMENTS).join(", ")})`,
        { endpoint },
      );
    }
    return instrument;
  }

  // ── Candles ──────────────────────────────────────────────────────────────

  async fetchCandles(req: CandleBackfillRequest): Promise<NormalizedCandle[]> {
    if (req.assetType === "SPOT") {
      // Deribit is not a spot reference venue — skipped by design, not an error.
      log("info", "spot candles not supported on deribit, returning empty", {
        symbol: req.symbol,
        timeframe: req.timeframe,
      });
      return [];
    }
    const instrument = this.requirePerpInstrument(req.symbol, "/public/get_tradingview_chart_data");
    const resolution = RESOLUTION_MAP[req.timeframe];
    const tfMs = TIMEFRAME_MS[req.timeframe];
    const fromMs = req.from.getTime();
    const toMs = req.to.getTime();
    if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs < fromMs) {
      throw new DeribitApiError(
        `invalid candle window: from=${req.from.toISOString()} to=${req.to.toISOString()}`,
        { endpoint: "/public/get_tradingview_chart_data" },
      );
    }

    const out = new Map<number, NormalizedCandle>();
    const windowMs = MAX_BARS_PER_REQUEST * tfMs;
    let pages = 0;

    for (let cursor = fromMs; cursor <= toMs; cursor += windowMs) {
      const chunkEnd = Math.min(cursor + windowMs - tfMs, toMs);
      const result = await this.restGet<ChartDataResult>(
        "/public/get_tradingview_chart_data",
        {
          instrument_name: instrument,
          resolution,
          start_timestamp: String(cursor),
          end_timestamp: String(chunkEnd),
        },
      );
      pages++;
      if (result.status === "no_data") continue;
      if (result.status !== "ok") {
        throw new DeribitApiError(`chart data status "${result.status}"`, {
          endpoint: "/public/get_tradingview_chart_data",
        });
      }
      for (let i = 0; i < result.ticks.length; i++) {
        const ts = result.ticks[i];
        const open = result.open[i];
        const high = result.high[i];
        const low = result.low[i];
        const close = result.close[i];
        const volume = result.volume[i];
        if (
          ts === undefined ||
          open === undefined ||
          high === undefined ||
          low === undefined ||
          close === undefined ||
          volume === undefined
        ) {
          // Fail-closed: ragged arrays mean a corrupt payload, not "fewer bars".
          throw new DeribitApiError("ragged chart data arrays", {
            endpoint: "/public/get_tradingview_chart_data",
          });
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
        });
      }
    }

    const candles = [...out.values()].sort((a, b) => a.ts.getTime() - b.ts.getTime());
    log("info", "fetched deribit candles", {
      symbol: req.symbol,
      timeframe: req.timeframe,
      pages,
      bars: candles.length,
    });
    return candles;
  }

  // ── Funding ──────────────────────────────────────────────────────────────

  async fetchFundingRates(req: FlowBackfillRequest): Promise<NormalizedFundingRate[]> {
    const instrument = this.requirePerpInstrument(req.symbol, "/public/get_funding_rate_history");
    const fromMs = req.from.getTime();
    const toMs = req.to.getTime();
    if (toMs < fromMs) {
      throw new DeribitApiError("invalid funding window (to < from)", {
        endpoint: "/public/get_funding_rate_history",
      });
    }

    const out = new Map<number, NormalizedFundingRate>();
    for (let cursor = fromMs; cursor <= toMs; cursor += FUNDING_WINDOW_MS) {
      const chunkEnd = Math.min(cursor + FUNDING_WINDOW_MS, toMs);
      const records = await this.restGet<FundingRateRecord[]>(
        "/public/get_funding_rate_history",
        {
          instrument_name: instrument,
          start_timestamp: String(cursor),
          end_timestamp: String(chunkEnd),
        },
      );
      for (const rec of records) {
        const ts = finiteOrUndefined(rec.timestamp);
        const rate = finiteOrUndefined(rec.interest_8h);
        if (ts === undefined || rate === undefined) {
          throw new DeribitApiError("funding record missing timestamp/interest_8h", {
            endpoint: "/public/get_funding_rate_history",
          });
        }
        if (ts < fromMs || ts > toMs) continue;
        out.set(ts, {
          exchange: EXCHANGE,
          symbol: req.symbol,
          ts: new Date(ts),
          rate: toDecimalString(rate, 10),
          // Deribit publishes 8h funding records; next accrual is +8h.
          nextTs: new Date(ts + FUNDING_INTERVAL_MS),
        });
      }
    }

    const rates = [...out.values()].sort((a, b) => a.ts.getTime() - b.ts.getTime());
    log("info", "fetched deribit funding rates", {
      symbol: req.symbol,
      records: rates.length,
    });
    return rates;
  }

  // ── Open interest ────────────────────────────────────────────────────────

  /**
   * Deribit's public REST API exposes no OI history; this returns a single
   * CURRENT snapshot from /public/ticker (the from/to window is accepted for
   * interface parity and ignored — logged so the limitation is visible).
   * Perp OI is quoted in USD: openInterestValue = open_interest (USD),
   * openInterest = open_interest / index_price (base units, 8dp).
   *
   * The snapshot ts is the venue ticker time FLOORED to OI_SNAPSHOT_GRID_MS so
   * the (exchange, symbol, ts) identity is deterministic — re-running a backfill
   * within the same slot overwrites the existing row instead of duplicating it.
   */
  async fetchOpenInterest(req: FlowBackfillRequest): Promise<NormalizedOpenInterest[]> {
    const instrument = this.requirePerpInstrument(req.symbol, "/public/ticker");
    const ticker = await this.restGet<TickerResult>("/public/ticker", {
      instrument_name: instrument,
    });

    const oiUsd = finiteOrUndefined(ticker.open_interest);
    const indexPrice = finiteOrUndefined(ticker.index_price);
    const tsMs = finiteOrUndefined(ticker.timestamp);
    if (oiUsd === undefined || indexPrice === undefined || indexPrice <= 0 || tsMs === undefined) {
      // Fail-closed: a ticker without OI/index is a broken payload.
      throw new DeribitApiError(
        "ticker missing open_interest/index_price/timestamp — cannot derive OI snapshot",
        { endpoint: "/public/ticker" },
      );
    }

    // Floor the venue clock to the OI grid so same-slot re-runs share a PK and
    // overwrite (idempotent identity) rather than appending duplicate rows.
    const snapshotMs = Math.floor(tsMs / OI_SNAPSHOT_GRID_MS) * OI_SNAPSHOT_GRID_MS;

    log("info", "deribit OI is current-snapshot only (no history endpoint)", {
      symbol: req.symbol,
      requestedFrom: req.from.toISOString(),
      requestedTo: req.to.toISOString(),
      snapshotTs: new Date(snapshotMs).toISOString(),
    });

    return [
      {
        exchange: EXCHANGE,
        symbol: req.symbol,
        ts: new Date(snapshotMs),
        openInterest: toDecimalString(oiUsd / indexPrice, 8),
        openInterestValue: toDecimalString(oiUsd, 2),
      },
    ];
  }

  // ── Long/short ratio (not published by Deribit) ──────────────────────────

  async fetchLongShortRatios(req: FlowBackfillRequest): Promise<NormalizedLongShortRatio[]> {
    log("info", "deribit publishes no long/short ratio — capability-gated, returning empty", {
      symbol: req.symbol,
    });
    return [];
  }

  // ── Option chain ─────────────────────────────────────────────────────────

  async fetchOptionChain(underlying: string): Promise<NormalizedOptionChain | null> {
    const u = underlying.toUpperCase();
    if (!OPTION_UNDERLYINGS.has(u)) {
      log("warn", "unsupported option underlying for deribit", { underlying });
      return null;
    }

    const summaries = await this.restGet<BookSummaryEntry[]>(
      "/public/get_book_summary_by_currency",
      { currency: u, kind: "option" },
    );

    const ts = new Date(); // single snapshot time shared by chain row + contracts
    const tsMs = ts.getTime();
    const contracts: NormalizedOptionContract[] = [];
    const underlyingPrices: number[] = [];
    const atmCandidates: Array<{ expiryMs: number; strikeNum: number; iv: number }> = [];
    let callOi = 0;
    let putOi = 0;
    let skipped = 0;

    for (const entry of summaries) {
      const parsed = parseOptionInstrument(entry.instrument_name);
      if (parsed === null || parsed.underlying !== u) {
        skipped++;
        continue;
      }

      const underlyingPrice = finiteOrUndefined(entry.underlying_price);
      if (underlyingPrice !== undefined && underlyingPrice > 0) {
        underlyingPrices.push(underlyingPrice);
      }

      // mark_iv arrives as a percent (e.g. 55.4) — normalize to decimal.
      const markIvPct = finiteOrUndefined(entry.mark_iv);
      const iv = markIvPct !== undefined ? markIvPct / 100 : undefined;

      const ttYears = (parsed.expiry.getTime() - tsMs) / YEAR_MS;
      const greeks =
        iv !== undefined && underlyingPrice !== undefined && underlyingPrice > 0
          ? black76Greeks({
              optionType: parsed.optionType,
              forward: underlyingPrice,
              strike: parsed.strikeNum,
              iv,
              ttYears,
            })
          : null;

      const openInterest = finiteOrUndefined(entry.open_interest);
      if (openInterest !== undefined) {
        if (parsed.optionType === "CALL") callOi += openInterest;
        else putOi += openInterest;
      }
      const volume = finiteOrUndefined(entry.volume);
      const bid = finiteOrUndefined(entry.bid_price);
      const ask = finiteOrUndefined(entry.ask_price);
      const markPrice = finiteOrUndefined(entry.mark_price);

      if (iv !== undefined && iv > 0) {
        atmCandidates.push({
          expiryMs: parsed.expiry.getTime(),
          strikeNum: parsed.strikeNum,
          iv,
        });
      }

      contracts.push({
        exchange: EXCHANGE,
        underlying: u,
        ts,
        expiry: parsed.expiry,
        strike: parsed.strike,
        optionType: parsed.optionType,
        ...(iv !== undefined ? { iv: toDecimalString(iv, 6) } : {}),
        ...(greeks !== null
          ? {
              delta: toDecimalString(greeks.delta, 6),
              gamma: toDecimalString(greeks.gamma, 10),
              theta: toDecimalString(greeks.thetaPerDay, 6),
              vega: toDecimalString(greeks.vega, 6),
            }
          : {}),
        ...(openInterest !== undefined ? { openInterest: toDecimalString(openInterest, 8) } : {}),
        ...(volume !== undefined ? { volume: toDecimalString(volume, 8) } : {}),
        ...(bid !== undefined ? { bid: toDecimalString(bid, 8) } : {}),
        ...(ask !== undefined ? { ask: toDecimalString(ask, 8) } : {}),
        ...(markPrice !== undefined ? { markPrice: toDecimalString(markPrice, 8) } : {}),
      });
    }

    const spotNum = median(underlyingPrices);
    if (contracts.length === 0 || spotNum === null) {
      // Fail-closed: an empty/unpriceable chain is a skipped snapshot, never a
      // silently degraded one.
      log("warn", "deribit option chain unusable — no parseable contracts or no underlying prices", {
        underlying: u,
        summaries: summaries.length,
        parseableContracts: contracts.length,
        skipped,
      });
      return null;
    }
    if (skipped > 0) {
      log("warn", "skipped unparseable option instruments", { underlying: u, skipped });
    }

    // Term structure: per expiry, the IV of the strike nearest spot.
    const byExpiry = new Map<number, { dist: number; iv: number }>();
    for (const c of atmCandidates) {
      const dist = Math.abs(c.strikeNum - spotNum);
      const cur = byExpiry.get(c.expiryMs);
      if (cur === undefined || dist < cur.dist) {
        byExpiry.set(c.expiryMs, { dist, iv: c.iv });
      }
    }
    const termPoints = [...byExpiry.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([expiryMs, v]) => ({ expiryMs, iv: v.iv }));
    const termStructure = termPoints.map((p) => ({
      expiry: new Date(p.expiryMs).toISOString(),
      atmIv: toDecimalString(p.iv, 6),
    }));

    // ATM 30d IV: linear interpolation of the term structure to 30 days
    // (clamped at the curve ends); null when fewer than 2 expiries exist.
    const ivAtm30 = interpolateIv(
      termPoints.map((p) => ({ days: (p.expiryMs - tsMs) / DAY_MS, iv: p.iv })),
      30,
    );

    const putCallRatio = callOi > 0 ? putOi / callOi : null;

    const chain: NormalizedOptionChain = {
      exchange: EXCHANGE,
      underlying: u,
      ts,
      spot: toDecimalString(spotNum, 8),
      contracts,
      ...(putCallRatio !== null ? { putCallRatio: toDecimalString(putCallRatio, 4) } : {}),
      ...(termStructure.length > 0 ? { termStructure } : {}),
      ...(ivAtm30 !== null ? { ivAtm30d: toDecimalString(ivAtm30, 6) } : {}),
      // skew25d omitted: needs a delta-bucketed vol surface (Phase 3 scope).
      // totalGammaExposure omitted: requires dealer-positioning assumptions
      // not derivable from the bulk book-summary endpoint.
    };

    log("info", "fetched deribit option chain", {
      underlying: u,
      contracts: contracts.length,
      expiries: termStructure.length,
      skipped,
    });
    return chain;
  }

  // ── Liquidity ────────────────────────────────────────────────────────────

  async fetchLiquidity(symbol: string): Promise<NormalizedLiquidity | null> {
    const instrument = PERP_INSTRUMENTS[symbol];
    if (instrument === undefined) {
      log("info", "liquidity unsupported for symbol on deribit", { symbol });
      return null;
    }

    const book = await this.restGet<OrderBookResult>("/public/get_order_book", {
      instrument_name: instrument,
      depth: "50",
    });

    const bestBid = finiteOrUndefined(book.best_bid_price);
    const bestAsk = finiteOrUndefined(book.best_ask_price);
    const tsMs = finiteOrUndefined(book.timestamp);
    if (
      bestBid === undefined ||
      bestAsk === undefined ||
      tsMs === undefined ||
      bestBid <= 0 ||
      bestAsk <= 0 ||
      bestAsk < bestBid
    ) {
      log("warn", "deribit order book unusable — missing/crossed best bid/ask", {
        symbol,
        bestBid: book.best_bid_price,
        bestAsk: book.best_ask_price,
      });
      return null;
    }

    const mid = (bestBid + bestAsk) / 2;
    const lo = mid * (1 - DEPTH_BAND);
    const hi = mid * (1 + DEPTH_BAND);
    // Perp order-book amounts are USD notional, so the sums are already USD.
    let bidDepthUsd = 0;
    for (const level of book.bids) {
      const [price, amount] = level;
      if (price === undefined || amount === undefined) continue;
      if (price >= lo) bidDepthUsd += amount;
    }
    let askDepthUsd = 0;
    for (const level of book.asks) {
      const [price, amount] = level;
      if (price === undefined || amount === undefined) continue;
      if (price <= hi) askDepthUsd += amount;
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

  // ── Live streaming (WS) ──────────────────────────────────────────────────

  /**
   * Subscribes to chart.trades (candles) plus — for the Phase 9 live tick feed —
   * ticker (best bid/ask, mark, funding, volume) and trades (raw prints) channels
   * per instrument. Auto-reconnects with exponential backoff (1s..60s) and
   * resubscribes; responds to Deribit heartbeat test_requests. Resolves once the
   * socket is open for the first time; keeps retrying in the background thereafter.
   */
  async streamLive(req: LiveStreamRequest, handlers: LiveHandlers): Promise<LiveSubscription> {
    const resolution = RESOLUTION_MAP[req.timeframe];
    // ticker/trades push intervals (Deribit-supported coarsest batched cadence).
    const TICK_INTERVAL = "100ms";
    type ChannelKind = "candle" | "ticker" | "trades";
    const channelMeta = new Map<
      string,
      { symbol: string; assetType: AssetType; kind: ChannelKind }
    >();
    for (const s of req.symbols) {
      if (s.assetType === "SPOT") {
        log("info", "skipping spot symbol for deribit live stream", { symbol: s.symbol });
        continue;
      }
      const instrument = PERP_INSTRUMENTS[s.symbol];
      if (instrument === undefined) {
        log("warn", "skipping unsupported symbol for deribit live stream", { symbol: s.symbol });
        continue;
      }
      channelMeta.set(`chart.trades.${instrument}.${resolution}`, {
        symbol: s.symbol,
        assetType: s.assetType,
        kind: "candle",
      });
      // Phase 9 tick feed: only subscribe ticker/trades when a handler wants them
      // (keeps the candle-only path byte-for-byte for existing callers).
      if (handlers.onQuote !== undefined || handlers.onFunding !== undefined) {
        channelMeta.set(`ticker.${instrument}.${TICK_INTERVAL}`, {
          symbol: s.symbol,
          assetType: s.assetType,
          kind: "ticker",
        });
      }
      if (handlers.onTrade !== undefined) {
        channelMeta.set(`trades.${instrument}.${TICK_INTERVAL}`, {
          symbol: s.symbol,
          assetType: s.assetType,
          kind: "trades",
        });
      }
    }
    if (channelMeta.size === 0) {
      throw new DeribitApiError("no streamable symbols for deribit live stream", {
        endpoint: "ws",
      });
    }
    const channels = [...channelMeta.keys()];
    const timeframe = req.timeframe;

    let ws: WebSocket | null = null;
    let closed = false;
    let reconnectDelayMs = WS_RECONNECT_MIN_MS;
    let reconnectTimer: NodeJS.Timeout | null = null;
    let rpcId = 1;

    const send = (method: string, params: Record<string, unknown>): void => {
      if (ws === null || ws.readyState !== WebSocket.OPEN) return;
      try {
        ws.send(JSON.stringify({ jsonrpc: "2.0", id: rpcId++, method, params }));
      } catch (err) {
        log("error", "ws send failed", { error: err instanceof Error ? err.message : String(err) });
      }
    };

    type ChannelInfo = { symbol: string; assetType: AssetType; kind: ChannelKind };

    const handleCandleData = (meta: ChannelInfo, raw: unknown): void => {
      const data = raw as ChartNotificationData;
      if (
        !Number.isFinite(data.tick) ||
        !Number.isFinite(data.open) ||
        !Number.isFinite(data.high) ||
        !Number.isFinite(data.low) ||
        !Number.isFinite(data.close) ||
        !Number.isFinite(data.volume)
      ) {
        log("warn", "ws candle payload malformed, dropping", { symbol: meta.symbol });
        return;
      }
      handlers.onCandle?.({
        exchange: EXCHANGE,
        symbol: meta.symbol,
        assetType: meta.assetType,
        timeframe,
        ts: new Date(data.tick),
        open: toDecimalString(data.open, 8),
        high: toDecimalString(data.high, 8),
        low: toDecimalString(data.low, 8),
        close: toDecimalString(data.close, 8),
        volume: toDecimalString(data.volume, 8),
      });
    };

    const handleTickerData = (meta: ChannelInfo, raw: unknown): void => {
      const data = raw as TickerNotificationData;
      const tsMs = finiteOrUndefined(data.timestamp);
      const bid = finiteOrUndefined(data.best_bid_price ?? undefined);
      const ask = finiteOrUndefined(data.best_ask_price ?? undefined);
      if (tsMs === undefined) return;
      const ts = new Date(tsMs);

      // Top-of-book quote (best bid/ask + mark). Deribit perp best_*_amount are in
      // USD notional → base-asset size = amount / price (matches OI normalization).
      if (handlers.onQuote !== undefined && bid !== undefined && ask !== undefined && bid > 0 && ask > 0) {
        const bidAmtUsd = finiteOrUndefined(data.best_bid_amount ?? undefined);
        const askAmtUsd = finiteOrUndefined(data.best_ask_amount ?? undefined);
        const mark = finiteOrUndefined(data.mark_price ?? undefined);
        const mid = (bid + ask) / 2;
        const spreadBps = mid > 0 ? ((ask - bid) / mid) * 10_000 : 0;
        handlers.onQuote({
          exchange: EXCHANGE,
          symbol: meta.symbol,
          ts,
          bestBid: toDecimalString(bid, 8),
          bestAsk: toDecimalString(ask, 8),
          bestBidSize: toDecimalString(bidAmtUsd !== undefined ? bidAmtUsd / bid : 0, 8),
          bestAskSize: toDecimalString(askAmtUsd !== undefined ? askAmtUsd / ask : 0, 8),
          ...(mark !== undefined ? { markPrice: toDecimalString(mark, 8) } : {}),
          spreadBps: toDecimalString(spreadBps, 4),
        });
      }

      // Funding update (8h rate), emitted for the daemon to throttle/persist.
      const funding8h = finiteOrUndefined(data.funding_8h ?? undefined);
      if (handlers.onFunding !== undefined && funding8h !== undefined) {
        handlers.onFunding({
          exchange: EXCHANGE,
          symbol: meta.symbol,
          ts,
          rate: toDecimalString(funding8h, 10),
        });
      }
    };

    const handleTradesData = (meta: ChannelInfo, raw: unknown): void => {
      if (handlers.onTrade === undefined || !Array.isArray(raw)) return;
      for (const entry of raw as TradeNotificationEntry[]) {
        const price = finiteOrUndefined(entry.price);
        const amountUsd = finiteOrUndefined(entry.amount);
        const tsMs = finiteOrUndefined(entry.timestamp);
        if (price === undefined || price <= 0 || amountUsd === undefined || tsMs === undefined) {
          continue; // skip a single malformed print, never the batch
        }
        const tradeId =
          entry.trade_id !== undefined ? String(entry.trade_id) : `${tsMs}-${toDecimalString(price, 8)}`;
        handlers.onTrade({
          exchange: EXCHANGE,
          symbol: meta.symbol,
          ts: new Date(tsMs),
          tradeId,
          price: toDecimalString(price, 8),
          size: toDecimalString(amountUsd / price, 8), // USD notional → base units
          side: entry.direction === "sell" ? "SELL" : "BUY",
        });
      }
    };

    const handleMessage = (raw: WebSocket.RawData): void => {
      let msg: WsInboundMessage;
      try {
        msg = JSON.parse(raw.toString()) as WsInboundMessage;
      } catch (err) {
        log("warn", "ws message not JSON, ignoring", {
          error: err instanceof Error ? err.message : String(err),
        });
        return;
      }
      try {
        if (msg.method === "heartbeat") {
          if (msg.params?.type === "test_request") {
            // Required keep-alive response or Deribit drops the connection.
            send("public/test", {});
          }
          return;
        }
        if (msg.method === "subscription") {
          const channel = msg.params?.channel;
          const data = msg.params?.data;
          if (channel === undefined || data === undefined) return;
          const meta = channelMeta.get(channel);
          if (meta === undefined) return;
          if (meta.kind === "candle") {
            handleCandleData(meta, data);
          } else if (meta.kind === "ticker") {
            handleTickerData(meta, data);
          } else {
            handleTradesData(meta, data);
          }
          return;
        }
        if (msg.error !== undefined) {
          handlers.onError?.(
            new DeribitApiError(`ws RPC error ${msg.error.code}: ${msg.error.message}`, {
              endpoint: "ws",
              rpcCode: msg.error.code,
            }),
          );
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
      log("info", "scheduling ws reconnect", { delayMs: delay });
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connect();
      }, delay);
    };

    let connect: () => void = () => undefined;

    const openPromise = new Promise<void>((resolve) => {
      connect = (): void => {
        if (closed) return;
        const socket = new WebSocket(WS_URL);
        ws = socket;

        socket.on("open", () => {
          reconnectDelayMs = WS_RECONNECT_MIN_MS; // reset backoff on success
          send("public/set_heartbeat", { interval: WS_HEARTBEAT_INTERVAL_S });
          send("public/subscribe", { channels }); // (re)subscribe every connect
          log("info", "deribit ws connected", { channels });
          handlers.onConnected?.();
          resolve();
        });

        socket.on("message", handleMessage);

        socket.on("error", (err: Error) => {
          log("error", "deribit ws error", { error: err.message });
          handlers.onError?.(err);
        });

        socket.on("close", (code: number) => {
          const reason = `deribit ws closed (code=${code})`;
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
            ws.removeAllListeners("close"); // no reconnect on intentional close
            ws.close(1000, "client close");
          } catch (err) {
            log("warn", "error closing deribit ws", {
              error: err instanceof Error ? err.message : String(err),
            });
          }
          ws = null;
        }
        log("info", "deribit ws subscription closed");
      },
    };
  }
}

// ── Factory ─────────────────────────────────────────────────────────────────

export function createDeribitConnector(): ExchangeConnector {
  return new DeribitConnector();
}

export default createDeribitConnector;
