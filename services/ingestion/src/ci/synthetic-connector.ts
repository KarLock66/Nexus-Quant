/**
 * Synthetic fixture connector — CI/TEST ONLY. Deterministic data, zero network.
 *
 * Implements the full ExchangeConnector contract from a seeded PRNG so the
 * offline CI seal (seal-phase9-runtime.ts) can exercise the ingestion pipeline
 * reproducibly against a DISPOSABLE database. It is NOT registered in the
 * runtime connector registry (src/connectors/index.ts) and cannot be selected
 * via INGEST_EXCHANGE — the production daemon connects only to real venues.
 *
 * DETERMINISM CONTRACT
 * --------------------
 * Every series value is a pure function of (seed, symbol, timeframe,
 * barIndex) where bar 0 opens at the fixed epoch 2024-01-01T00:00:00Z.
 * Each bar's randomness comes from an independent PRNG seeded by
 * hash32(`${seed}|${symbol}|${timeframe}|bar|${barIndex}`), and the price
 * path is always accumulated from bar 0 in index order — so any [from, to)
 * window returns byte-identical bars regardless of call order or overlap.
 *
 * REGIME MODEL
 * ------------
 * Regime blocks are 720 HOURS long (720 bars on the hourly base grid) and
 * cycle bull → range → bear → high-vol. The block index is derived from the
 * bar's wall-clock offset (hoursSinceEpoch / 720), so H1/H4/D1 sit in the
 * same regime at the same point in time. H4/D1 are generated on their own
 * grids with per-bar drift/vol scaled by (tfHours, sqrt(tfHours)) — they are
 * NOT aggregates of H1 (documented trade-off: cross-timeframe OHLC totals
 * will not reconcile, which is acceptable for synthetic demo data).
 *
 * Option chains are snapshots of "now" (floored to the hour): chains are
 * polled live, not backfilled, mirroring the real venue connectors.
 *
 * All numerics leave this module as decimal strings (no float drift across
 * module borders); doubles are used only inside generation math.
 */

import type { AssetType, Exchange, Timeframe } from "@nexus/core";
import { LS_RATIO_SCOPES, TIMEFRAMES } from "@nexus/core";
import {
  blackScholes,
  boxMuller,
  hash32,
  mulberry32,
} from "./synthetic-math.js";
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
} from "../connectors/types.js";

// ── Constants ───────────────────────────────────────────────────────────────

/**
 * Venue label stamped on every emitted/persisted row. Defaults to the legacy
 * synthetic "DEMO" label (excluded by every production mark/pipeline filter);
 * the offline CI seal overrides it so fixture rows are admissible in its
 * DISPOSABLE database. Module-scoped: one label per process (CI builds one
 * connector at a time — this is a test fixture, not runtime code).
 */
let EXCHANGE: Exchange = "DEMO";
const DEFAULT_SEED = 42;

/** Bar 0 of every series opens here. No data exists before the epoch. */
export const DEMO_EPOCH_MS = Date.UTC(2024, 0, 1, 0, 0, 0);

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const FUNDING_INTERVAL_MS = 8 * HOUR_MS;
const YEAR_MS = 365 * DAY_MS;

const TIMEFRAME_MS: Record<Timeframe, number> = {
  M1: 60_000,
  M5: 300_000,
  M15: 900_000,
  H1: HOUR_MS,
  H4: 4 * HOUR_MS,
  D1: DAY_MS,
};

/** Regime block length in hours (720 bars on the hourly base grid). */
const REGIME_BLOCK_HOURS = 720;

interface RegimeSpec {
  name: string;
  /** Per-H1-bar drift of log return. */
  mu: number;
  /** Per-H1-bar volatility of log return. */
  sigma: number;
  /** Volume multiplier (high-vol regimes trade heavier). */
  volMult: number;
}

