/**
 * factory.ts — adapter + session construction.
 *
 * `createAdapter` chooses between the NULL and PAPER adapters from runtime config. It is
 * OPT-IN / DEFAULT-OFF (mirroring the project's extension discipline): the PAPER adapter is
 * returned ONLY when config explicitly selects kind="PAPER" AND enabled=true; anything else —
 * missing config, enabled=false, an unknown/LIVE kind — falls back to the fail-closed NULL
 * adapter. No broker/LIVE adapter exists in the foundation.
 *
 * `createSession` binds a sealed-core {@link ExecutionState} into a fresh, replay-safe
 * {@link AdapterSession}. It fabricates nothing — mode/venue are read from the core state (or
 * an explicit override) and the clock is injected.
 */

import { NullExecutionAdapter } from "./null.js";
import { PaperExecutionAdapter } from "./paper.js";
import type { ExecutionAdapter } from "./adapter.js";
import type {
  AdapterHealthStatus,
  AdapterKind,
  AdapterSession,
  ExecutionMode,
  ExecutionState,
  ExecutionVenue,
} from "./types.js";

/** Runtime configuration for adapter selection. Absent / disabled ⇒ NULL (fail-closed). */
export interface AdapterConfig {
  kind?: AdapterKind;
  /** Opt-in switch. PAPER is selected ONLY when this is true. Default-off. */
  enabled?: boolean;
  mode?: ExecutionMode;
  venue?: ExecutionVenue;
}

/**
 * Select an adapter. PAPER requires an explicit, enabled opt-in; every other configuration
 * (including LIVE, which has no implementation) falls back to the fail-closed NULL adapter.
 */
export function createAdapter(config: AdapterConfig = {}): ExecutionAdapter {
  if (config.kind === "PAPER" && config.enabled === true) return PaperExecutionAdapter;
  return NullExecutionAdapter;
}

const HEALTH_FOR_KIND: Readonly<Record<AdapterKind, AdapterHealthStatus>> = {
  PAPER: "READY",
  NULL: "UNAVAILABLE",
  LIVE: "UNAVAILABLE",
};

export interface CreateSessionOptions {
  /** Injected clock (epoch ms). Defaults to the core state's createdAt. */
  now?: number;
  mode?: ExecutionMode;
  venue?: ExecutionVenue;
}

/**
 * Build a fresh session bound to a sealed-core execution. The session is the ONLY place adapter
 * state lives; it starts un-submitted with an empty event log and seq 0.
 */
export function createSession(
  adapter: ExecutionAdapter,
  core: ExecutionState,
  opts: CreateSessionOptions = {},
): AdapterSession {
  const now = opts.now ?? core.createdAt;
  return {
    adapter: adapter.kind,
    mode: opts.mode ?? core.mode,
    venue: opts.venue ?? core.venue,
    status: HEALTH_FOR_KIND[adapter.kind],
    intentId: core.intentId,
    core,
    events: [],
    seq: 0,
    submitted: false,
    createdAt: now,
    updatedAt: now,
    clock: now,
  };
}

/** Build an empty, unbound session (no core execution) — e.g. for a null-adapter health probe. */
export function createEmptySession(adapter: ExecutionAdapter, now: number, opts: CreateSessionOptions = {}): AdapterSession {
  return {
    adapter: adapter.kind,
    mode: opts.mode ?? "SIMULATION",
    venue: opts.venue ?? "UNSET",
    status: HEALTH_FOR_KIND[adapter.kind],
    intentId: null,
    core: null,
    events: [],
    seq: 0,
    submitted: false,
    createdAt: now,
    updatedAt: now,
    clock: now,
  };
}
