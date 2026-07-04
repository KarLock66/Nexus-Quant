/**
 * runtime.ts — the runtime context the adapter re-checks at the boundary.
 *
 * The core already fails closed on kill-switch / runtime-unhealthy at CREATION time. The
 * adapter re-asserts those same gates at SUBMISSION time, because a submit can happen strictly
 * later than creation and the world may have changed (a kill switch flipped, the control plane
 * went unhealthy). These are PURE predicates over an already-observed snapshot — the adapter
 * NEVER reads a live clock or polls a service; the caller injects the snapshot + clock.
 */

import type { ExecutionFailureReason } from "@nexus/execution-core";

/**
 * Coarse runtime health as observed by the control plane. Only HEALTHY permits submission;
 * everything else (including UNKNOWN) fails closed.
 */
export type RuntimeState = "HEALTHY" | "DEGRADED" | "UNHEALTHY" | "UNKNOWN";

/**
 * A point-in-time snapshot of the operational gates, injected by the caller. Nothing here is
 * fetched or computed by the adapter — it is relayed from the control plane / kill-switch
 * services the runtime already owns.
 */
export interface RuntimeContext {
  state: RuntimeState;
  killEngaged: boolean;
  /** Injected clock (epoch ms) the snapshot was observed at. */
  clock: number;
}

/** True only when the runtime is fully HEALTHY (fail-closed: any other state is false). */
export function isRuntimeHealthy(ctx: RuntimeContext): boolean {
  return ctx.state === "HEALTHY";
}

/**
 * The first operational gate that blocks execution, or null when the runtime permits it.
 * Kill switch is checked before health (kill is the higher-priority, non-fatal stop, matching
 * the core's own create-time ordering in `createExecution`).
 */
export function runtimeBlockReason(ctx: RuntimeContext): ExecutionFailureReason | null {
  if (ctx.killEngaged) return "KILL_SWITCH";
  if (ctx.state !== "HEALTHY") return "RUNTIME_UNHEALTHY";
  return null;
}