const REGIME_CYCLE: readonly RegimeSpec[] = [
  { name: "bull", mu: 0.0004, sigma: 0.006, volMult: 1.0 },
  { name: "range", mu: 0, sigma: 0.004, volMult: 0.8 },
  { name: "bear", mu: -0.0003, sigma: 0.008, volMult: 1.2 },
  { name: "high_vol", mu: 0.0001, sigma: 0.018, volMult: 2.5 },
];

interface SymbolMeta {
  assetType: AssetType;
  /** Price at bar 0 (epoch). */
  basePrice: number;
  /** Base-asset volume per hour (lognormal-jittered per bar). */
  baseHourlyVolume: number;
  /** Mean open interest in base units (PERP flow series). */
  baseOpenInterest: number;
  /** Order-book depth scale within +/-0.5%, USD. */
  baseDepthUsd: number;
}

const SYMBOLS: Record<string, SymbolMeta> = {
  "BTC-USDT": {
    assetType: "SPOT",
    basePrice: 100_000,
    baseHourlyVolume: 1_200,
    baseOpenInterest: 50_000,
    baseDepthUsd: 8_000_000,
  },
  "ETH-USDT": {
    assetType: "SPOT",
    basePrice: 5_000,
    baseHourlyVolume: 15_000,
    baseOpenInterest: 800_000,
    baseDepthUsd: 5_000_000,
  },
  "BTC-PERP": {
    assetType: "PERP",
    basePrice: 100_000,
    baseHourlyVolume: 2_000,
    baseOpenInterest: 50_000,
    baseDepthUsd: 10_000_000,
  },
  "ETH-PERP": {
    assetType: "PERP",
    basePrice: 5_000,
    baseHourlyVolume: 25_000,
    baseOpenInterest: 800_000,
    baseDepthUsd: 6_000_000,
  },
};

interface UnderlyingMeta {
  spotSymbol: string;
  strikeStep: number;
  /** ATM open interest scale, contracts. */
  baseAtmOi: number;
}

const UNDERLYINGS: Record<string, UnderlyingMeta> = {
  BTC: { spotSymbol: "BTC-USDT", strikeStep: 500, baseAtmOi: 1_500 },
  ETH: { spotSymbol: "ETH-USDT", strikeStep: 25, baseAtmOi: 12_000 },
};

const EXPIRY_DAYS = [7, 14, 30, 60, 90] as const;

// ── Logging ─────────────────────────────────────────────────────────────────

function log(
  level: "info" | "warn" | "error",
  msg: string,
  extra?: Record<string, unknown>,
): void {
  console.log(
    JSON.stringify({
      ts: new Date().toISOString(),
      service: "ingestion",
      component: "demo-connector",
      level,
      msg,
      ...extra,
    }),
  );
}

// ── Decimal-string formatting (module border) ──────────────────────────────

function fmt(x: number, digits: number): string {
  if (!Number.isFinite(x)) {
    throw new Error(`demo: non-finite numeric value (${x})`);
  }
  const s = x.toFixed(digits);
  // Normalize "-0.000…0" to a positive zero string.
  return s === `-${(0).toFixed(digits)}` ? (0).toFixed(digits) : s;
}

const d2 = (x: number): string => fmt(x, 2);
const d4 = (x: number): string => fmt(x, 4);
const d6 = (x: number): string => fmt(x, 6);
const d8 = (x: number): string => fmt(x, 8);
const d10 = (x: number): string => fmt(x, 10);

// ── Deterministic building blocks ───────────────────────────────────────────

interface BarDraws {
  /** Log return of the bar. */
  ret: number;
  /** Per-bar effective sigma (regime sigma scaled to the timeframe). */
  sigmaBar: number;
  volMult: number;
  uHigh: number;
  uLow: number;
  zVolume: number;
  uTrades: number;
}

/**
 * Regime parameters for a block. Jitter is drawn from a per-block PRNG
 * (independent of timeframe so all grids share the same regime path).
 */
