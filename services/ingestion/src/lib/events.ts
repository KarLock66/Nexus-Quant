/**
 * Redis pub/sub event publisher.
 *
 * Wraps every payload in the canonical EventEnvelope from @nexus/events
 * (publishedAt ISO, correlationId crypto.randomUUID()) and publishes it to the
 * Redis channel named after the event.
 *
 * Degradation contract (demo mode may run without Redis):
 *  - redisUrl === null  -> warn once, every publish is a no-op
 *  - connection failure -> warn once, publishes no-op while down
 *  - publish() NEVER throws
 */

import { randomUUID } from "node:crypto";
import { Redis } from "ioredis";
import type { EventEnvelope } from "@nexus/events";
import { log } from "./log.js";

export interface EventPublisher {
  publish(name: string, payload: object): Promise<void>;
  close(): Promise<void>;
}

/**
 * Wire envelope — structurally identical to EventEnvelope with the name/payload
 * types widened (the publisher is generic plumbing; payload contracts are
 * enforced at the call sites that build them).
 */
interface WireEnvelope {
  name: string;
  payload: object;
  publishedAt: string;
  correlationId: string;
}

// Compile-time conformance: every EventEnvelope is a valid WireEnvelope.
const _envelopeConformance = (e: EventEnvelope): WireEnvelope => e;
void _envelopeConformance;

function buildEnvelope(name: string, payload: object): WireEnvelope {
  return {
    name,
    payload,
    publishedAt: new Date().toISOString(),
    correlationId: randomUUID(),
  };
}

export function createPublisher(redisUrl: string | null): EventPublisher {
  let warned = false;
  const warnOnce = (reason: string, extra?: object): void => {
    if (warned) return;
    warned = true;
    log("warn", `event publishing degraded to no-op: ${reason}`, extra);
  };

  if (redisUrl === null) {
    warnOnce("REDIS_URL not configured (demo mode may run without Redis)");
    return {
      publish: async () => undefined,
      close: async () => undefined,
    };
  }

  const client = new Redis(redisUrl, {
    lazyConnect: true,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    retryStrategy: () => 5_000, // keep retrying in the background every 5s
  });
  // An unhandled 'error' event would crash the process — absorb and warn once.
  client.on("error", (err: Error) => {
    warnOnce("redis connection error", { error: err.message });
  });

  return {
    async publish(name: string, payload: object): Promise<void> {
      try {
        const envelope = buildEnvelope(name, payload);
        await client.publish(name, JSON.stringify(envelope));
      } catch (err) {
        warnOnce("publish failed", {
          event: name,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
    async close(): Promise<void> {
      try {
        await client.quit();
      } catch {
        try {
          client.disconnect();
        } catch {
          // already closed — nothing left to release
        }
      }
    },
  };
}
