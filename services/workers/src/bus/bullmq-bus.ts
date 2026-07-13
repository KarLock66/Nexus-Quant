/**
 * BullMQ bus bridge (Phase 7) — the DURABLE, at-least-once delivery backend.
 *
 * Implements the logical bus shape (PubSubBus) over a BullMQ queue: publish ENQUEUES
 * the event as a durable job (persisted in Redis); a Worker consumes jobs and runs
 * every registered handler. Unlike the Redis pub/sub bridge, delivery is durable
 * and retried — a job whose handler throws is NOT acked, so BullMQ redelivers it
 * (configurable attempts/backoff). This is the backend to choose when a consumer
 * MUST eventually process every event even across consumer restarts (the
 * fail-closed-by-retry analogue of the in-process bus's fail-closed-by-rejection).
 *
 * Depends only on minimal structural `QueueLike` / `WorkerFactory` surfaces (real
 * BullMQ `Queue` / `Worker` satisfy them), so the bridge is unit-testable against
 * fakes with no live Redis. publish() resolves once the job is durably enqueued —
 * processing happens asynchronously in the Worker, exactly as a job queue intends.
 */

import { errMsg } from "../lib/log.js";
import { admitDecisionEvent } from "./admission.js";
import { BUS_CHANNELS, type PubSubBus } from "./types.js";
import type {
  DecisionEvent,
  ExecutionStageEvent,
  MarketStageEvent,
} from "./types.js";

/** Minimal producer surface — real BullMQ `Queue` satisfies it. */
export interface QueueLike<E> {
  add(name: string, data: E): Promise<unknown>;
}

/** Minimal consumer surface — real BullMQ `Worker` satisfies it. */
export interface WorkerLike {
  close(): Promise<unknown>;
}

/**
 * Creates the consumer Worker, wiring it to `process` (invoked per job's data). The
 * factory indirection keeps the bridge testable (a fake can invoke `process`
 * directly) and lets the caller own the Redis connection + Worker options
 * (attempts, concurrency, backoff).
 */
export type WorkerFactory<E> = (process: (data: E) => Promise<void>) => WorkerLike;

/**
 * A `PubSubBus<E>` over a BullMQ queue. The Worker is created lazily on the first
 * `subscribe` (a publish-only instance starts no consumer). The Worker's processor
 * runs every handler; a throwing handler rejects the job so BullMQ redelivers it.
 */
export class BullMqBus<E> implements PubSubBus<E> {
  private readonly handlers = new Set<(event: E) => Promise<void> | void>();
  private worker: WorkerLike | null = null;

  constructor(
    private readonly queue: QueueLike<E>,
    private readonly jobName: string,
    private readonly workerFactory: WorkerFactory<E>,
    /**
     * Admission codec (Phase 11C Stage 3): runs on the raw job data (as
     * `unknown`) BEFORE the handler loop; its throw propagates UN-WRAPPED so the
     * processor owner can distinguish a malformed payload (unrecoverable — dead-
     * letter, never retry) from a transient handler failure (retryable). Absent,
     * job data is dispatched as-is (in-type trust — test bridges only).
     */
    private readonly admit?: (v: unknown) => E,
  ) {}

  subscribe(handler: (event: E) => Promise<void> | void): () => void {
    // Register the handler BEFORE starting the consumer, so the Worker's first
    // drain of any enqueued backlog already sees it (no published-before-subscribe
    // job is processed by an empty handler set and lost).
    this.handlers.add(handler);
    this.ensureWorker();
    return () => {
      this.handlers.delete(handler);
    };
  }

  async publish(event: E): Promise<void> {
    await this.queue.add(this.jobName, event);
  }

  /** Stop the consumer Worker (idempotent); the queue connection is the caller's. */
  async close(): Promise<void> {
    if (this.worker !== null) {
      await this.worker.close();
      this.worker = null;
    }
  }

  private ensureWorker(): void {
    if (this.worker !== null) return;
    this.worker = this.workerFactory(async (data: E) => {
      // Trust boundary: job data is whatever was durably enqueued (any process
      // with Redis access, or a legacy/corrupt entry). Admission runs BEFORE the
      // handler loop and its throw propagates un-wrapped (see constructor).
      const event = this.admit === undefined ? data : this.admit(data);
      // Run every handler; let a throw propagate so the job is retried (durable).
      for (const handler of this.handlers) {
        try {
          await handler(event);
        } catch (err) {
          throw new Error(`bullmq bus handler failed on ${this.jobName}: ${errMsg(err)}`);
        }
      }
    });
  }
}

// ── Typed factories — each returns the matching sealed bus interface by structure ──

/**
 * A BullMQ-backed decision bus (satisfies execution/bus.ts `EventBus`). Admission
 * is BAKED IN (Phase 11C Stage 3): every consumed job passes admitDecisionEvent
 * before any handler runs; a malformed payload throws BusAdmissionError out of
 * the processor for the caller to translate (e.g. bullmq UnrecoverableError).
 */
export function createBullMqDecisionBus(
  queue: QueueLike<DecisionEvent>,
  workerFactory: WorkerFactory<DecisionEvent>,
): PubSubBus<DecisionEvent> {
  return new BullMqBus<DecisionEvent>(
    queue,
    BUS_CHANNELS.decision,
    workerFactory,
    admitDecisionEvent,
  );
}

/** A BullMQ-backed execution bus (satisfies execution/execution-bus.ts `ExecutionBus`). */
export function createBullMqExecutionBus(
  queue: QueueLike<ExecutionStageEvent>,
  workerFactory: WorkerFactory<ExecutionStageEvent>,
): PubSubBus<ExecutionStageEvent> {
  return new BullMqBus<ExecutionStageEvent>(queue, BUS_CHANNELS.execution, workerFactory);
}

/** A BullMQ-backed market bus (satisfies market/market-bus.ts `MarketBus`). */
export function createBullMqMarketBus(
  queue: QueueLike<MarketStageEvent>,
  workerFactory: WorkerFactory<MarketStageEvent>,
): PubSubBus<MarketStageEvent> {
  return new BullMqBus<MarketStageEvent>(queue, BUS_CHANNELS.market, workerFactory);
}