function blockParams(seed: number, symbol: string, blockIndex: number): RegimeSpec {
  const base = REGIME_CYCLE[((blockIndex % REGIME_CYCLE.length) + REGIME_CYCLE.length) % REGIME_CYCLE.length];
  if (base === undefined) {
    throw new Error(`demo: regime cycle lookup failed (block ${blockIndex})`);
  }
  const rng = mulberry32(hash32(`${seed}|${symbol}|block|${blockIndex}`));
  return {
    name: base.name,
    mu: base.mu * (0.8 + 0.4 * rng()),
    sigma: base.sigma * (0.85 + 0.3 * rng()),
    volMult: base.volMult,
  };
}

/**
 * All randomness for one bar, drawn in a FIXED order from a PRNG seeded by
 * hash(seed, symbol, timeframe, barIndex). Pure function of its arguments.
 */
function barDraws(
  seed: number,
  symbol: string,
  timeframe: Timeframe,
  barIndex: number,
  block: RegimeSpec,
  tfHours: number,
): BarDraws {
  const rng = mulberry32(
    hash32(`${seed}|${symbol}|${timeframe}|bar|${barIndex}`),
  );
  const z = boxMuller(rng); // draws 1-2
  const uHigh = rng(); // draw 3
  const uLow = rng(); // draw 4
  const zVolume = boxMuller(rng); // draws 5-6
  const uTrades = rng(); // draw 7
  const muBar = block.mu * tfHours;
  const sigmaBar = block.sigma * Math.sqrt(tfHours);
  return {
    ret: muBar + sigmaBar * z,
    sigmaBar,
    volMult: block.volMult,
    uHigh,
    uLow,
    zVolume,
    uTrades,
  };
}

function regimeBlockIndexForBar(barIndex: number, tfHours: number): number {
  return Math.floor((barIndex * tfHours) / REGIME_BLOCK_HOURS);
}

/**
 * Generate candles for bar indexes [fromBar, toBar] (inclusive) by walking
 * the price recursion from bar 0 — same prefix on every call, so overlapping
 * windows agree bar-for-bar. O(toBar) per call, which is fine at demo scale.
 */
function generateCandles(
  seed: number,
  symbol: string,
  meta: SymbolMeta,
  timeframe: Timeframe,
  fromBar: number,
  toBar: number,
): NormalizedCandle[] {
  const tfMs = TIMEFRAME_MS[timeframe];
  const tfHours = tfMs / HOUR_MS;
  const out: NormalizedCandle[] = [];

  let price = meta.basePrice;
  let cachedBlockIndex = -1;
  let cachedBlock: RegimeSpec | null = null;

  for (let n = 0; n <= toBar; n += 1) {
    const blockIndex = regimeBlockIndexForBar(n, tfHours);
    if (blockIndex !== cachedBlockIndex || cachedBlock === null) {
      cachedBlock = blockParams(seed, symbol, blockIndex);
      cachedBlockIndex = blockIndex;
    }
    const draws = barDraws(seed, symbol, timeframe, n, cachedBlock, tfHours);
    const open = price;
    const close = open * Math.exp(draws.ret);
    price = close;
    if (n < fromBar) continue;

    const bodyHigh = Math.max(open, close);
    const bodyLow = Math.min(open, close);
    const high = bodyHigh * (1 + draws.uHigh * draws.sigmaBar * 0.6);
    const low = bodyLow * (1 - draws.uLow * draws.sigmaBar * 0.6);
    const volume =
      meta.baseHourlyVolume *
      tfHours *
      Math.exp(0.6 * draws.zVolume) *
      draws.volMult;
    const trades = Math.max(1, Math.round(volume * (6 + 6 * draws.uTrades)));

    out.push({
      exchange: EXCHANGE,
      symbol,
      assetType: meta.assetType,
      timeframe,
      ts: new Date(DEMO_EPOCH_MS + n * tfMs),
      open: d8(open),
      high: d8(high),
      low: d8(low),
      close: d8(close),
      volume: d8(volume),
      trades,
    });
  }
  return out;
}

