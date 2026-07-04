/**
 * Execution Decision Layer — public module surface (Phase 4).
 *
 * Composition of the three separated layers around the event bus:
 *   observation (signal/) -> decide() -> EventBus.publish() -> persistence sink
 *
 * `createDecisionBus` is the standard wiring: an in-process bus with the
 * persistence subscriber attached. The worker creates one at startup (long-lived
 * seam, decoupled from the tick loop); callers that omit a bus get this wiring
 * per call so existing behavior is preserved with zero configuration.
 */

import { InProcessEventBus } from "./bus.js";
import type { EventBus } from "./bus.js";
import {
  createPersistenceSubscriber,
  type PersistenceSubscriberDeps,
} from "./subscribers/persistence-subscriber.js";

export * from "./types.js";
export * from "./strategy.js";
export * from "./decide.js";
export * from "./bus.js";
// Phase 5 execution layer (pure submodules + the effectful stage).
export * from "./money.js";
export * from "./portfolio.js";
export * from "./risk.js";
export * from "./intent.js";
export * from "./adapters.js";
export * from "./execution-bus.js";
export * from "./stage.js";
export {
  StrategyRegistry,
  defaultStrategyRegistry,
  strategyKey,
  StrategyV1,
  StrategyV2,
} from "./strategies/index.js";
export {
  createPersistenceSubscriber,
  type PersistenceSubscriberDeps,
  type SubscriberLog,
} from "./subscribers/persistence-subscriber.js";

/**
 * Build the standard decision bus: an in-process bus with the persistence sink
 * subscribed. Returns the bus (already wired); callers publish DecisionEvents to
 * it and the observation is persisted idempotently as a side effect.
 */
export function createDecisionBus(deps: PersistenceSubscriberDeps): EventBus {
  const bus = new InProcessEventBus();
  bus.subscribe(createPersistenceSubscriber(deps));
  return bus;
}
