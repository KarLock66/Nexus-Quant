/**
 * Redis pub/sub bus bridge (Phase 7).
 *
 * Implements the logical bus shape (PubSubBus) over Redis pub/sub: publish PUBLISHes
 * the JSON-serialized event on the bus channel; a dedicated subscriber connection
 * receives every published message (including this process's own) and dispatches it
 * to the registered handlers. One delivery path (the subscriber connection), so a
 * same-process subscriber is NOT double-delivered.
 *
 * Semantics vs the in-process bus: the PUBLIC INTERFACE is preserved
 * (publish/subscribe), but cross-process delivery is necessarily decoupled —
 * publish() resolves once the message is handed to Redis (broadcast, at-most-once,
 * fire-and-forget), NOT once remote handlers finish. The synchronous, fail-closed,
 * await-all-subscribers contract of the in-process bus cannot hold across a process
 * boundary; when at-least-once durable delivery with retries is required, use the
 * BullMQ bridge instead (that is exactly why both backends exist).
 *
 * Depends ONLY on a minimal structural `RedisLike` (which real ioredis satisfies),
 * so the bridge is unit-testable against an in-memory fake with no live Redis.
 */

import { errMsg, log } from "../lib/log.js";
import { admitDecisionEvent } from "./admission.js";
import { BUS_CHANNELS, type PubSubBus } from "./types.js";
import type {
  DecisionEvent,
  ExecutionStageEvent,
  MarketStageEvent,
} from "./types.js";

/**
 * The minimal ioredis surface the bridge uses (real `Redis` satisfies it). A
 * subscriber connection is obtained via `duplicate()` because a connection in
 * subscribe mode cannot also issue PUBLISH.
 */
export interface RedisLike {
  publish(channel: string, message: string): Promise<number>;
  subscribe(...channels: string[]): Promise<unknown>;
  on(
    event: "message",
    listener: (channel: string, message: string) => void,
  ): unknown;
  duplicate(): RedisLike;
}

export interface RedisChannelBusOptions<E = unknown> {
  /** Invoked when a handler throws during dispatch (no producer to fail-close to). */
  onError?: (err: unknown, channel: string) => void;
  /**
   * Admission codec (Phase 11C Stage 3): runs on the raw JSON.parse result
   * (as `unknown`) BEFORE dispatch; returns the trusted event or throws. Absent,
   * the parsed value is dispatched as-is (in-type trust — test bridges only; the
   * decision factory below always bakes one in).
   */
  admit?: (v: unknown) => E;
  /**
   * Invoked when a message fails JSON parsing or admission. Default: log + DROP,
   * keep consuming (skip-not-halt — at-most-once broadcast has nothing to retry
   * on, and throwing from the ioredis message listener would crash the process).
   */
  onReject?: (detail: string, channel: string) => void;
}

/**
 * A `PubSubBus<E>` over one Redis channel. The publisher connection is shared; a
 * subscriber connection is lazily duplicated on the first `subscribe` so a
 * publish-only instance opens no extra socket.
 */
export class RedisChannelBus<E> implements PubSubBus<E> {
  private readonly handlers = new Set<(event: E) => Promise<void> | void>();
  private subscriber: RedisLike | null = null;
  private readonly onError: (err: unknown, channel: string) => void;
  private readonly admit: (v: unknown) => E;
  private readonly onReject: (detail: string, channel: string) => void;

  constructor(
    private readonly publisher: RedisLike,
    private readonly channel: string,
    options: RedisChannelBusOptions<E> = {},
  ) {
    this.onError =
      options.onError ??
      ((err, channel) => {
        // No producer to propagate to across the boundary — surface, never swallow.
        throw new Error(`redis bus handler failed on ${channel}: ${errMsg(err)}`);
      });
    this.admit = options.admit ?? ((v) => v as E);
    this.onReject =
      options.onReject ??
      ((detail, channel) => {
        log("error", "redis bus message rejected (malformed — dropped)", {
          channel,
          detail,
        });
      });
  }

  subscribe(handler: (event: E) => Promise<void> | void): () => void {
    this.ensureSubscriber();
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  async publish(event: E): Promise<void> {
    await this.publisher.publish(this.channel, JSON.stringify(event));
  }

  private ensureSubscriber(): void {
    if (this.subscriber !== null) return;
    const sub = this.publisher.duplicate();
    sub.on("message", (channel, message) => {
      if (channel !== this.channel) return;
      // Trust boundary: `message` is bytes any Redis client can have published.
      // Parse and admission failures REJECT (log + drop, keep consuming) — they
      // never reach onError, which would throw inside this ioredis listener.
      let parsed: unknown;
      try {
        parsed = JSON.parse(message);
      } catch (err) {
        this.onReject(`message is not valid JSON: ${errMsg(err)}`, channel);
        return;
      }
      let event: E;
      try {
        event = this.admit(parsed);
      } catch (err) {
        this.onReject(errMsg(err), channel);
        return;
      }
      void this.dispatch(event);
    });
    void sub.subscribe(this.channel);
    this.subscriber = sub;
  }

  /** Await every handler in registration order; route a throw to onError. */
  private async dispatch(event: E): Promise<void> {
    for (const handler of this.handlers) {
      try {
        await handler(event);
      } catch (err) {
        this.onError(err, this.channel);
      }
    }
  }
}

// ── Typed factories — each returns the matching sealed bus interface by structure ──

/**
 * A Redis-backed decision bus (satisfies execution/bus.ts `EventBus`). Admission
 * is BAKED IN (Phase 11C Stage 3): every delivered message passes
 * admitDecisionEvent before any handler runs — callers may add onReject/onError
 * but cannot remove admission (only the decision channel is distributed in
 * production, so this is the one factory that must never trust the wire).
 */
export function createRedisDecisionBus(
  publisher: RedisLike,
  options?: RedisChannelBusOptions<DecisionEvent>,
): PubSubBus<DecisionEvent> {
  return new RedisChannelBus<DecisionEvent>(publisher, BUS_CHANNELS.decision, {
    ...options,
    admit: admitDecisionEvent,
  });
}

/** A Redis-backed execution bus (satisfies execution/execution-bus.ts `ExecutionBus`). */
export function createRedisExecutionBus(
  publisher: RedisLike,
  options?: RedisChannelBusOptions<ExecutionStageEvent>,
): PubSubBus<ExecutionStageEvent> {
  return new RedisChannelBus<ExecutionStageEvent>(
    publisher,
    BUS_CHANNELS.execution,
    options,
  );
}

/** A Redis-backed market bus (satisfies market/market-bus.ts `MarketBus`). */
export function createRedisMarketBus(
  publisher: RedisLike,
  options?: RedisChannelBusOptions<MarketStageEvent>,
): PubSubBus<MarketStageEvent> {
  return new RedisChannelBus<MarketStageEvent>(publisher, BUS_CHANNELS.market, options);
}
