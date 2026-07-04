/**
 * Pure, deterministic helpers shared across the execution core. No IO, no clock, no
 * randomness. Numbers are rounded deterministically so identical inputs serialize
 * identically. Everything fails closed (null / 0) and never returns a NaN. All IDs are
 * derived from stable inputs + counters — never from Date.now / Math.random.
 */

import type { ExecutionProvenance, Measure, Provenance } from "./types.js";

/** A finite number, or null — fail-closed. Non-finite / missing → null, never 0. */
export function num(x: number | null | undefined): number | null {
  return typeof x === "number" && Number.isFinite(x) ? x : null;
}

/** Finite value of a decision Measure, or null — fail-closed (null/NaN/missing → null). */
export function mv(m: Measure | null | undefined): number | null {
  if (!m) return null;
  return num(m.value);
}

export function clamp(x: number, lo: number, hi: number): number {
  if (!Number.isFinite(x)) return lo;
  return x < lo ? lo : x > hi ? hi : x;
}

export function clamp01(x: number): number {
  return clamp(x, 0, 1);
}

/** Deterministic fixed-decimal rounding that normalizes -0 → 0 and non-finite → 0. */
export function round(x: number, dp: number): number {
  if (!Number.isFinite(x)) return 0;
  const r = Number(x.toFixed(dp));
  return r === 0 ? 0 : r;
}

/** Sum of the finite entries only — fail-closed (non-finite entries are ignored). */
export function sumFinite(xs: readonly (number | null | undefined)[]): number {
  let s = 0;
  for (const x of xs) if (typeof x === "number" && Number.isFinite(x)) s += x;
  return s;
}

/**
 * Map a served decision Measure's lowercase {@link Provenance} onto the execution core's
 * uppercase {@link ExecutionProvenance}. `verbatim`/`real` both become VERBATIM (from the
 * executor's vantage the served value is copied as-is); the rest map by name. Fail-closed:
 * an unknown tag → UNAVAILABLE.
 */
export function toExecProvenance(p: Provenance | null | undefined): ExecutionProvenance {
  switch (p) {
    case "verbatim":
    case "real":
      return "VERBATIM";
    case "derived":
      return "DERIVED";
    case "estimated":
      return "ESTIMATED";
    case "unavailable":
    default:
      return "UNAVAILABLE";
  }
}

/**
 * Provenance of a level copied off the decision: VERBATIM when a finite value is present,
 * UNAVAILABLE otherwise. The executor never upgrades an absent level into a fabricated one.
 */
export function levelProvenance(m: Measure | null | undefined): ExecutionProvenance {
  return mv(m) === null ? "UNAVAILABLE" : "VERBATIM";
}

// ─────────────────────────── Deterministic IDs ───────────────────────────

/** Deterministic intent id from a signal id (stable across replays). */
export function intentId(signalId: string): string {
  return `exec:${signalId}`;
}

export function planId(intentId: string): string {
  return `${intentId}:plan`;
}

/** Order id is deterministic in (plan, role, index) → same plan yields the same ids. */
export function orderId(planId: string, role: string, index: number): string {
  return `${planId}:ord:${role.toLowerCase()}:${index}`;
}

/** Fill id is deterministic in (order, per-order fill sequence). */
export function fillId(orderId: string, fillSeq: number): string {
  return `${orderId}:fill:${fillSeq}`;
}

export function positionId(intentId: string): string {
  return `${intentId}:pos`;
}

/** Event id is deterministic in (intent, monotonic sequence) → gap-free, replay-stable. */
export function eventId(intentId: string, seq: number): string {
  return `${intentId}:evt:${seq}`;
}
