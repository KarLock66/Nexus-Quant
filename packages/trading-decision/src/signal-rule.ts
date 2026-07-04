/**
 * Deterministic mirror of the SEALED core-technical v1 decision rule
 * (`services/workers/src/signal/decision.ts`). That module lives in `@nexus/workers`,
 * which has no package exports, so the rule cannot be imported — it is mirrored here
 * VERBATIM and pinned to the sealed behavior by the fixture equivalence test
 * (`signal-rule.test.ts`), which runs it over the real quant-generated vectors in
 * `services/workers/src/__fixtures__/decision-vectors.json`.
 *
 * IMPORTANT: this mirror is used ONLY where there is no persisted EngineSignal to read
 * from — i.e. per-timeframe consensus (one direction per timeframe) and explainability
 * factor extraction. The PRIMARY TradingDecision always carries the EngineSignal's
 * decision/side/confidence VERBATIM and never calls this. Single source of truth intact.
 */

import type { SignalDecision } from "@nexus/core";
import type { SignalParams } from "./types.js";
import { clamp01, readFeature } from "./util.js";

export interface RuleResult {
  side: SignalDecision;
  decision: SignalDecision;
  confidence: number;
  /** Whether the realized-vol filter forced the decision to FLAT. */
  volFiltered: boolean;
  /** Confidence component: clamp01(|ema_20 - ema_200| / |ema_200|). */
  trendStrength: number;
  /** Confidence component: clamp01(|rsi_14 - 50| / 50). */
  rsiConviction: number;
}

/**
 * Re-derive {side, decision, confidence} from a persisted feature vector + params,
 * identical to the sealed rule. Returns null (fail-closed) when a required feature is
 * missing/non-finite — exactly the inputs the sealed `feature()` would throw on.
 */
export function applyRule(
  features: Record<string, number>,
  params: SignalParams,
): RuleResult | null {
  const ema20 = readFeature(features, "ema_20");
  const ema50 = readFeature(features, "ema_50");
  const ema200 = readFeature(features, "ema_200");
  const rsi = readFeature(features, "rsi_14");
  const realizedVol = readFeature(features, "realized_vol_30");
  if (ema20 === null || ema50 === null || ema200 === null || rsi === null || realizedVol === null) {
    return null;
  }

  const bull = ema20 > ema50 && ema50 > ema200;
  const bear = ema20 < ema50 && ema50 < ema200;
  const side: SignalDecision = bull ? "LONG" : bear ? "SHORT" : "FLAT";

  let directional: SignalDecision = "FLAT";
  if (bull && rsi >= params.rsiLongMin) directional = "LONG";
  else if (bear && rsi <= params.rsiShortMax) directional = "SHORT";

  const volFiltered = realizedVol > params.maxRealizedVol;
  const decision: SignalDecision = volFiltered ? "FLAT" : directional;

  const trendStrength = clamp01(Math.abs(ema20 - ema200) / Math.abs(ema200));
  const rsiConviction = clamp01(Math.abs(rsi - 50) / 50);

  let confidence: number;
  if (decision === "LONG" || decision === "SHORT") {
    confidence = clamp01(0.5 * trendStrength + 0.5 * rsiConviction);
  } else if (volFiltered) {
    confidence = clamp01((realizedVol - params.maxRealizedVol) / params.maxRealizedVol);
  } else {
    confidence = 0;
  }

  return { side, decision, confidence, volFiltered, trendStrength, rsiConviction };
}
