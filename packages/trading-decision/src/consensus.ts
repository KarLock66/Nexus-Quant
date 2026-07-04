/**
 * Section D — multi-timeframe consensus. The runtime ingests a SINGLE timeframe, so
 * consensus is computed ONLY across timeframes that actually have a persisted
 * FeatureSnapshot; timeframes with no data are reported `available:false` ("no data")
 * and excluded from the vote — never fabricated. Per-timeframe direction reuses the
 * sealed-rule mirror (applyRule) since there is no per-timeframe EngineSignal to read.
 */

import type { SignalDecision } from "@nexus/core";
import type {
  Consensus,
  ConsensusTimeframe,
  ConsensusTimeframeInput,
  Measure,
} from "./types.js";
import { applyRule } from "./signal-rule.js";
import { ageSeconds, clamp01, measure, round, unavailable } from "./util.js";

function tfMetrics(
  input: ConsensusTimeframeInput,
  nowMs: number,
): ConsensusTimeframe {
  const na = unavailable("no FeatureSnapshot for this timeframe");
  if (input.features === null) {
    return {
      timeframe: input.timeframe,
      available: false,
      direction: null,
      trend: na,
      momentum: na,
      volatility: na,
      strength: na,
      ageSeconds: null,
      note: "no data",
    };
  }
  const rule = applyRule(input.features, input.params);
  if (rule === null) {
    return {
      timeframe: input.timeframe,
      available: false,
      direction: null,
      trend: unavailable("required features missing"),
      momentum: unavailable("required features missing"),
      volatility: unavailable("required features missing"),
      strength: unavailable("required features missing"),
      ageSeconds: ageSeconds(nowMs, input.ts),
      note: "incomplete features",
    };
  }
  const trend = round(rule.trendStrength * 100, 1);
  const momentum = round(rule.rsiConviction * 100, 1);
  // "Strength" of the timeframe's stance: directional → blend; FLAT → 0.
  const strength =
    rule.decision === "FLAT" ? 0 : round(clamp01(0.5 * rule.trendStrength + 0.5 * rule.rsiConviction) * 100, 1);
  return {
    timeframe: input.timeframe,
    available: true,
    direction: rule.decision,
    trend: measure(trend, "derived", "sealed-rule trendStrength × 100"),
    momentum: measure(momentum, "derived", "sealed-rule rsiConviction × 100"),
    volatility: measure(round((rule.volFiltered ? 1 : 0) * 100, 1), "derived", "vol-filter engaged (100) / clear (0)"),
    strength: measure(strength, "derived", "directional 0.5·trend + 0.5·momentum, ×100 (FLAT → 0)"),
    ageSeconds: ageSeconds(nowMs, input.ts),
    note: rule.volFiltered ? "volatility filter engaged" : "ok",
  };
}

export function computeConsensus(
  symbol: string,
  inputs: ConsensusTimeframeInput[],
  nowMs: number,
): Consensus {
  const timeframes = inputs.map((i) => tfMetrics(i, nowMs));
  const available = timeframes.filter((t) => t.available && t.direction !== null);

  const counts: Record<SignalDecision, number> = { LONG: 0, SHORT: 0, FLAT: 0 };
  for (const t of available) counts[t.direction as SignalDecision] += 1;

  let overall: SignalDecision | null = null;
  if (available.length > 0) {
    // Deterministic tie-break order LONG > SHORT > FLAT.
    const order = ["LONG", "SHORT", "FLAT"] as const;
    overall = order.reduce<SignalDecision>((best, d) => (counts[d] > counts[best] ? d : best), "LONG");
  }

  const agreeing = overall ? available.filter((t) => t.direction === overall) : [];
  const conflicting = overall ? available.filter((t) => t.direction !== overall) : [];
  const alignment: Measure =
    available.length === 0
      ? unavailable("no timeframe has data — alignment not computable")
      : measure(round((agreeing.length / available.length) * 100, 1), "derived", `${agreeing.length}/${available.length} available timeframes agree`);

  const bias =
    available.length === 0
      ? "no data"
      : overall === "FLAT"
        ? `neutral ${counts.FLAT}/${available.length}`
        : overall === "LONG"
          ? `bullish ${counts.LONG}/${available.length}`
          : `bearish ${counts.SHORT}/${available.length}`;

  const missing = timeframes.filter((t) => !t.available).map((t) => t.timeframe);
  const note =
    available.length === 0
      ? "no persisted FeatureSnapshot for any requested timeframe"
      : missing.length > 0
        ? `consensus over ${available.length}/${inputs.length} timeframes — no data for: ${missing.join(", ")}`
        : `consensus over all ${available.length} timeframes`;

  return {
    symbol,
    timeframes,
    overall,
    bias,
    alignmentScore: alignment,
    agreement: agreeing.map((t) => t.timeframe),
    conflict: conflicting.map((t) => t.timeframe),
    availableCount: available.length,
    requestedCount: inputs.length,
    note,
  };
}
