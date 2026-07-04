/**
 * Pure, deterministic helpers shared across the trade-plan engine. No IO, no clock, no
 * randomness. Numbers are rounded deterministically so identical inputs serialize
 * identically. Everything fails closed (null / 0 / "—") and never returns a NaN.
 */

import type { Measure, Provenance, RiskTag } from "./types.js";

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

/** Map a tri-state to a checklist status. */
export function triStatus(t: Tri): "PASS" | "FAIL" | "UNKNOWN" {
  return t === null ? "UNKNOWN" : t ? "PASS" : "FAIL";
}

/** Map a Measure's lowercase provenance onto Section C's uppercase risk tag set. */
export function toRiskTag(p: Provenance): RiskTag {
  switch (p) {
    case "verbatim":
    case "real":
      return "REAL";
    case "derived":
      return "DERIVED";
    case "estimated":
      return "ESTIMATED";
    case "unavailable":
    default:
      return "UNAVAILABLE";
  }
}
