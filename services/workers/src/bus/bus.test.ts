/**
 * Phase 7 — distributed bus bridge verification (in-memory fakes, no live Redis).
 *
 * Proves the Redis and BullMQ bridges satisfy the logical bus shape and behave as
 * specified WITHOUT a running Redis (a fake models pub/sub broadcast and a fake
 * models the durable queue + worker). Also asserts, at compile time, that each
 * typed factory returns the corresponding SEALED interface (EventBus / ExecutionBus
 * / MarketBus) — the interfaces are preserved by structure, not reimplemented.
 */

import { describe, expect, it } from "vitest";
import type { EventBus } from "../execution/bus.js";
import type { ExecutionBus } from "../execution/execution-bus.js";
import type { MarketBus } from "../market/market-bus.js";
import {
  BullMqBus,
  type QueueLike,
  type WorkerFactory,
  type WorkerLike,
  createBullMqDecisionBus,
} from "./bullmq-bus.js";
import {
  RedisChannelBus,
  type RedisLike,
  createRedisDecisionBus,
  createRedisExecutionBus,
  createRedisMarketBus,
} from "./redis-bus.js";

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

// ── Fake Redis pub/sub (a shared hub across duplicated connections) ────────────

class FakeRedisHub {
  readonly connections = new Set<FakeRedis>();
  publish(channel: string, message: string): number {
    let delivered = 0;
    for (const conn of this.connections) {
      if (conn.subscribed.has(channel)) {
        for (const listener of conn.listeners) listener(channel, message);
        delivered += 1;
      }
    }
    return delivered;
  }
}

class FakeRedis implements RedisLike {
  readonly subscribed = new Set<string>();
  readonly listeners: ((channel: string, message: string) => void)[] = [];
  constructor(private readonly hub: FakeRedisHub) {
    hub.connections.add(this);
  }
  async publish(channel: string, message: string): Promise<number> {
    return this.hub.publish(channel, message);
  }
  async subscribe(...channels: string[]): Promise<number> {
    for (const c of channels) this.subscribed.add(c);
    return this.subscribed.size;
  }
  on(_event: "message", listener: (channel: string, message: string) => void): this {
    this.listeners.push(listener);
    return this;
  }
  duplicate(): RedisLike {
    return new FakeRedis(this.hub);
  }
}

// ── Fake BullMQ queue + worker (durable: jobs persist until a worker drains them) ──

class FakeQueue<E> implements QueueLike<E> {
  pending: E[] = [];
  readonly failed: E[] = [];
  private processor: ((data: E) => Promise<void>) | null = null;

  async add(_name: string, data: E): Promise<void> {
    this.pending.push(data);
    await this.drain();
  }
  setProcessor(processor: (data: E) => Promise<void>): void {
    this.processor = processor;
    void this.drain();
  }
  private async drain(): Promise<void> {
    if (this.processor === null) return;
    const batch = this.pending;
    this.pending = [];
    for (const data of batch) {
      try {
        await this.processor(data);
      } catch {
        // A throwing handler does NOT ack — real BullMQ would retry. Record it.
        this.failed.push(data);
      }
    }
  }
}

function bullPair<E>(): { queue: FakeQueue<E>; workerFactory: WorkerFactory<E> } {
  const queue = new FakeQueue<E>();
  const workerFactory: WorkerFactory<E> = (process) => {
    queue.setProcessor(process);
    const worker: WorkerLike = { close: async () => undefined };
    return worker;
  };
  return { queue, workerFactory };
}

interface Payload {
  id: number;
  tag: string;
}

// ── Redis bridge ────────────────────────────────────────────────────────────────

