/**
 * StrategyV1 — reference execution strategy (Phase 4).
 *
 * Acts on any confirmed directional observation whose conviction clears a modest
 * floor; stands aside on FLAT. PURE and deterministic, therefore replay-
 * compatible: the same observation always yields the same intent. The observation
 * itself (EngineSignal) is produced upstream by the signal-generation core and is
 * NOT recomputed here — this layer only decides what to DO about it.
 */

import type { Strategy } from "../strategy.js";
import type { DecisionIntent, SignalObservation } from "../types.js";
import { deriveFloorIntent } from "./lib.js";

/** Conviction floor below which a directional edge is held, not acted on. */
export const STRATEGY_V1_CONFIDENCE_FLOOR = 0.1;

export const StrategyV1: Strategy = {
  id: "core-technical",
  version: 1,
  decide(observation: SignalObservation): DecisionIntent {
    return deriveFloorIntent(observation, STRATEGY_V1_CONFIDENCE_FLOOR);
  },
};
