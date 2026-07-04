/**
 * events.ts — the adapter's immutable event model.
 *
 * Adapter events are pure data. `makeAdapterEvent` is the ONLY constructor; it stamps a
 * deterministic id from (intentId, seq) and copies the injected clock into `ts` (never
 * Date.now). `mapCoreEventType` projects the sealed core's rich internal event vocabulary onto
 * the small venue-shaped adapter vocabulary — internal-only core transitions (PLANNED / ARMED /
 * OPENED) map to null and emit NO adapter event. Nothing here mutates a prior event.
 */

import type { ExecutionEventType } from "@nexus/execution-core";
import type {
  AdapterEvent,
  AdapterEventType,
  AdapterKind,
  ExecutionMode,
  ExecutionProvenance,
  ExecutionVenue,
} from "./types.js";

/** Deterministic adapter event id — gap-free, replay-stable, distinct from core event ids. */
export function adapterEventId(intentId: string, seq: number): string {
  return `adapter:${intentId}:evt:${seq}`;
}

export interface MakeAdapterEventArgs {
  intentId: string;
  seq: number;
  adapter: AdapterKind;
  orderId: string | null;
  type: AdapterEventType;
  mode: ExecutionMode;
  venue: ExecutionVenue;
  reason: string;
  provenance: ExecutionProvenance;
  ts: number;
}

/** Construct one immutable adapter event. Deterministic id; injected clock only. */
export function makeAdapterEvent(a: MakeAdapterEventArgs): AdapterEvent {
  return {
    eventId: adapterEventId(a.intentId, a.seq),
    seq: a.seq,
    adapter: a.adapter,
    intentId: a.intentId,
    orderId: a.orderId,
    type: a.type,
    mode: a.mode,
    venue: a.venue,
    reason: a.reason,
    provenance: a.provenance,
    ts: a.ts,
  };
}

/**
 * Project a sealed-core {@link ExecutionEventType} onto an {@link AdapterEventType}, or null
 * when the transition is internal to the core and crosses no venue boundary. Deterministic and
 * total (an unmapped/unknown type fails closed to null → no event, never a fabricated one).
 */
export function mapCoreEventType(coreType: ExecutionEventType): AdapterEventType | null {
  switch (coreType) {
    case "SUBMITTED":
      return "SUBMITTED";
    case "ACKNOWLEDGED":
      return "ACKNOWLEDGED";
    case "PARTIALLY_FILLED":
      return "PARTIAL_FILL";
    case "FILLED":
      return "FILLED";
    case "REDUCED":
      // A protective fill that partially reduced an open position — a partial venue fill.
      return "PARTIAL_FILL";
    case "CLOSED":
      // A protective fill (or close) that flattened the position — a terminal venue fill.
      return "FILLED";
    case "CANCELLED":
    case "KILLED":
      return "CANCELLED";
    case "REJECTED":
    case "REJECTED_TRANSITION":
      return "REJECTED";
    case "EXPIRED":
      return "EXPIRED";
    case "FAILED":
      return "FAILED";
    case "PLANNED":
    case "ARMED":
    case "OPENED":
      // Internal core bookkeeping — no venue boundary crossed, no adapter event.
      return null;
    default: {
      // Exhaustiveness guard — an unknown core type fails closed to "no event".
      const _never: never = coreType;
      void _never;
      return null;
    }
  }
}
