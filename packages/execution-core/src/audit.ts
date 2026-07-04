/**
 * Immutable execution audit trail.
 *
 * The audit is append-only: `appendEvent` returns a NEW {@link ExecutionAudit} with the
 * event added; the prior events array is never mutated. Replay-safe — feeding the same
 * event stream reproduces an identical audit byte-for-byte.
 */

import type { ExecutionAudit, ExecutionEvent } from "./types.js";

/** An empty audit for a fresh intent. */
export function emptyAudit(intentId: string): ExecutionAudit {
  return { intentId, events: [], count: 0 };
}

/** Append one event immutably, returning a new audit (inputs untouched). */
export function appendEvent(audit: ExecutionAudit, event: ExecutionEvent): ExecutionAudit {
  const events = [...audit.events, event];
  return { intentId: audit.intentId, events, count: events.length };
}

/** The most recent event, or null on an empty audit. */
export function lastEvent(audit: ExecutionAudit): ExecutionEvent | null {
  return audit.count === 0 ? null : (audit.events[audit.count - 1] ?? null);
}
