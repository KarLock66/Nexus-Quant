/**
 * Execution event model — the immutable record of every state transition.
 *
 * Events are pure data. `makeEvent` is the ONLY constructor; it stamps a deterministic
 * event id from (intentId, seq) and copies the injected clock into `ts` (never Date.now).
 * Nothing here mutates prior events.
 */

import { eventId } from "./util.js";
import type {
  ExecutionEntity,
  ExecutionEvent,
  ExecutionEventType,
  ExecutionProvenance,
  ExecutionSource,
} from "./types.js";

export interface MakeEventArgs {
  intentId: string;
  seq: number;
  entity: ExecutionEntity;
  entityId: string;
  type: ExecutionEventType;
  previousStatus: string | null;
  newStatus: string | null;
  source: ExecutionSource;
  provenance: ExecutionProvenance;
  reason: string;
  ts: number;
}

/** Construct one immutable audit event. Deterministic id; injected clock only. */
export function makeEvent(a: MakeEventArgs): ExecutionEvent {
  return {
    eventId: eventId(a.intentId, a.seq),
    seq: a.seq,
    intentId: a.intentId,
    entity: a.entity,
    entityId: a.entityId,
    type: a.type,
    previousStatus: a.previousStatus,
    newStatus: a.newStatus,
    source: a.source,
    provenance: a.provenance,
    reason: a.reason,
    ts: a.ts,
  };
}
