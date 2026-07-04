/**
 * Logical event bus (Phase 4) — the explicit seam that decouples production from
 * consumption. NOT infrastructure yet: this is an in-process abstraction with the
 * exact shape a Redis/BullMQ bridge will later implement, so producers (the tick
 * loop) and consumers (persistence today; streaming next) no longer call each
 * other directly.
 *
 * InProcessEventBus fans out SYNCHRONOUSLY: publish() awaits every subscriber and
 * rejects if any throws. That preserves the existing runtime guarantee — a tick
 * that publishes a DecisionEvent sees persistence complete (and any failure
 * surface, fail-closed) before it returns — while removing the direct call.
 * Subscribers run in registration order; a throwing subscriber aborts the publish
 * (no partial silent success), matching the prior direct-persist semantics.
 */

import type { DecisionEvent } from "./types.js";

export type DecisionHandler = (event: DecisionEvent) => Promise<void> | void;

export interface EventBus {
  /** Deliver `event` to all subscribers; resolves only once all have settled. */
  publish(event: DecisionEvent): Promise<void>;
  /** Register `handler`; returns an idempotent unsubscribe. */
  subscribe(handler: DecisionHandler): () => void;
}

export class InProcessEventBus implements EventBus {
  private readonly handlers = new Set<DecisionHandler>();

  subscribe(handler: DecisionHandler): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  async publish(event: DecisionEvent): Promise<void> {
    // Sequential, in registration order, awaited — fail-closed: the first
    // throwing subscriber aborts the publish (rethrown to the producer).
    for (const handler of this.handlers) {
      await handler(event);
    }
  }
}
