/**
 * Stable, replay-safe serialization.
 *
 * `stableStringify` emits JSON with object keys sorted lexicographically at every depth, so
 * two structurally-equal states serialize to byte-identical strings regardless of insertion
 * order. Used for determinism/replay assertions and for a future durable audit sink. Arrays
 * keep their order (order is semantic for orders/fills/events). Fail-closed: a non-finite
 * number would already have been normalized upstream; here it is emitted as null rather than
 * the invalid JSON token `NaN`/`Infinity`.
 */

import type { ExecutionAudit, ExecutionState } from "./types.js";

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

/** Stable serialization of a full execution state (audit included). */
export function serializeExecutionState(state: ExecutionState): string {
  return stableStringify(state);
}

/** Stable serialization of just the audit trail. */
export function serializeAudit(audit: ExecutionAudit): string {
  return stableStringify(audit);
}
