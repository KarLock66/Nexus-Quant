/**
 * Execution event bus (Phase 5) — the logical seam that decouples the execution
 * stage (producer) from execution-event consumers (logging, future streaming /
 * portfolio-state projection, Redis bridge). It is the exact analogue of the
 * Phase 4 decision bus for the effectful tail of the chain: NOT infrastructure,
 * an in-process abstraction with the shape a Redis/BullMQ bridge will implement.
 *
 * Like the decision bus it fans out SYNCHRONOUSLY and FAIL-CLOSED: publish() awaits
 * every subscriber in registration order and rejects if any throws (no partial
 * silent success). Subscribers here are observers (logging, projection); the
 * effectful execution itself happens in the stage via adapters, not in a
 * subscriber, so the bus carries OUTCOMES, never triggers side effects.
 */

import type { ExecutionStageEvent } from "./types.js";

export type ExecutionHandler = (
  event: ExecutionStageEvent,
) => Promise<void> | void;

export interface ExecutionBus {
  /** Deliver `event` to all subscribers; resolves only once all have settled. */
  publish(event: ExecutionStageEvent): Promise<void>;
  /** Register `handler`; returns an idempotent unsubscribe. */
  subscribe(handler: ExecutionHandler): () => void;
}

export class InProcessExecutionBus implements ExecutionBus {
  private readonly handlers = new Set<ExecutionHandler>();

  subscribe(handler: ExecutionHandler): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  async publish(event: ExecutionStageEvent): Promise<void> {
    for (const handler of this.handlers) {
      await handler(event);
    }
  }
}
