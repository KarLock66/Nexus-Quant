/**
 * Expected-holding-time ESTIMATE. The repository has zero runtime source for holding
 * time (no field, no feature, no model), so this is a deterministic estimate derived
 * purely from the signal's timeframe × a fixed bar horizon, clearly labeled `estimated`
 * — never presented as a prediction.
 */

import type { Timeframe } from "@nexus/core";
import type { DecisionConfig, HoldingTimeView } from "./types.js";

/** Seconds per bar for each timeframe. */
const BAR_SECONDS: Record<Timeframe, number> = {
  M1: 60,
  M5: 300,
  M15: 900,
  H1: 3_600,
  H4: 14_400,
  D1: 86_400,
};

export function estimateHoldingTime(timeframe: Timeframe, cfg: DecisionConfig): HoldingTimeView {
  const bars = cfg.holdingHorizonBars;
  const perBar = BAR_SECONDS[timeframe];
  return {
    seconds: perBar * bars,
    bars,
    provenance: "estimated",
    basis: `${timeframe} bar × ${bars}-bar horizon (no runtime holding-time source — deterministic estimate)`,
  };
}
