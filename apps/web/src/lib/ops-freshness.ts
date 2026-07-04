/**
 * Phase 9.6 — pure freshness / staleness logic (Sections B & C).
 *
 * NO runtime imports: this is the math the data-flow monitor and the pipeline
 * visualization share, factored out so it can be unit-tested without a database
 * or Next.js. The thresholds encode the Phase 9.6 spec bands.
 */

import type { Freshness, StageState, StreamKey } from "./ops-types";

/** Per-stream freshness bands (seconds). `warning` and `stale` are inclusive lower edges. */
export interface StreamThreshold {
  key: StreamKey;
  label: string;
  warningSec: number;
  staleSec: number;
}

/**
 * The live data-flow streams (Section B). Live-feed streams use the spec's
 * 30s/120s band; lower-cadence artifacts widen the band to their natural rhythm
 * while keeping the identical fresh/warning/stale model. The `staleSec` values
 * line up with the Section E alert thresholds (ticks 60, signals 120, exec 300).
 */
export const STREAM_THRESHOLDS: readonly StreamThreshold[] = [
  { key: "marketTick", label: "Market Ticks", warningSec: 30, staleSec: 60 },
  { key: "orderbookSnapshot", label: "Orderbook Snapshots", warningSec: 30, staleSec: 120 },
  { key: "marketCandle", label: "Market Candles", warningSec: 120, staleSec: 600 },
  { key: "featureSnapshot", label: "Feature Snapshots", warningSec: 60, staleSec: 180 },
  { key: "engineSignal", label: "Engine Signals", warningSec: 60, staleSec: 120 },
  { key: "execution", label: "Executions", warningSec: 120, staleSec: 300 },
] as const;

/**
 * Classify a lag (seconds) into a freshness band.
 *   lag <= warning → fresh
 *   lag <= stale   → warning
 *   lag >  stale   → stale
 *   lag == null    → unknown (no data observed)
 */
export function freshnessFromLag(
  lagSeconds: number | null,
  warningSec: number,
  staleSec: number,
): Freshness {
  if (lagSeconds === null) return "unknown";
  if (lagSeconds <= warningSec) return "fresh";
  if (lagSeconds <= staleSec) return "warning";
  return "stale";
}

const FRESHNESS_RANK: Record<Freshness, number> = {
  fresh: 0,
  unknown: 1,
  warning: 2,
  stale: 3,
};

/** Worst-of reducer over freshness bands (used for the data-flow overall). */
export function worstFreshness(values: Freshness[]): Freshness {
  return values.reduce<Freshness>(
    (acc, v) => (FRESHNESS_RANK[v] > FRESHNESS_RANK[acc] ? v : acc),
    "fresh",
  );
}

/** Inputs for the generic pipeline-stage state machine. */
export interface StageInput {
  lastEventAt: Date | null;
  count24h: number;
  errorCount: number;
  /** Age (s) below which the stage is "active". */
  freshSec: number;
  /** Age (s) above which a producing stage is considered "failing". */
  staleSec: number;
  now: number;
}

/**
 * Generic producer-stage state machine (Section C). Risk / execution /
 * persistence stages have bespoke rules and do NOT use this — see ops.ts.
 *   empty    : never produced anything.
 *   failing  : errors with nothing fresh, OR very stale past `staleSec`.
 *   degraded : recent errors but still producing.
 *   active   : produced within `freshSec`.
 *   idle     : produced within `staleSec` (quiet but healthy).
 */
export function deriveStageState(input: StageInput): StageState {
  const { lastEventAt, count24h, errorCount, freshSec, staleSec, now } = input;
  if (lastEventAt === null && count24h === 0) return "empty";
  const ageSec = lastEventAt === null ? Infinity : (now - lastEventAt.getTime()) / 1000;
  if (errorCount > 0 && ageSec > staleSec) return "failing";
  if (errorCount > 0) return "degraded";
  if (ageSec <= freshSec) return "active";
  if (ageSec <= staleSec) return "idle";
  return "failing";
}

const STAGE_RANK: Record<StageState, number> = {
  active: 0,
  idle: 1,
  empty: 2,
  unknown: 3,
  degraded: 4,
  failing: 5,
};

/** Worst-of reducer over stage states (used for the pipeline overall). */
export function worstStageState(values: StageState[]): StageState {
  if (values.length === 0) return "unknown";
  return values.reduce<StageState>(
    (acc, v) => (STAGE_RANK[v] > STAGE_RANK[acc] ? v : acc),
    "active",
  );
}