/** H1 close at a given hourly bar index (used by OI value + option spot). */
function h1CloseAtBar(
  seed: number,
  symbol: string,
  meta: SymbolMeta,
  barIndex: number,
): number {
  let price = meta.basePrice;
  let cachedBlockIndex = -1;
  let cachedBlock: RegimeSpec | null = null;
  for (let n = 0; n <= barIndex; n += 1) {
    const blockIndex = regimeBlockIndexForBar(n, 1);
    if (blockIndex !== cachedBlockIndex || cachedBlock === null) {
      cachedBlock = blockParams(seed, symbol, blockIndex);
      cachedBlockIndex = blockIndex;
    }
    const draws = barDraws(seed, symbol, "H1", n, cachedBlock, 1);
    price *= Math.exp(draws.ret);
  }
  return price;
}

// ── Grid helpers ────────────────────────────────────────────────────────────

function gridWindow(
  from: Date,
  to: Date,
  stepMs: number,
): { first: number; last: number } | null {
  if (!(from instanceof Date) || !(to instanceof Date)) {
    throw new Error("demo: from/to must be Date instances");
  }
  if (from.getTime() >= to.getTime()) {
    throw new Error(
      `demo: invalid window — from (${from.toISOString()}) must be before to (${to.toISOString()})`,
    );
  }
  const first = Math.max(0, Math.ceil((from.getTime() - DEMO_EPOCH_MS) / stepMs));
  // points with ts < to
  const last = Math.ceil((to.getTime() - DEMO_EPOCH_MS) / stepMs) - 1;
  if (last < first) return null;
  return { first, last };
}

function requireSymbol(symbol: string): SymbolMeta {
  const meta = SYMBOLS[symbol];
  if (meta === undefined) {
    throw new Error(
      `demo: unknown symbol "${symbol}" (supported: ${Object.keys(SYMBOLS).join(", ")})`,
    );
  }
  return meta;
}

function requireTimeframe(timeframe: Timeframe): number {
  const tfMs = TIMEFRAME_MS[timeframe];
  if (tfMs === undefined || !TIMEFRAMES.includes(timeframe)) {
    throw new Error(`demo: unknown timeframe "${timeframe}"`);
  }
  return tfMs;
}

function floorToHour(ms: number): number {
  return Math.floor(ms / HOUR_MS) * HOUR_MS;
}

// ── Option chain generation ─────────────────────────────────────────────────

function expiryAt0800Utc(afterMs: number): number {
  const d = new Date(afterMs);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 8, 0, 0);
}

