/**
 * Stage-A structural data-quality checks (M5, ingestion-time, TypeScript).
 *
 * Check catalog with pinned max deductions:
 *   schema_conformance   40  NaN/negative price, high<low, open/close outside [low,high], volume<0
 *   duplicates           20  same (exchange,symbol,timeframe,ts) appears twice in batch
 *   timestamp_monotonic  15  unsorted, or ts not aligned to the timeframe grid
 *   gaps                 25  missing bars in [from,to); deduction = min(25, ceil(missingPct * 2.5))
 *
 * Fail-closed posture: schema/duplicate/monotonic violations deduct the full
 * check weight — structural corruption is treated as binary-severe. Gaps scale
 * within their weight per the pinned formula.
 */

import type { Timeframe } from "@nexus/core";
import type { NormalizedCandle } from "../connectors/types.js";
import { TIMEFRAME_MS, detectCandleGaps } from "./gaps.js";

/**
 * Stage-B failure taxonomy (P1). DATA_FAILURE is the normal scoring path (a
 * statistical check that ran and failed — untagged). INFRA = Stage B could not
 * run (unreachable / timeout / 5xx / malformed / unconfigured); AUTH = the
 * quant service rejected the shared secret (config error — fail-fast). Only an
 * INFRA outcome is ever persisted as a tagged stage_b_unavailable check; AUTH
 * throws before a report is written.
 */
export type StageBFailureCategory = "INFRA" | "AUTH";

export interface StructuralCheck {
  check: string;
  passed: boolean;
  deduction: number;
  detail: string;
  /** Failure-taxonomy tag — set only on a stage_b_unavailable check (P1). */
  category?: StageBFailureCategory;
}

export const CHECK_WEIGHTS = {
  schema_conformance: 40,
  duplicates: 20,
  timestamp_monotonic: 15,
  gaps: 25,
} as const;

const SAMPLE_CAP = 5;

function sampleList(samples: string[]): string {
  if (samples.length === 0) return "";
  return ` samples=[${samples.slice(0, SAMPLE_CAP).join(", ")}]`;
}

function isFiniteDecimalString(value: string): boolean {
  if (typeof value !== "string" || value.trim() === "") return false;
  const n = Number(value);
  return Number.isFinite(n);
}

/** schema_conformance (40): per-row numeric sanity on OHLCV fields. */
export function checkSchemaConformance(
  candles: NormalizedCandle[],
): StructuralCheck {
  let badRows = 0;
  const samples: string[] = [];
  const reasons = new Map<string, number>();

  for (const c of candles) {
    const rowReasons: string[] = [];
    const fields: Array<[name: string, raw: string]> = [
      ["open", c.open],
      ["high", c.high],
      ["low", c.low],
      ["close", c.close],
      ["volume", c.volume],
    ];

    let parseable = true;
    for (const [name, raw] of fields) {
      if (!isFiniteDecimalString(raw)) {
        rowReasons.push(`${name}_not_finite`);
        parseable = false;
      }
    }

    if (parseable) {
      const open = Number(c.open);
      const high = Number(c.high);
      const low = Number(c.low);
      const close = Number(c.close);
      const volume = Number(c.volume);

      if (open < 0 || high < 0 || low < 0 || close < 0) {
        rowReasons.push("negative_price");
      }
      if (high < low) rowReasons.push("high_lt_low");
      if (open < low || open > high) rowReasons.push("open_outside_range");
      if (close < low || close > high) rowReasons.push("close_outside_range");
      if (volume < 0) rowReasons.push("negative_volume");
    }

    if (rowReasons.length > 0) {
      badRows += 1;
      for (const r of rowReasons) reasons.set(r, (reasons.get(r) ?? 0) + 1);
      if (samples.length < SAMPLE_CAP) samples.push(c.ts.toISOString());
    }
  }

  const passed = badRows === 0;
  const reasonSummary = [...reasons.entries()]
    .map(([k, v]) => `${k}:${v}`)
    .join(", ");
  return {
    check: "schema_conformance",
    passed,
    deduction: passed ? 0 : CHECK_WEIGHTS.schema_conformance,
    detail: passed
      ? `all ${candles.length} rows conform`
      : `${badRows}/${candles.length} rows violate schema (${reasonSummary});${sampleList(samples)}`,
  };
}

