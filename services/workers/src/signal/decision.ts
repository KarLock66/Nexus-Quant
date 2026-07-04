/**
 * core-technical v1 Signal decision rule (STEP 16).
 *
 * A PURE, deterministic mapping from PERSISTED feature values to a decision.
 * No IO, no Date, no randomness, no fetch. The SAME function is used by the
 * Signal Engine (generation) and by the Replay Engine (reconstruction), so
 * generation and replay can never drift.
 *
 * Pipeline:
 *   1. trend bias (`side`)  — EMA stack: bull if ema_20>ema_50>ema_200,
 *                             bear if ema_20<ema_50<ema_200, else FLAT.
 *   2. RSI regime           — a directional bias only fires when RSI confirms
 *                             (>= rsiLongMin for LONG, <= rsiShortMax for SHORT).
 *   3. volatility filter     — realized_vol_30 above maxRealizedVol forces the
 *                             final `decision` to FLAT regardless of bias.
 * `confidence` is a deterministic 0..1 conviction quantized to 4 decimals.
 */

import type { SignalDecision } from "@nexus/core";

export interface SignalParams {
  rsiLongMin: number;
  rsiShortMax: number;
  maxRealizedVol: number;
}

export const DEFAULT_SIGNAL_PARAMS: SignalParams = {
  rsiLongMin: 55,
  rsiShortMax: 45,
  maxRealizedVol: 0.02,
};

export interface SignalDecisionResult {
  /** Trend bias before the volatility filter. */
  side: SignalDecision;
  /** Final verdict after the volatility filter. */
  decision: SignalDecision;
  /** Conviction in `decision`, 0..1. */
  confidence: number;
}

/** Raised when a required feature is absent/non-finite (fail-closed). */
export class SignalInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SignalInputError";
  }
}

function num(raw: unknown, fallback: number): number {
  return typeof raw === "number" && Number.isFinite(raw) ? raw : fallback;
}

export function resolveSignalParams(parameters: Record<string, unknown>): SignalParams {
  return {
    rsiLongMin: num(parameters["rsiLongMin"], DEFAULT_SIGNAL_PARAMS.rsiLongMin),
    rsiShortMax: num(parameters["rsiShortMax"], DEFAULT_SIGNAL_PARAMS.rsiShortMax),
    maxRealizedVol: num(
      parameters["maxRealizedVol"],
      DEFAULT_SIGNAL_PARAMS.maxRealizedVol,
    ),
  };
}

function clamp01(x: number): number {
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

function feature(features: Record<string, number>, key: string): number {
  const v = features[key];
  if (typeof v !== "number" || !Number.isFinite(v)) {
    throw new SignalInputError(`feature ${key} missing or non-finite (fail-closed)`);
  }
  return v;
}

/** Quantize confidence to a stable 4-decimal string (byte-identical at rest). */
export function quantizeConfidence(x: number): string {
  const c = clamp01(x);
  // -0 normalizes to 0; toFixed(4) is deterministic across platforms.
  return (c === 0 ? 0 : c).toFixed(4);
}

export function decideSignal(
  features: Record<string, number>,
  params: SignalParams = DEFAULT_SIGNAL_PARAMS,
): SignalDecisionResult {
  const ema20 = feature(features, "ema_20");
  const ema50 = feature(features, "ema_50");
  const ema200 = feature(features, "ema_200");
  const rsi = feature(features, "rsi_14");
  const realizedVol = feature(features, "realized_vol_30");

  const bull = ema20 > ema50 && ema50 > ema200;
  const bear = ema20 < ema50 && ema50 < ema200;
  const side: SignalDecision = bull ? "LONG" : bear ? "SHORT" : "FLAT";

  // RSI regime confirmation of the trend bias.
  let directional: SignalDecision = "FLAT";
  if (bull && rsi >= params.rsiLongMin) directional = "LONG";
  else if (bear && rsi <= params.rsiShortMax) directional = "SHORT";

  // Volatility filter dominates: too much realized vol -> stand aside.
  const volFiltered = realizedVol > params.maxRealizedVol;
  const decision: SignalDecision = volFiltered ? "FLAT" : directional;

  // Deterministic conviction.
  const trendStrength = clamp01(Math.abs(ema20 - ema200) / Math.abs(ema200));
  const rsiConviction = clamp01(Math.abs(rsi - 50) / 50);
  let confidence: number;
  if (decision === "LONG" || decision === "SHORT") {
    confidence = clamp01(0.5 * trendStrength + 0.5 * rsiConviction);
  } else if (volFiltered) {
    // Conviction that conditions are too volatile to act.
    confidence = clamp01((realizedVol - params.maxRealizedVol) / params.maxRealizedVol);
  } else {
    // Genuinely no directional edge.
    confidence = 0;
  }

  return { side, decision, confidence };
}
