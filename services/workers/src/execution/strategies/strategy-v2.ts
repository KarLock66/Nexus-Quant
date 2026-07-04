/**
 * StrategyV2 — conservative execution strategy (Phase 4).
 *
 * Same logical idea as V1 ("act on confirmed directional edges") but a STRICTER
 * conviction floor, so it acts only on higher-conviction observations and holds
 * the rest. Exists to demonstrate the versioning system: V1 and V2 coexist and
 * can derive DIFFERENT intents from the SAME observation, each reproducibly,
 * without either touching the other's code (replay against the version that
 * actually decided stays exact).
 */

import type { Strategy } from "../strategy.js";
import type { DecisionIntent, SignalObservation } from "../types.js";
import { deriveFloorIntent } from "./lib.js";

/** Stricter than V1: only high-conviction directional edges are acted on. */
export const STRATEGY_V2_CONFIDENCE_FLOOR = 0.25;

export const StrategyV2: Strategy = {
  id: "core-technical",
  version: 2,
  decide(observation: SignalObservation): DecisionIntent {
    return deriveFloorIntent(observation, STRATEGY_V2_CONFIDENCE_FLOOR);
  },
};
