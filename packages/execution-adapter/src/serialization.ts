/**
 * serialization.ts — stable, replay-safe serialization for the adapter.
 *
 * `stableStringify` emits JSON with object keys sorted lexicographically at every depth, so two
 * structurally-equal sessions serialize to byte-identical strings regardless of insertion
 * order. Arrays keep their order (order is semantic for events). Fail-closed: a non-finite
 * number is emitted as null rather than the invalid JSON tokens NaN / Infinity. This mirrors
 * the sealed core's serialization contract exactly, so an adapter replay is byte-comparable.
 */

import type { AdapterEvent, AdapterSession } from "./types.js";

function normalize(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (Array.isArray(value)) return value.map(normalize);
  if (typeof value === "object") {
    const src = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(src).sort()) out[key] = normalize(src[key]);
    return out;
  }
  return value;
}

/** Deterministic JSON with sorted keys at every depth. */
export function stableStringify(value: unknown): string {
  return JSON.stringify(normalize(value));
}

/** Stable serialization of a full adapter session (managed core state + event log included). */
export function serializeSession(session: AdapterSession): string {
  return stableStringify(session);
}

/** Stable serialization of just the adapter event log. */
export function serializeEvents(events: readonly AdapterEvent[]): string {
  return stableStringify(events);
}
