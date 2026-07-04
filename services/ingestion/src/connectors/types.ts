/**
 * Connector contract — the single interface every venue implements
 * (Deribit primary, Binance secondary, Bybit tertiary, Demo offline).
 *
 * Rules:
 *  - Connectors are pure data sources: fetch + map to canonical shapes.
 *    No persistence, no DQ decisions, no event publishing here.
 *  - All numeric market values travel as strings (decimal discipline:
 *    Decimal at rest in Postgres, no float drift across borders).
 *  - Canonical symbols: `BTC-USDT` (spot), `BTC-PERP` (perpetual),
 *    underlyings `BTC` | `ETH` for options. Mapping canonical -> venue-native
 *    happens inside each connector (see normalize.ts).
 *  - Public endpoints only — no API keys required in any mode.
 */

import type {
  AssetType,
  Exchange,
  LsRatioScope,
  OptionType,
  Timeframe,
} from "@nexus/core";

// ── Canonical (normalized) records ─────────────────────────────────────────

export interface NormalizedCandle {
  exchange: Exchange;
  symbol: string; // canonical
  assetType: AssetType;
  timeframe: Timeframe;
  ts: Date; // bar OPEN time, UTC
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
  trades?: number;
}

export interface NormalizedFundingRate {
  exchange: Exchange;
  symbol: string;
  ts: Date;
  rate: string;
  nextTs?: Date;
}

export interface NormalizedOpenInterest {
  exchange: Exchange;
  symbol: string;
  ts: Date;
  openInterest: string;
  openInterestValue: string; // USD notional
  // oiDelta/oiDeltaPct are NOT set by connectors — persistence computes them
  // against the previous stored row (single source of truth).
}

export interface NormalizedLongShortRatio {
  exchange: Exchange;
  symbol: string;
  scope: LsRatioScope;
  ts: Date;
  ratio: string; // long / short
  longPct?: string;
  shortPct?: string;
}

export interface NormalizedOptionContract {
  exchange: Exchange;
  underlying: string; // BTC | ETH
  ts: Date; // chain snapshot time (shared with the chain aggregate row)
  expiry: Date;
  strike: string;
  optionType: OptionType;
  iv?: string;
  delta?: string;
  gamma?: string;
  theta?: string;
  vega?: string;
  openInterest?: string;
  volume?: string;
  bid?: string;
  ask?: string;
  markPrice?: string;
}

export interface NormalizedOptionChain {
  exchange: Exchange;
  underlying: string;
  ts: Date;
  spot: string;
  /** Chain-level aggregates; null when not derivable from the venue payload. */
  ivAtm30d?: string;
  skew25d?: string;
  putCallRatio?: string;
  totalGammaExposure?: string;
  termStructure?: Array<{ expiry: string; atmIv: string }>;
  contracts: NormalizedOptionContract[];
}

export interface NormalizedLiquidity {
  exchange: Exchange;
  symbol: string;
  ts: Date;
  bidDepthUsd: string; // within ±0.5%
  askDepthUsd: string;
  spreadBps: string;
}

/** Taker/aggressor side of a trade print (matches the DB `TradeSide` enum). */
export type TradeSide = "BUY" | "SELL";

/**
 * A raw trade print (tick) from the live feed. `tradeId` is the venue's id (as a
 * string) and disambiguates trades that share a millisecond ts — together with
 * (exchange, symbol, ts) it is the persistence identity (idempotent re-ingest).
 */
export interface NormalizedTick {
  exchange: Exchange;
  symbol: string;
  ts: Date;
  tradeId: string;
  price: string;
  size: string; // base-asset quantity
  side: TradeSide;
}

/**
 * A top-of-book + mark snapshot sampled from the live feed. `markPrice` is the
 * venue mark when published (perp mark / index); `bids`/`asks` optionally carry
 * top-N depth as [price, size] decimal-string tuples. All numerics are strings.
 */
export interface NormalizedQuote {
  exchange: Exchange;
  symbol: string;
  ts: Date;
  bestBid: string;
  bestAsk: string;
  bestBidSize: string;
  bestAskSize: string;
  markPrice?: string;
  spreadBps?: string;
  bids?: Array<[string, string]>;
  asks?: Array<[string, string]>;
}

// ── Requests ───────────────────────────────────────────────────────────────

export interface CandleBackfillRequest {
  symbol: string; // canonical
  assetType: AssetType;
  timeframe: Timeframe;
  from: Date;
  to: Date;
}

export interface FlowBackfillRequest {
  symbol: string; // canonical
  from: Date;
  to: Date;
}

// ── Live streaming ─────────────────────────────────────────────────────────

export interface LiveHandlers {
  onCandle?: (candle: NormalizedCandle) => void;
  /**
   * Phase 9 live tick handlers — all OPTIONAL so connectors that only stream
   * candles (Demo) and existing callers keep working unchanged. A connector
   * emits whichever its venue publishes:
   *   onTrade   — per trade print (ticks)
   *   onQuote   — top-of-book + mark snapshots (best bid/ask, mark price)
   *   onFunding — funding-rate updates pushed on the live channel
   */
  onTrade?: (tick: NormalizedTick) => void;
  onQuote?: (quote: NormalizedQuote) => void;
  onFunding?: (rate: NormalizedFundingRate) => void;
  onError?: (err: Error) => void;
  /** Fires on every (re)connect — used by outage detection (heartbeat gaps). */
  onConnected?: () => void;
  onDisconnected?: (reason: string) => void;
}

export interface LiveSubscription {
  close(): Promise<void>;
}

export interface LiveStreamRequest {
  symbols: Array<{ symbol: string; assetType: AssetType }>;
  timeframe: Timeframe;
}

// ── Connector ──────────────────────────────────────────────────────────────

export interface ConnectorCapabilities {
  candles: boolean;
  funding: boolean;
  openInterest: boolean;
  /** Deribit publishes no LSR — capability-gated, not error-driven. */
  longShortRatio: boolean;
  optionChain: boolean;
  liquidity: boolean;
}

export interface ExchangeConnector {
  readonly exchange: Exchange;
  readonly capabilities: ConnectorCapabilities;

  /** Paginated REST backfill; implementations respect venue rate limits. */
  fetchCandles(req: CandleBackfillRequest): Promise<NormalizedCandle[]>;
  fetchFundingRates(req: FlowBackfillRequest): Promise<NormalizedFundingRate[]>;
  fetchOpenInterest(req: FlowBackfillRequest): Promise<NormalizedOpenInterest[]>;
  fetchLongShortRatios(
    req: FlowBackfillRequest,
  ): Promise<NormalizedLongShortRatio[]>;
  /** Full current chain snapshot (aggregates + every listed contract). */
  fetchOptionChain(underlying: string): Promise<NormalizedOptionChain | null>;
  fetchLiquidity(symbol: string): Promise<NormalizedLiquidity | null>;

  /** WebSocket live candles; resolves once the socket is open. */
  streamLive(
    req: LiveStreamRequest,
    handlers: LiveHandlers,
  ): Promise<LiveSubscription>;
}