/** duplicates (20): same (exchange,symbol,timeframe,ts) appears twice in the batch. */
export function checkDuplicates(candles: NormalizedCandle[]): StructuralCheck {
  const seen = new Map<string, number>();
  let duplicateRows = 0;
  const samples: string[] = [];

  for (const c of candles) {
    const key = `${c.exchange}|${c.symbol}|${c.timeframe}|${c.ts.getTime()}`;
    const count = (seen.get(key) ?? 0) + 1;
    seen.set(key, count);
    if (count > 1) {
      duplicateRows += 1;
      if (samples.length < SAMPLE_CAP) samples.push(c.ts.toISOString());
    }
  }

  const passed = duplicateRows === 0;
  return {
    check: "duplicates",
    passed,
    deduction: passed ? 0 : CHECK_WEIGHTS.duplicates,
    detail: passed
      ? `no duplicate keys in ${candles.length} rows`
      : `${duplicateRows} duplicate row(s) by (exchange,symbol,timeframe,ts);${sampleList(samples)}`,
  };
}

/**
 * timestamp_monotonic (15): batch must be sorted ascending (non-decreasing;
 * exact-equal ts is the duplicates check's domain) and every ts must sit on
 * the exact timeframe grid (epoch-ms % timeframe-ms === 0).
 */
export function checkTimestampMonotonic(
  candles: NormalizedCandle[],
  timeframe: Timeframe,
): StructuralCheck {
  const gridMs = TIMEFRAME_MS[timeframe];
  let unsorted = 0;
  let offGrid = 0;
  const samples: string[] = [];

  let prevMs: number | null = null;
  for (const c of candles) {
    const ms = c.ts.getTime();
    let bad = false;
    if (prevMs !== null && ms < prevMs) {
      unsorted += 1;
      bad = true;
    }
    if (ms % gridMs !== 0) {
      offGrid += 1;
      bad = true;
    }
    if (bad && samples.length < SAMPLE_CAP) samples.push(c.ts.toISOString());
    prevMs = ms;
  }

  const passed = unsorted === 0 && offGrid === 0;
  return {
    check: "timestamp_monotonic",
    passed,
    deduction: passed ? 0 : CHECK_WEIGHTS.timestamp_monotonic,
    detail: passed
      ? `all ${candles.length} timestamps sorted and grid-aligned (${timeframe})`
      : `unsorted:${unsorted}, off_grid:${offGrid} of ${candles.length} rows;${sampleList(samples)}`,
  };
}

/**
 * gaps (25): missing bars on the timeframe grid within [from, to).
 * deduction = min(25, ceil(missingPct * 2.5)), missingPct = missing/expected*100.
 */
export function checkGaps(
  candles: NormalizedCandle[],
  timeframe: Timeframe,
  from: Date,
  to: Date,
): StructuralCheck {
  const gridMs = TIMEFRAME_MS[timeframe];
  const firstAligned = Math.ceil(from.getTime() / gridMs) * gridMs;
  const expected = Math.max(0, Math.ceil((to.getTime() - firstAligned) / gridMs));

  if (expected === 0) {
    return {
      check: "gaps",
      passed: true,
      deduction: 0,
      detail: "window [from,to) contains no expected bars",
    };
  }

  const gaps = detectCandleGaps(
    candles.map((c) => c.ts),
    timeframe,
    from,
    to,
  );
  const missing = gaps.reduce((acc, g) => acc + g.missingBars, 0);
  const passed = missing === 0;
  const missingPct = (missing / expected) * 100;
  const deduction = passed
    ? 0
    : Math.min(CHECK_WEIGHTS.gaps, Math.ceil(missingPct * 2.5));
  const gapSamples = gaps
    .slice(0, SAMPLE_CAP)
    .map(
      (g) =>
        `${g.from.toISOString()}..${g.to.toISOString()}(${g.missingBars})`,
    )
    .join(", ");

  return {
    check: "gaps",
    passed,
    deduction,
    detail: passed
      ? `0 missing of ${expected} expected bars`
      : `${missing} missing of ${expected} expected bars (${missingPct.toFixed(2)}%) in ${gaps.length} gap(s); samples=[${gapSamples}]`,
  };
}

/** Run the full Stage-A catalog in pinned order. */
export function checkCandleBatch(
  candles: NormalizedCandle[],
  opts: { timeframe: Timeframe; from: Date; to: Date },
): StructuralCheck[] {
  return [
    checkSchemaConformance(candles),
    checkDuplicates(candles),
    checkTimestampMonotonic(candles, opts.timeframe),
    checkGaps(candles, opts.timeframe, opts.from, opts.to),
  ];
}
