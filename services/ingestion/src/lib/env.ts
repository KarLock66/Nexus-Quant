/**
 * Parsed + validated ingestion configuration (single read of process.env).
 *
 * Fail-closed: required values missing or malformed throw at load time with a
 * descriptive message — the service never starts on a half-valid config.
 * Optional integrations (Redis, quant service) parse to null when unset; the
 * consumers degrade explicitly (no-op publisher, stage_b_unavailable).
 */

import { EXCHANGES, TIMEFRAMES } from "@nexus/core";
import type { AssetType, Exchange, Timeframe } from "@nexus/core";

export interface IngestionEnv {
  databaseUrl: string;
  redisUrl: string | null;
  quantServiceUrl: string | null;
  sharedSecret: string | undefined;
  demoMode: boolean;
  demoSeed: number;
  ingestSymbols: Array<{ symbol: string; assetType: AssetType }>;
  ingestOptionUnderlyings: string[];
  ingestTimeframes: Timeframe[];
  ingestBackfillDays: number;
  // ── Phase 9 live ingestion ──────────────────────────────────────────────
  /** Venues the live daemon connects to (csv; default DERIBIT). */
  ingestExchanges: Exchange[];
  /** Timeframe the live candle→feature loop runs on (default H1, demo lineage). */
  ingestLiveTimeframe: Timeframe;
  /** REST flow (funding/OI/LSR/liquidity/options) poll cadence, ms. */
  ingestFlowPollMs: number;
  /** Feature Store target the bridge computes (default core-technical v1). */
  featureSet: string;
  featureVersion: number;
}

const DEFAULT_SYMBOLS = "BTC-USDT,ETH-USDT,BTC-PERP,ETH-PERP";
const DEFAULT_UNDERLYINGS = "BTC,ETH";
const DEFAULT_TIMEFRAMES = "H1,H4,D1";
const DEFAULT_BACKFILL_DAYS = 730;
const DEFAULT_DEMO_SEED = 42;
// Default-off discipline: a bare daemon (no INGEST_EXCHANGE/CONNECTOR_EXCHANGE)
// runs the OFFLINE deterministic DEMO venue — no live exchange connection happens
// unless a real venue is explicitly opted in (e.g. INGEST_EXCHANGE=DERIBIT,BINANCE).
const DEFAULT_EXCHANGE = "DEMO";
const DEFAULT_LIVE_TIMEFRAME = "H1";
const DEFAULT_FLOW_POLL_MS = 300_000; // 5 min
const DEFAULT_FEATURE_SET = "core-technical";
const DEFAULT_FEATURE_VERSION = 1;

function read(source: Record<string, string | undefined>, key: string): string | null {
  const raw = source[key];
  if (raw === undefined) return null;
  const trimmed = raw.trim();
  return trimmed === "" ? null : trimmed;
}

function parseBool(value: string | null): boolean {
  if (value === null) return false;
  return ["true", "1", "yes"].includes(value.toLowerCase());
}

function parsePositiveInt(value: string | null, fallback: number, key: string): number {
  if (value === null) return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`env ${key} must be a positive integer, got "${value}"`);
  }
  return n;
}

