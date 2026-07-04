/**
 * Pure, deterministic helpers shared across the portfolio-intelligence engine. No IO, no
 * clock, no randomness. Numbers are rounded deterministically so identical inputs serialize
 * identically. Everything fails closed (null / 0) and never returns a NaN.
 */

import type { Measure } from "@nexus/trading-decision";

/** A tri-state: true = PASS / met, false = FAIL / unmet, null = UNKNOWN (no source). */
export type Tri = boolean | null;

export function clamp(x: number, lo: number, hi: number): number {
  if (!Number.isFinite(x)) return lo;
  return x < lo ? lo : x > hi ? hi : x;
}

export function clamp01(x: number): number {
  return clamp(x, 0, 1);
}

/** Deterministic fixed-decimal rounding that normalizes -0 → 0. */
export function round(x: number, dp: number): number {
  if (!Number.isFinite(x)) return 0;
  const r = Number(x.toFixed(dp));
  return r === 0 ? 0 : r;
}

/**
 * Finite value of a Measure, or null — fail-closed. A null/non-finite measure (or a
 * missing one) is treated as absent, never as 0.
 */
export function mv(m: Measure | null | undefined): number | null {
  if (!m || m.value === null || m.value === undefined || !Number.isFinite(m.value)) return null;
  return m.value;
}

/** Finite number or null — fail-closed (treats NaN / Infinity / missing as absent). */
export function fin(x: number | null | undefined): number | null {
  return x === null || x === undefined || !Number.isFinite(x) ? null : x;
}

/** Sum of the finite values only (absent values contribute nothing). Always finite. */
export function sumFinite(xs: ReadonlyArray<number | null | undefined>): number {
  let acc = 0;
  for (const x of xs) if (x !== null && x !== undefined && Number.isFinite(x)) acc += x;
  return acc;
}

/** Arithmetic mean of the finite values, or null when none exist (never NaN). */
export function avg(xs: ReadonlyArray<number | null | undefined>): number | null {
  const vals = xs.filter((x): x is number => x !== null && x !== undefined && Number.isFinite(x));
  if (vals.length === 0) return null;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

/** Median of the finite values, or null when none exist (deterministic, never NaN). */
export function median(xs: ReadonlyArray<number | null | undefined>): number | null {
  const vals = xs
    .filter((x): x is number => x !== null && x !== undefined && Number.isFinite(x))
    .sort((a, b) => a - b);
  if (vals.length === 0) return null;
  const mid = Math.floor(vals.length / 2);
  if (vals.length % 2 === 1) return vals[mid] as number;
  return ((vals[mid - 1] as number) + (vals[mid] as number)) / 2;
}

/** Maximum of the finite values, or null when none exist. */
export function maxFinite(xs: ReadonlyArray<number | null | undefined>): number | null {
  const vals = xs.filter((x): x is number => x !== null && x !== undefined && Number.isFinite(x));
  if (vals.length === 0) return null;
  return vals.reduce((a, b) => (b > a ? b : a));
}

/** Minimum of the finite values, or null when none exist. */
export function minFinite(xs: ReadonlyArray<number | null | undefined>): number | null {
  const vals = xs.filter((x): x is number => x !== null && x !== undefined && Number.isFinite(x));
  if (vals.length === 0) return null;
  return vals.reduce((a, b) => (b < a ? b : a));
}

/** Safe division — null when the denominator is 0 / non-finite (never Infinity / NaN). */
export function safeDiv(num: number, den: number): number | null {
  if (!Number.isFinite(num) || !Number.isFinite(den) || den === 0) return null;
  return num / den;
}
