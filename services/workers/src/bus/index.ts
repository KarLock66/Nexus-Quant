/**
 * Distributed bus — public module surface (Phase 7).
 *
 * The Redis and BullMQ bridges that give the Phase 4-6 logical buses a real
 * distributed backbone WITHOUT changing their interfaces:
 *   - in-process (default): the sealed InProcess*Bus classes, unchanged
 *   - redis:    low-latency broadcast (at-most-once, fire-and-forget)
 *   - bullmq:   durable at-least-once delivery with retries
 *
 * Backend selection lives at the worker edge (BUS_BACKEND env); the deterministic
 * test path always uses the in-process default, so no Phase 1-6 test is affected.
 */

export * from "./types.js";
export * from "./admission.js";
export * from "./redis-bus.js";
export * from "./bullmq-bus.js";
