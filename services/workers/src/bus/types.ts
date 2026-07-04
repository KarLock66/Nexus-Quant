/**
 * Distributed bus — shared contracts (Phase 7).
 *
 * Phases 4-6 each shipped a logical bus (EventBus / ExecutionBus / MarketBus),
 * every one documented as "the exact shape a Redis/BullMQ bridge will implement":
 * a publish/subscribe seam decoupling producers from consumers. All three are
 * structurally one shape — `publish(event)` + `subscribe(handler)` — so a single
 * generic `PubSubBus<E>` covers them, and a typed bridge over channel `E`
 * SATISFIES the corresponding sealed interface by structure (no interface change).
 *
 * Phase 7 implements that shape over real infrastructure (Redis pub/sub, BullMQ),
 * selectable at the edge while the in-process bus remains the default — so every
 * Phase 1-6 test, which constructs the in-process bus, is byte-for-byte unaffected.
 */

import type { DecisionEvent } from "../execution/types.js";
import type { ExecutionStageEvent } from "../execution/types.js";
import type { MarketStageEvent } from "../market/types.js";

/**
 * The common publish/subscribe shape of every logical bus. `EventBus`,
 * `ExecutionBus`, and `MarketBus` are each structurally `PubSubBus<their event>`,
 * so a `PubSubBus<DecisionEvent>` IS an `EventBus`, etc. — the bridges below are
 * typed against this and drop into the existing seams unchanged.
 */
export interface PubSubBus<E> {
  /** Deliver `event` to subscribers. See each impl for delivery/durability semantics. */
  publish(event: E): Promise<void>;
  /** Register `handler`; returns an idempotent unsubscribe. */
  subscribe(handler: (event: E) => Promise<void> | void): () => void;
}

/** Canonical channel / queue names — one per logical bus, stable across processes. */
export const BUS_CHANNELS = {
  decision: "nexus.bus.decision",
  execution: "nexus.bus.execution",
  market: "nexus.bus.market",
} as const;

/** Which bus backend the worker wires at startup (default: in-process). */
export type BusBackend = "inprocess" | "redis" | "bullmq";

/** Parse the BUS_BACKEND env into a known backend (defaults to in-process). */
export function readBusBackend(raw: string | undefined): BusBackend {
  return raw === "redis" || raw === "bullmq" ? raw : "inprocess";
}

// Re-export the event types the typed factories bind to, so callers import one place.
export type { DecisionEvent, ExecutionStageEvent, MarketStageEvent };
