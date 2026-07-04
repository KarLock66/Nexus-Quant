/**
 * Market event bus (Phase 6) — the logical seam that decouples the market stage
 * (producer) from market-event consumers (logging, future streaming / Redis
 * bridge). The exact analogue of the Phase 4 decision bus and the Phase 5
 * execution bus, for the order/position/account tail of the chain: NOT
 * infrastructure, an in-process abstraction with the shape a Redis/BullMQ bridge
 * will implement.
 *
 * Fans out SYNCHRONOUSLY and FAIL-CLOSED: publish() awaits every subscriber in
 * registration order and rejects if any throws (no partial silent success).
 * Subscribers are OBSERVERS only — the effectful execution happens in the stage
 * via the broker, never in a subscriber, so the bus carries OUTCOMES, never
 * triggers side effects.
 */

import type { MarketStageEvent } from "./types.js";

export type MarketHandler = (event: MarketStageEvent) => Promise<void> | void;

export interface MarketBus {
  /** Deliver `event` to all subscribers; resolves only once all have settled. */
  publish(event: MarketStageEvent): Promise<void>;
  /** Register `handler`; returns an idempotent unsubscribe. */
  subscribe(handler: MarketHandler): () => void;
}

export class InProcessMarketBus implements MarketBus {
  private readonly handlers = new Set<MarketHandler>();

  subscribe(handler: MarketHandler): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  async publish(event: MarketStageEvent): Promise<void> {
    for (const handler of this.handlers) {
      await handler(event);
    }
  }
}