describe("RedisChannelBus — pub/sub broadcast, JSON round-trip, fail-closed dispatch", () => {
  it("delivers a JSON round-tripped event to every subscriber (fan-out)", async () => {
    const hub = new FakeRedisHub();
    const bus = new RedisChannelBus<Payload>(new FakeRedis(hub), "nexus.test");
    const a: Payload[] = [];
    const b: Payload[] = [];
    bus.subscribe((e) => void a.push(e));
    bus.subscribe((e) => void b.push(e));

    await bus.publish({ id: 1, tag: "hello" });
    await flush();

    expect(a).toEqual([{ id: 1, tag: "hello" }]);
    expect(b).toEqual([{ id: 1, tag: "hello" }]);
  });

  it("isolates channels (two buses on one hub never cross-deliver)", async () => {
    const hub = new FakeRedisHub();
    const left = new RedisChannelBus<Payload>(new FakeRedis(hub), "nexus.left");
    const right = new RedisChannelBus<Payload>(new FakeRedis(hub), "nexus.right");
    const onLeft: Payload[] = [];
    left.subscribe((e) => void onLeft.push(e));
    right.subscribe(() => {
      throw new Error("right must not receive a left message");
    });

    await left.publish({ id: 7, tag: "L" });
    await flush();
    expect(onLeft).toEqual([{ id: 7, tag: "L" }]);
  });

  it("routes a throwing handler to onError (fail-closed, never swallowed)", async () => {
    const hub = new FakeRedisHub();
    const errors: unknown[] = [];
    const bus = new RedisChannelBus<Payload>(new FakeRedis(hub), "nexus.err", {
      onError: (err) => void errors.push(err),
    });
    bus.subscribe(() => {
      throw new Error("handler boom");
    });
    await bus.publish({ id: 1, tag: "x" });
    await flush();
    expect(errors.length).toBe(1);
  });

  it("an unsubscribed handler stops receiving", async () => {
    const hub = new FakeRedisHub();
    const bus = new RedisChannelBus<Payload>(new FakeRedis(hub), "nexus.unsub");
    const got: Payload[] = [];
    const off = bus.subscribe((e) => void got.push(e));
    await bus.publish({ id: 1, tag: "a" });
    await flush();
    off();
    await bus.publish({ id: 2, tag: "b" });
    await flush();
    expect(got).toEqual([{ id: 1, tag: "a" }]);
  });

  it("typed factories return the sealed bus interfaces (structural conformance)", () => {
    const hub = new FakeRedisHub();
    const pub = new FakeRedis(hub);
    const decision: EventBus = createRedisDecisionBus(pub);
    const execution: ExecutionBus = createRedisExecutionBus(pub);
    const market: MarketBus = createRedisMarketBus(pub);
    expect(typeof decision.publish).toBe("function");
    expect(typeof execution.subscribe).toBe("function");
    expect(typeof market.publish).toBe("function");
  });
});

// ── BullMQ bridge ───────────────────────────────────────────────────────────────

describe("BullMqBus — durable enqueue, at-least-once delivery, fan-out", () => {
  it("enqueues durably and delivers once a worker subscribes (publish-before-subscribe)", async () => {
    const { queue, workerFactory } = bullPair<Payload>();
    const bus = new BullMqBus<Payload>(queue, "nexus.test", workerFactory);

    // Publish BEFORE any subscriber: the job is durably enqueued, not lost.
    await bus.publish({ id: 1, tag: "queued" });
    expect(queue.pending.length).toBe(1);

    const got: Payload[] = [];
    bus.subscribe((e) => void got.push(e)); // worker created -> drains the backlog
    await flush();
    expect(got).toEqual([{ id: 1, tag: "queued" }]);
    expect(queue.pending.length).toBe(0);
  });

  it("does NOT ack a throwing handler (retry semantics, not silent loss)", async () => {
    const { queue, workerFactory } = bullPair<Payload>();
    const bus = new BullMqBus<Payload>(queue, "nexus.retry", workerFactory);
    bus.subscribe(() => {
      throw new Error("handler boom");
    });
    await bus.publish({ id: 9, tag: "boom" });
    await flush();
    expect(queue.failed).toEqual([{ id: 9, tag: "boom" }]);
  });

  it("fans out to every subscriber", async () => {
    const { queue, workerFactory } = bullPair<Payload>();
    const bus = new BullMqBus<Payload>(queue, "nexus.fan", workerFactory);
    const a: Payload[] = [];
    const b: Payload[] = [];
    bus.subscribe((e) => void a.push(e));
    bus.subscribe((e) => void b.push(e));
    await bus.publish({ id: 2, tag: "fan" });
    await flush();
    expect(a).toEqual([{ id: 2, tag: "fan" }]);
    expect(b).toEqual([{ id: 2, tag: "fan" }]);
  });

  it("typed factory returns the sealed EventBus interface (structural conformance)", () => {
    const { queue, workerFactory } = bullPair<import("../execution/types.js").DecisionEvent>();
    const decision: EventBus = createBullMqDecisionBus(queue, workerFactory);
    expect(typeof decision.publish).toBe("function");
    expect(typeof decision.subscribe).toBe("function");
  });
});