function parseList(value: string | null, fallback: string): string[] {
  return (value ?? fallback)
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function isTimeframe(value: string): value is Timeframe {
  return (TIMEFRAMES as readonly string[]).includes(value);
}

function isExchange(value: string): value is Exchange {
  return (EXCHANGES as readonly string[]).includes(value);
}

/** Canonical symbol convention: `*-PERP` is a perpetual, everything else spot. */
function classifySymbol(symbol: string): { symbol: string; assetType: AssetType } {
  return { symbol, assetType: symbol.endsWith("-PERP") ? "PERP" : "SPOT" };
}

export function loadEnv(source: Record<string, string | undefined>): IngestionEnv {
  const databaseUrl = read(source, "DATABASE_URL");
  if (databaseUrl === null) {
    throw new Error("env DATABASE_URL is required (fail-closed: no default)");
  }

  const timeframes = parseList(read(source, "INGEST_TIMEFRAMES"), DEFAULT_TIMEFRAMES).map(
    (tf) => {
      const upper = tf.toUpperCase();
      if (!isTimeframe(upper)) {
        throw new Error(
          `env INGEST_TIMEFRAMES contains invalid timeframe "${tf}" (valid: ${TIMEFRAMES.join(",")})`,
        );
      }
      return upper;
    },
  );
  if (timeframes.length === 0) {
    throw new Error("env INGEST_TIMEFRAMES parsed to an empty list");
  }

  const symbols = parseList(read(source, "INGEST_SYMBOLS"), DEFAULT_SYMBOLS).map((s) =>
    classifySymbol(s.toUpperCase()),
  );
  if (symbols.length === 0) {
    throw new Error("env INGEST_SYMBOLS parsed to an empty list");
  }

  // Venue selector: INGEST_EXCHANGE is canonical; CONNECTOR_EXCHANGE is an
  // accepted alias (same csv of venues), so either spelling configures the daemon.
  const exchangeRaw = read(source, "INGEST_EXCHANGE") ?? read(source, "CONNECTOR_EXCHANGE");
  const exchanges = parseList(exchangeRaw, DEFAULT_EXCHANGE).map((e) => {
    const upper = e.toUpperCase();
    if (!isExchange(upper)) {
      throw new Error(
        `env INGEST_EXCHANGE contains invalid exchange "${e}" (valid: ${EXCHANGES.join(",")})`,
      );
    }
    return upper;
  });
  if (exchanges.length === 0) {
    throw new Error("env INGEST_EXCHANGE parsed to an empty list");
  }

  const demoMode = parseBool(read(source, "DEMO_MODE"));
  // Fail-closed: the DEMO connector writes deterministic synthetic candles/ticks
  // into the SAME market tables as live venues — fresh synthetic rows would become
  // the newest mark for anything without an exchange filter. Running it therefore
  // requires the explicit platform-wide demo opt-in, never a bare default.
  if (exchanges.includes("DEMO") && !demoMode) {
    throw new Error(
      "INGEST_EXCHANGE resolves to the synthetic DEMO venue but DEMO_MODE is not enabled. " +
        "Set DEMO_MODE=true to opt into synthetic ingestion, or set INGEST_EXCHANGE to a real venue (e.g. DERIBIT).",
    );
  }

  const liveTfRaw = (read(source, "INGEST_LIVE_TIMEFRAME") ?? DEFAULT_LIVE_TIMEFRAME).toUpperCase();
  if (!isTimeframe(liveTfRaw)) {
    throw new Error(
      `env INGEST_LIVE_TIMEFRAME invalid "${liveTfRaw}" (valid: ${TIMEFRAMES.join(",")})`,
    );
  }

  return {
    databaseUrl,
    redisUrl: read(source, "REDIS_URL"),
    quantServiceUrl: read(source, "QUANT_SERVICE_URL"),
    sharedSecret: read(source, "QUANT_SERVICE_SHARED_SECRET") ?? undefined,
    demoMode,
    demoSeed: parsePositiveInt(read(source, "DEMO_SEED"), DEFAULT_DEMO_SEED, "DEMO_SEED"),
    ingestSymbols: symbols,
    ingestOptionUnderlyings: parseList(
      read(source, "INGEST_OPTION_UNDERLYINGS"),
      DEFAULT_UNDERLYINGS,
    ).map((u) => u.toUpperCase()),
    ingestTimeframes: timeframes,
    ingestBackfillDays: parsePositiveInt(
      read(source, "INGEST_BACKFILL_DAYS"),
      DEFAULT_BACKFILL_DAYS,
      "INGEST_BACKFILL_DAYS",
    ),
    ingestExchanges: exchanges,
    ingestLiveTimeframe: liveTfRaw,
    ingestFlowPollMs: parsePositiveInt(
      read(source, "INGEST_FLOW_POLL_MS"),
      DEFAULT_FLOW_POLL_MS,
      "INGEST_FLOW_POLL_MS",
    ),
    featureSet: read(source, "INGEST_FEATURE_SET") ?? DEFAULT_FEATURE_SET,
    featureVersion: parsePositiveInt(
      read(source, "INGEST_FEATURE_VERSION"),
      DEFAULT_FEATURE_VERSION,
      "INGEST_FEATURE_VERSION",
    ),
  };
}

export const env: IngestionEnv = loadEnv(process.env);