function buildOptionChain(
  seed: number,
  underlying: string,
  meta: UnderlyingMeta,
  snapshotMs: number,
): NormalizedOptionChain {
  const spotMeta = SYMBOLS[meta.spotSymbol];
  if (spotMeta === undefined) {
    throw new Error(`demo: missing spot symbol meta for underlying ${underlying}`);
  }
  const hourIndex = Math.max(
    0,
    Math.floor((snapshotMs - DEMO_EPOCH_MS) / HOUR_MS),
  );
  const spot = h1CloseAtBar(seed, meta.spotSymbol, spotMeta, hourIndex);
  const ts = new Date(snapshotMs);

  // Expiries: next 7/14/30/60/90 days, snapped to 08:00 UTC.
  const expiries = EXPIRY_DAYS.map((days) =>
    expiryAt0800Utc(snapshotMs + days * DAY_MS),
  );

  // Strikes: moneyness 0.70..1.30 step 0.05 of spot, rounded to the venue step.
  const strikes: number[] = [];
  for (let i = 0; i <= 12; i += 1) {
    const m = 0.7 + i * 0.05;
    const strike = Math.round((spot * m) / meta.strikeStep) * meta.strikeStep;
    if (strike > 0 && !strikes.includes(strike)) strikes.push(strike);
  }

  const contracts: NormalizedOptionContract[] = [];
  let putOi = 0;
  let callOi = 0;
  let gex = 0;

  interface ContractCalc {
    expiryMs: number;
    strike: number;
    optionType: "CALL" | "PUT";
    iv: number;
    delta: number;
  }
  const calcs: ContractCalc[] = [];

  for (const expiryMs of expiries) {
    const tYears = (expiryMs - snapshotMs) / YEAR_MS;
    const tDays = (expiryMs - snapshotMs) / DAY_MS;
    for (const strike of strikes) {
      const m = strike / spot;
      for (const optionType of ["CALL", "PUT"] as const) {
        const rng = mulberry32(
          hash32(
            `${seed}|${underlying}|opt|${snapshotMs}|${expiryMs}|${strike}|${optionType}`,
          ),
        );
        // IV surface: base + term-structure decay (shorter-dated = higher)
        // + symmetric smile on the wings + put skew, + small per-contract noise.
        let iv = 0.55 + 0.12 * Math.exp(-tDays / 40) + 0.3 * (m - 1) * (m - 1);
        if (optionType === "PUT") iv += 0.15 * (1.0 - m);
        iv += (rng() - 0.5) * 0.02;
        iv = Math.max(0.05, iv);

        const bs = blackScholes({
          spot,
          strike,
          timeToExpiryYears: tYears,
          vol: iv,
          optionType,
        });

        // OI / volume decay with distance from ATM.
        const oi = meta.baseAtmOi * Math.exp(-6 * Math.abs(m - 1)) * (0.5 + rng());
        const volume = oi * (0.1 + 0.5 * rng());
        const spread = 0.015 * bs.price;
        const bid = Math.max(0, bs.price - spread);
        const ask = bs.price + spread;

        if (optionType === "PUT") putOi += oi;
        else callOi += oi;
        // Dealer gamma exposure proxy: gamma * OI * spot^2 * 1% (calls +, puts -).
        gex += (optionType === "CALL" ? 1 : -1) * bs.gamma * oi * spot * spot * 0.01;

        calcs.push({ expiryMs, strike, optionType, iv, delta: bs.delta });
        contracts.push({
          exchange: EXCHANGE,
          underlying,
          ts,
          expiry: new Date(expiryMs),
          strike: d8(strike),
          optionType,
          iv: d6(iv),
          delta: d6(bs.delta),
          gamma: d10(bs.gamma),
          theta: d6(bs.thetaPerDay),
          vega: d6(bs.vegaPerVolPt),
          openInterest: d8(oi),
          volume: d8(volume),
          bid: d8(bid),
          ask: d8(ask),
          markPrice: d8(bs.price),
        });
      }
    }
  }

  // Aggregates — computed from the generated contracts, like real connectors.
  const atmStrike = strikes.reduce(
    (best, s) => (Math.abs(s - spot) < Math.abs(best - spot) ? s : best),
    strikes[0] ?? spot,
  );
  const termStructure = expiries.map((expiryMs) => {
    const atmCall = calcs.find(
      (c) =>
        c.expiryMs === expiryMs && c.strike === atmStrike && c.optionType === "CALL",
    );
    if (atmCall === undefined) {
      throw new Error("demo: ATM call missing from generated chain");
    }
    return { expiry: new Date(expiryMs).toISOString(), atmIv: d6(atmCall.iv) };
  });

  // 30d bucket for ivAtm30d / skew25d (the 30d expiry exists by construction;
  // fall back to the expiry nearest 30 days for robustness).
  const target30 = snapshotMs + 30 * DAY_MS;
  const expiry30 = expiries.reduce((best, e) =>
    Math.abs(e - target30) < Math.abs(best - target30) ? e : best,
  );
  const bucket30 = calcs.filter((c) => c.expiryMs === expiry30);
  const atm30 = bucket30.find(
    (c) => c.strike === atmStrike && c.optionType === "CALL",
  );
  const put25 = bucket30
    .filter((c) => c.optionType === "PUT")
    .reduce((best, c) =>
      Math.abs(c.delta + 0.25) < Math.abs(best.delta + 0.25) ? c : best,
    );
  const call25 = bucket30
    .filter((c) => c.optionType === "CALL")
    .reduce((best, c) =>
      Math.abs(c.delta - 0.25) < Math.abs(best.delta - 0.25) ? c : best,
    );
  if (atm30 === undefined) {
    throw new Error("demo: 30d ATM contract missing from generated chain");
  }

  return {
    exchange: EXCHANGE,
    underlying,
    ts,
    spot: d8(spot),
    ivAtm30d: d6(atm30.iv),
    skew25d: d6(put25.iv - call25.iv),
    putCallRatio: d4(callOi > 0 ? putOi / callOi : 0),
    totalGammaExposure: d2(gex),
    termStructure,
    contracts,
  };
}

