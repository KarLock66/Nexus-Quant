/**
 * STEP 6 — TS-side E2E trace harness (real runtime, no mocks).
 *
 * Drives the REAL stage-b-client against a LIVE FastAPI service over real HTTP,
 * runs the REAL Stage-A checks + scoreChecks decision path, and (for the
 * Feature Store, which has no production TS client yet) issues a minimal raw
 * fetch that reads featureHash as an OPAQUE STRING — never recomputing it.
 *
 * This file is trace instrumentation only: it imports the production modules
 * unmodified and records what crosses the boundary. It does not alter business
 * logic. Output: <repo>/.e2e_out/ts_trace.json + per-scenario request bodies.
 */

import { fetchStageBChecks } from "../src/dq/stage-b-client.js";
import { checkCandleBatch } from "../src/dq/checks.js";
import { scoreChecks } from "../src/dq/score.js";
import { computeDatasetHash } from "../src/dq/hash.js";
import type { NormalizedCandle } from "../src/connectors/types.js";
import { writeFileSync, mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

const BASE = process.env["QUANT_SERVICE_URL"] ?? "http://127.0.0.1:8765";
const OUT = "C:/Users/sh/Nexus Quant/.e2e_out";
mkdirSync(OUT, { recursive: true });

const TRACE_ID = randomUUID();
const GRID = 3_600_000;
const T0 = Date.UTC(2024, 0, 1, 0, 0, 0);

/** Deterministic lognormal-ish walk; decimal-string OHLCV, grid-aligned ts. */
function gen(n: number, seed: number): NormalizedCandle[] {
  let s = seed >>> 0;
  const rnd = () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
  const out: NormalizedCandle[] = [];
  let price = 100;
  for (let i = 0; i < n; i += 1) {
    const r = (rnd() - 0.5) * 0.02;
    const open = price;
    const close = price * (1 + r);
    const high = Math.max(open, close) * 1.001;
    const low = Math.min(open, close) * 0.999;
    const vol = 1000 * (1 + (rnd() - 0.5) * 0.1);
    out.push({
      exchange: "BINANCE",
      symbol: "BTC-USDT",
      assetType: "SPOT",
      timeframe: "H1",
      ts: new Date(T0 + i * GRID),
      open: open.toFixed(8),
      high: high.toFixed(8),
      low: low.toFixed(8),
      close: close.toFixed(8),
      volume: vol.toFixed(8),
    } as NormalizedCandle);
    price = close;
  }
  return out;
}

/** Mirror of stage-b-client.ts:89-99 — used to record the exact request bytes. */
function bodyDq(candles: NormalizedCandle[]): string {
  return JSON.stringify({
    candles: candles.map((c) => ({
      ts: c.ts.toISOString(),
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
      volume: c.volume,
    })),
    referenceCloses: null,
  });
}

async function dqScenario(name: string, candles: NormalizedCandle[]) {
  const from = new Date(T0);
  const to = new Date(T0 + 300 * GRID);
  const body = bodyDq(candles);
  writeFileSync(join(OUT, `req_${name}.json`), body, "utf8");

  const stageA = checkCandleBatch(candles, { timeframe: "H1", from, to });
  const stageB = await fetchStageBChecks({ quantBaseUrl: BASE }, candles); // REAL round-trip
  const merged = [...stageA, ...stageB];
  const decision = scoreChecks(merged);
  const datasetHash = computeDatasetHash(
    candles.map((c) => ({
      exchange: c.exchange,
      symbol: c.symbol,
      timeframe: c.timeframe,
      ts: c.ts,
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
      volume: c.volume,
    })),
  );

  return {
    candle_count: candles.length,
    request_bytes_len: Buffer.byteLength(body, "utf8"),
    first_candle: (JSON.parse(body) as { candles: unknown[] }).candles[0],
    datasetHash,
    stageA,
    stageB,
    merged_checks: merged,
    decision,
  };
}

async function featuresScenario(candles: NormalizedCandle[]) {
  const body = JSON.stringify({
    scope: { exchange: "BINANCE", symbol: "BTC-USDT", timeframe: "H1" },
    feature_set: "core-technical",
    version: 1,
    market_data: {
      candles: candles.map((c) => ({
        ts: c.ts.toISOString(),
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        volume: c.volume,
      })),
    },
    dq_score: 95,
    dq_report_id: "e2e_dq_1",
  });
  writeFileSync(join(OUT, "req_features.json"), body, "utf8");

  const res = await fetch(`${BASE}/features/compute`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Trace-Id": TRACE_ID },
    body,
  });
  const json = (await res.json()) as Record<string, unknown>;

  // featureHash is read as an OPAQUE STRING. It is NOT recomputed anywhere here.
  const featureHash = json["featureHash"];

  return {
    request_bytes_len: Buffer.byteLength(body, "utf8"),
    response_status: res.status,
    response_keys: Object.keys(json).sort(),
    feature_keys:
      json["features"] && typeof json["features"] === "object"
        ? Object.keys(json["features"] as object).sort()
        : null,
    featureHash,
    featureHash_type: typeof featureHash,
    featureHash_recomputed_in_ts: false,
    featureHash_source: "response.featureHash (string field, read verbatim)",
    parsed_response: {
      feature_set: json["feature_set"],
      version: json["version"],
      as_of_ts: json["as_of_ts"],
      input_candle_count: json["input_candle_count"],
      dq_report_id: json["dq_report_id"],
    },
  };
}

function scaleLastBar(candles: NormalizedCandle[]): NormalizedCandle[] {
  const out = candles.map((c) => ({ ...c }));
  const last = out[out.length - 1];
  if (!last) throw new Error("empty");
  // Scale the WHOLE bar x10: stays internally schema-consistent (Stage A clean)
  // but creates an extreme log-return -> Stage B price_outliers fires.
  last.open = (Number(last.open) * 10).toFixed(8);
  last.high = (Number(last.high) * 10).toFixed(8);
  last.low = (Number(last.low) * 10).toFixed(8);
  last.close = (Number(last.close) * 10).toFixed(8);
  return out;
}

function duplicateRow(candles: NormalizedCandle[]): NormalizedCandle[] {
  const out = candles.map((c) => ({ ...c }));
  const five = out[5];
  if (!five) throw new Error("too small");
  out.splice(6, 0, { ...five }); // adjacent clone: duplicates fail, order stays sorted
  return out;
}

async function main(): Promise<void> {
  const base = gen(300, 42);
  const featCandles = gen(250, 11);

  const scenarios = {
    A: await dqScenario("A", base), // clean -> expect 100 PASSED
    B: await dqScenario("B", scaleLastBar(base)), // Stage-B outlier -> 98 PASSED
    C: await dqScenario("C", duplicateRow(base)), // Stage-A duplicate -> 80 FAILED
  };
  const features = await featuresScenario(featCandles);

  const trace = { trace_id: TRACE_ID, base_url: BASE, scenarios, features };
  writeFileSync(join(OUT, "ts_trace.json"), JSON.stringify(trace, null, 2), "utf8");
  console.log(`TS_SEND_DONE trace_id=${TRACE_ID}`);
}

main().catch((err: unknown) => {
  console.error("TS_SEND_FAILED", err instanceof Error ? err.stack : String(err));
  process.exit(1);
});
