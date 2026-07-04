/**
 * Strategy abstraction (Phase 4).
 *
 * A Strategy is a VERSIONED, PURE decision unit: given a market observation it
 * returns an action intent and nothing else — no IO, no clock, no randomness, no
 * network. Purity is what makes a strategy REPLAY-COMPATIBLE: the same
 * (observation, params) reproduce the same intent forever, so a recorded decision
 * can be reconstructed from the persisted observation + the strategy code alone.
 *
 * Versioning is explicit (`id` + `version`): StrategyV1, StrategyV2, … coexist;
 * a new version is a new module, never an in-place edit of an existing one (so
 * historical decisions remain reproducible against the version that made them).
 */

import type { DecisionIntent, SignalObservation } from "./types.js";

/** Read-only context a strategy may consult (kept minimal and side-effect free). */
export interface StrategyContext {
  /** Correlation id of the producing tick, when available. */
  tickId?: string;
}

export interface Strategy {
  /** Logical strategy identity (stable across versions of the same idea). */
  readonly id: string;
  /** Monotonic version of this strategy (1, 2, …). */
  readonly version: number;
  /**
   * Pure observation -> action intent. MUST be deterministic and side-effect
   * free. Implementations carry `side`/`confidence` through verbatim so the
   * intent never silently disagrees with the audited observation.
   */
  decide(observation: SignalObservation, ctx: StrategyContext): DecisionIntent;
}
