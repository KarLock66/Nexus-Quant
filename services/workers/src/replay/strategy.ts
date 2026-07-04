/**
 * core-technical v1 decision rule (STEP 11).
 *
 * A deterministic, side-effect-free mapping from PERSISTED feature values to a
 * SignalState. This is the decision logic replay reproduces; it reads only the
 * feature vector (never market data, never the hash) so the same persisted
 * snapshot + the same strategy parameters always yield the same state.
 *
 * Rule (frozen for v1):
 *   trend = bull  if ema_20 > ema_50 > ema_200
 *           bear  if ema_20 < ema_50 < ema_200
 *           flat  otherwise
 *   STRONG_BUY  if bull and rsi_14 >= rsiStrongBuy
 *   BUY         if bull and rsi_14 >= rsiBuy
 *   STRONG_SELL if bear and rsi_14 <= rsiStrongSell
 *   SELL        if bear and rsi_14 <= rsiSell
 *   NEUTRAL     otherwise
 */

import type { SignalState } from "@nexus/core";

export interface StrategyParams {
  rsiStrongBuy: number;
  rsiBuy: number;
  rsiSell: number;
  rsiStrongSell: number;
}

export const DEFAULT_STRATEGY_PARAMS: StrategyParams = {
  rsiStrongBuy: 70,
  rsiBuy: 55,
  rsiSell: 45,
  rsiStrongSell: 30,
};

/** Raised when a required feature is absent or non-finite (fail-closed). */
export class StrategyInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StrategyInputError";
  }
}

function num(raw: unknown, fallback: number): number {
  return typeof raw === "number" && Number.isFinite(raw) ? raw : fallback;
}

/** Resolve params from a StrategyVersion.parameters JSON, with v1 defaults. */
export function resolveParams(parameters: Record<string, unknown>): StrategyParams {
  return {
    rsiStrongBuy: num(parameters["rsiStrongBuy"], DEFAULT_STRATEGY_PARAMS.rsiStrongBuy),
    rsiBuy: num(parameters["rsiBuy"], DEFAULT_STRATEGY_PARAMS.rsiBuy),
    rsiSell: num(parameters["rsiSell"], DEFAULT_STRATEGY_PARAMS.rsiSell),
    rsiStrongSell: num(
      parameters["rsiStrongSell"],
      DEFAULT_STRATEGY_PARAMS.rsiStrongSell,
    ),
  };
}

function feature(features: Record<string, number>, key: string): number {
  const v = features[key];
  if (typeof v !== "number" || !Number.isFinite(v)) {
    throw new StrategyInputError(`feature ${key} missing or non-finite (fail-closed)`);
  }
  return v;
}

export function evaluateCoreTechnical(
  features: Record<string, number>,
  params: StrategyParams = DEFAULT_STRATEGY_PARAMS,
): SignalState {
  const ema20 = feature(features, "ema_20");
  const ema50 = feature(features, "ema_50");
  const ema200 = feature(features, "ema_200");
  const rsi = feature(features, "rsi_14");

  const bull = ema20 > ema50 && ema50 > ema200;
  const bear = ema20 < ema50 && ema50 < ema200;

  if (bull) {
    if (rsi >= params.rsiStrongBuy) return "STRONG_BUY";
    if (rsi >= params.rsiBuy) return "BUY";
    return "NEUTRAL";
  }
  if (bear) {
    if (rsi <= params.rsiStrongSell) return "STRONG_SELL";
    if (rsi <= params.rsiSell) return "SELL";
    return "NEUTRAL";
  }
  return "NEUTRAL";
}
