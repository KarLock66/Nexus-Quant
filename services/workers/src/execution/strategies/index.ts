/**
 * Strategy registry (Phase 4).
 *
 * Maps a resolution key (typically the observation's strategyVersionId) to the
 * execution Strategy that should decide on it, with a deterministic DEFAULT so
 * resolution never fails closed-loop. Resolution is PURE — it reads no clock and
 * mutates nothing on lookup — so which strategy decided an observation is itself
 * a reproducible function of the registry's (versioned) configuration.
 */

import type { Strategy } from "../strategy.js";
import { StrategyV1 } from "./strategy-v1.js";
import { StrategyV2 } from "./strategy-v2.js";

/** Canonical identity of a strategy version: `<id>@v<version>`. */
export function strategyKey(s: Strategy): string {
  return `${s.id}@v${s.version}`;
}

export class StrategyRegistry {
  private readonly byKey = new Map<string, Strategy>();

  constructor(private readonly fallback: Strategy) {}

  /** Register `strategy` under one or more resolution keys (idempotent overwrite). */
  register(strategy: Strategy, keys: string[]): this {
    for (const k of keys) this.byKey.set(k, strategy);
    return this;
  }

  /** The strategy to use for `key`, or the registry default when unmapped. */
  resolve(key?: string): Strategy {
    if (key !== undefined) {
      const hit = this.byKey.get(key);
      if (hit !== undefined) return hit;
    }
    return this.fallback;
  }

  /** The default strategy used when a key is unmapped. */
  get default(): Strategy {
    return this.fallback;
  }
}

/**
 * Process-wide default registry. StrategyV1 is the default; both versions are
 * registered under their canonical keys so a caller can pin a specific version.
 * Demo/unmapped strategyVersionIds resolve to V1 (the default) with no coupling
 * to any specific lineage id.
 */
export const defaultStrategyRegistry = new StrategyRegistry(StrategyV1)
  .register(StrategyV1, [strategyKey(StrategyV1)])
  .register(StrategyV2, [strategyKey(StrategyV2)]);

export { StrategyV1, StrategyV2 };
