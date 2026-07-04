/**
 * Pure, deterministic helpers shared across the engine. No IO, no clock, no
 * randomness. Numbers are rounded deterministically at the border so identical
 * inputs serialize identically.
 */

import { DEFAULT_SIGNAL_PARAMS, type Measure, type Provenance, type SignalParams } from "./types.js";

export function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

/** Clamp to a 0..100 score band. */
export function clampScore(x: number): number {
  if (!Number.isFinite(x)) return 0;
  if (x < 0) return 0;
  if (x > 100) return 100;
  return x;
}

/** Deterministic fixed-decimal rounding that normalizes -0 → 0. */
export function round(x: number, dp: number): number {
  if (!Number.isFinite(x)) return 0;
  const r = Number(x.toFixed(dp));
  return r === 0 ? 0 : r;
}

/**
 * Fail-closed feature access: returns the finite number for `key`, or null when the
 * key is missing or non-finite. Callers fail closed (an `unavailable` Measure), never
 * a NaN that could slip into a price/score. Mirrors the sealed `feature()` intent
 * without throwing, so the whole engine stays total.
 */
export function readFeature(features: Record<string, number>, key: string): number | null {
  const v = features[key];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

export function measure(value: number, provenance: Provenance, basis: string): Measure {
  return { value, provenance, basis };
}

export function unavailable(basis: string): Measure {
  return { value: null, provenance: "unavailable", basis };
}

/** Seconds between two ISO/epoch instants (>= 0), or null when `then` is absent. */
export function ageSeconds(nowMs: number, then: string | null): number | null {
  if (then === null) return null;
  const t = new Date(then).getTime();
  if (!Number.isFinite(t)) return null;
  return Math.max(0, Math.round((nowMs - t) / 1000));
}

/**
 * Coerce a persisted `EngineSignal.strategyParams` JSON blob into typed SignalParams,
 * falling back to the canonical defaults for any missing/non-finite key. Mirrors the
 * sealed `resolveSignalParams` (services/workers/src/signal/decision.ts) so the web and
 * worker read the same params off a signal.
 */
export function resolveSignalParams(raw: Record<string, unknown> | null | undefined): SignalParams {
  const num = (v: unknown, fallback: number): number =>
    typeof v === "number" && Number.isFinite(v) ? v : fallback;
  const p = raw ?? {};
  return {
    rsiLongMin: num(p["rsiLongMin"], DEFAULT_SIGNAL_PARAMS.rsiLongMin),
    rsiShortMax: num(p["rsiShortMax"], DEFAULT_SIGNAL_PARAMS.rsiShortMax),
    maxRealizedVol: num(p["maxRealizedVol"], DEFAULT_SIGNAL_PARAMS.maxRealizedVol),
  };
}