// ── Connector ───────────────────────────────────────────────────────────────

const CAPABILITIES: ConnectorCapabilities = {
  candles: true,
  funding: true,
  openInterest: true,
  longShortRatio: true,
  optionChain: true,
  liquidity: true,
};

/**
 * Create the synthetic fixture connector (CI/test only). Same seed ⇒
 * byte-identical data forever.
 */
export function createSyntheticFixtureConnector(
  seed: number = DEFAULT_SEED,
  venueLabel: Exchange = "DEMO",
): ExchangeConnector {
  if (!Number.isFinite(seed) || !Number.isInteger(seed)) {
    throw new Error(`synthetic fixture: seed must be an integer (got ${String(seed)})`);
  }
  EXCHANGE = venueLabel;

  return {
    exchange: EXCHANGE,
    capabilities: CAPABILITIES,

    async fetchCandles(req: CandleBackfillRequest): Promise<NormalizedCandle[]> {
      const meta = requireSymbol(req.symbol);
      if (req.assetType !== meta.assetType) {
        throw new Error(
          `demo: assetType mismatch for ${req.symbol} (expected ${meta.assetType}, got ${req.assetType})`,
        );
      }
      const tfMs = requireTimeframe(req.timeframe);
      const window = gridWindow(req.from, req.to, tfMs);
      if (window === null) {
        log("warn", "candle window precedes demo epoch or is empty", {
          symbol: req.symbol,
          timeframe: req.timeframe,
          from: req.from.toISOString(),
          to: req.to.toISOString(),
        });
        return [];
      }
      return generateCandles(
        seed,
        req.symbol,
        meta,
        req.timeframe,
        window.first,
        window.last,
      );
    },

    async fetchFundingRates(
      req: FlowBackfillRequest,
    ): Promise<NormalizedFundingRate[]> {
      requireSymbol(req.symbol);
      const window = gridWindow(req.from, req.to, FUNDING_INTERVAL_MS);
      if (window === null) return [];
      // Mean-reverting AR(1) around 0.0001, clamped to +/-0.0015.
      // Recursion always starts at point 0 so windows agree by construction.
      const mean = 0.0001;
      let rate = mean;
      const out: NormalizedFundingRate[] = [];
      for (let k = 0; k <= window.last; k += 1) {
        if (k > 0) {
          const rng = mulberry32(hash32(`${seed}|${req.symbol}|funding|${k}`));
          const z = boxMuller(rng);
          rate = mean + 0.95 * (rate - mean) + 0.00005 * z;
          rate = Math.min(0.0015, Math.max(-0.0015, rate));
        }
        if (k < window.first) continue;
        const tsMs = DEMO_EPOCH_MS + k * FUNDING_INTERVAL_MS;
        out.push({
          exchange: EXCHANGE,
          symbol: req.symbol,
          ts: new Date(tsMs),
          rate: d10(rate),
          nextTs: new Date(tsMs + FUNDING_INTERVAL_MS),
        });
      }
      return out;
    },

    async fetchOpenInterest(
      req: FlowBackfillRequest,
    ): Promise<NormalizedOpenInterest[]> {
      const meta = requireSymbol(req.symbol);
      const window = gridWindow(req.from, req.to, HOUR_MS);
      if (window === null) return [];
      // Positive mean-reverting random walk around the symbol's base OI.
      // The hourly close (same seed/symbol, H1 grid) prices the USD notional.
      const base = meta.baseOpenInterest;
      let oi = base;
      let price = meta.basePrice;
      let cachedBlockIndex = -1;
      let cachedBlock: RegimeSpec | null = null;
      const out: NormalizedOpenInterest[] = [];
      for (let k = 0; k <= window.last; k += 1) {
        const blockIndex = regimeBlockIndexForBar(k, 1);
        if (blockIndex !== cachedBlockIndex || cachedBlock === null) {
          cachedBlock = blockParams(seed, req.symbol, blockIndex);
          cachedBlockIndex = blockIndex;
        }
        const draws = barDraws(seed, req.symbol, "H1", k, cachedBlock, 1);
        price *= Math.exp(draws.ret);
        if (k > 0) {
          const rng = mulberry32(hash32(`${seed}|${req.symbol}|oi|${k}`));
          const z = boxMuller(rng);
          oi = oi + 0.02 * (base - oi) + base * 0.004 * z;
          oi = Math.min(2 * base, Math.max(0.4 * base, oi));
        }
        if (k < window.first) continue;
        out.push({
          exchange: EXCHANGE,
          symbol: req.symbol,
          ts: new Date(DEMO_EPOCH_MS + k * HOUR_MS),
          openInterest: d8(oi),
          openInterestValue: d2(oi * price),
        });
      }
      return out;
    },

    async fetchLongShortRatios(
      req: FlowBackfillRequest,
    ): Promise<NormalizedLongShortRatio[]> {
      requireSymbol(req.symbol);
      const window = gridWindow(req.from, req.to, HOUR_MS);
      if (window === null) return [];
      const mean = 1.1;
      const out: NormalizedLongShortRatio[] = [];
      for (const scope of LS_RATIO_SCOPES) {
        let ratio = mean;
        for (let k = 0; k <= window.last; k += 1) {
          if (k > 0) {
            const rng = mulberry32(
              hash32(`${seed}|${req.symbol}|lsr|${scope}|${k}`),
            );
            const z = boxMuller(rng);
            ratio = mean + 0.97 * (ratio - mean) + 0.05 * z;
            ratio = Math.min(2.5, Math.max(0.6, ratio));
          }
          if (k < window.first) continue;
          const longPct = ratio / (1 + ratio);
          out.push({
            exchange: EXCHANGE,
            symbol: req.symbol,
            scope,
            ts: new Date(DEMO_EPOCH_MS + k * HOUR_MS),
            ratio: d6(ratio),
            longPct: d6(longPct),
            shortPct: d6(1 - longPct),
          });
        }
      }
      return out;
    },

    async fetchOptionChain(
      underlying: string,
    ): Promise<NormalizedOptionChain | null> {
      const meta = UNDERLYINGS[underlying];
      if (meta === undefined) {
        log("warn", "option chain requested for unknown underlying", {
          underlying,
          supported: Object.keys(UNDERLYINGS),
        });
        return null;
      }
      // Chains are live snapshots (polled, never backfilled): the snapshot
      // ts is the current wall-clock hour floor, so repeated polls within
      // the same hour return the identical chain.
      const snapshotMs = floorToHour(Date.now());
      return buildOptionChain(seed, underlying, meta, snapshotMs);
    },

    async fetchLiquidity(symbol: string): Promise<NormalizedLiquidity | null> {
      const meta = SYMBOLS[symbol];
      if (meta === undefined) {
        log("warn", "liquidity requested for unknown symbol", { symbol });
        return null;
      }
      const snapshotMs = floorToHour(Date.now());
      const hourIndex = Math.max(
        0,
        Math.floor((snapshotMs - DEMO_EPOCH_MS) / HOUR_MS),
      );
      const rng = mulberry32(hash32(`${seed}|${symbol}|liq|${hourIndex}`));
      const bidDepthUsd = meta.baseDepthUsd * (0.7 + 0.6 * rng());
      const askDepthUsd = meta.baseDepthUsd * (0.7 + 0.6 * rng());
      const spreadBps = 0.4 + 2.2 * rng();
      return {
        exchange: EXCHANGE,
        symbol,
        ts: new Date(snapshotMs),
        bidDepthUsd: d2(bidDepthUsd),
        askDepthUsd: d2(askDepthUsd),
        spreadBps: d4(spreadBps),
      };
    },

    async streamLive(
      req: LiveStreamRequest,
      handlers: LiveHandlers,
    ): Promise<LiveSubscription> {
      const tfMs = requireTimeframe(req.timeframe);
      // Fail-closed at subscribe time: every symbol must be known.
      for (const s of req.symbols) requireSymbol(s.symbol);

      const emitCurrentBars = (): void => {
        try {
          const nowBar = Math.floor((Date.now() - DEMO_EPOCH_MS) / tfMs);
          if (nowBar < 0) return; // before demo epoch — nothing to emit
          for (const s of req.symbols) {
            const meta = requireSymbol(s.symbol);
            const bars = generateCandles(
              seed,
              s.symbol,
              meta,
              req.timeframe,
              nowBar,
              nowBar,
            );
            const bar = bars[0];
            if (bar !== undefined) handlers.onCandle?.(bar);
          }
        } catch (err) {
          handlers.onError?.(err instanceof Error ? err : new Error(String(err)));
        }
      };

      // Phase 9: synthetic trade + top-of-book/mark ticks derived deterministically
      // from the current bar, so the live tick feed (and its persistence) is
      // exercisable offline through the same daemon. Emitted only when a handler
      // wants them (candle-only callers are unaffected).
      let tickSeq = 0;
      const emitCurrentTicks = (): void => {
        if (handlers.onTrade === undefined && handlers.onQuote === undefined) return;
        try {
          const nowMs = Date.now();
          const nowBar = Math.floor((nowMs - DEMO_EPOCH_MS) / tfMs);
          if (nowBar < 0) return;
          const ts = new Date(nowMs);
          for (const s of req.symbols) {
            const meta = requireSymbol(s.symbol);
            const bar = generateCandles(seed, s.symbol, meta, req.timeframe, nowBar, nowBar)[0];
            if (bar === undefined) continue;
            const price = Number(bar.close);
            if (!Number.isFinite(price) || price <= 0) continue;
            if (handlers.onTrade !== undefined) {
              handlers.onTrade({
                exchange: EXCHANGE,
                symbol: s.symbol,
                ts,
                tradeId: `${nowMs}-${tickSeq}`,
                price: bar.close,
                size: d8(Number(bar.volume) / 600 || 0.001),
                side: price >= Number(bar.open) ? "BUY" : "SELL",
              });
            }
            if (handlers.onQuote !== undefined) {
              const bid = price * (1 - 0.0001);
              const ask = price * (1 + 0.0001);
              handlers.onQuote({
                exchange: EXCHANGE,
                symbol: s.symbol,
                ts,
                bestBid: d8(bid),
                bestAsk: d8(ask),
                bestBidSize: d8(meta.baseDepthUsd / price / 100),
                bestAskSize: d8(meta.baseDepthUsd / price / 100),
                markPrice: bar.close,
                spreadBps: d4(2),
              });
            }
          }
          tickSeq += 1;
        } catch (err) {
          handlers.onError?.(err instanceof Error ? err : new Error(String(err)));
        }
      };

      const interval = setInterval(emitCurrentBars, 60_000);
      const tickInterval = setInterval(emitCurrentTicks, 1_000);
      log("info", "demo live stream opened", {
        symbols: req.symbols.map((s) => s.symbol),
        timeframe: req.timeframe,
      });
      handlers.onConnected?.();
      // Emit one tick immediately so a short-lived consumer (seal harness) sees
      // live data without waiting a full interval.
      emitCurrentTicks();

      return {
        async close(): Promise<void> {
          clearInterval(interval);
          clearInterval(tickInterval);
          log("info", "demo live stream closed");
          handlers.onDisconnected?.("closed by client");
        },
      };
    },
  };
}

export default createSyntheticFixtureConnector;
