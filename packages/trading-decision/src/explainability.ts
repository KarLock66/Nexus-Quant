/**
 * Section C — deterministic signal explainability. Reconstructs WHY a decision exists
 * from the persisted feature vector + the signal's own strategyParams, using the SAME
 * thresholds as the sealed rule (EMA stack, RSI bands, realized-vol filter). NO LLM
 * reasoning, no fabrication — every factor cites a real feature value. The confidence
 * breakdown mirrors the sealed rule (directional confidence = 0.5·trend + 0.5·rsi).
 */

import type {
  Contributions,
  ConfidenceBreakdown,
  Explainability,
  Factor,
  PriceObservation,
  SignalParams,
  SignalProjection,
} from "./types.js";
import type { RuleResult } from "./signal-rule.js";
import { readFeature, round } from "./util.js";

export interface ExplainArgs {
  features: Record<string, number>;
  params: SignalParams;
  signal: SignalProjection;
  rule: RuleResult | null;
  contributions: Contributions;
  price: PriceObservation | null;
  dqScore: number;
  executionReadiness: string;
  riskApproval: string;
  controlApproval: string;
}

export function buildExplainability(args: ExplainArgs): Explainability {
  const { features, params, signal, rule, contributions, price, dqScore } = args;
  const bullish: Factor[] = [];
  const bearish: Factor[] = [];
  const neutral: Factor[] = [];
  const risk: Factor[] = [];

  const ema20 = readFeature(features, "ema_20");
  const ema50 = readFeature(features, "ema_50");
  const ema200 = readFeature(features, "ema_200");
  const rsi = readFeature(features, "rsi_14");
  const rv = readFeature(features, "realized_vol_30");

  // EMA stack (trend structure).
  if (ema20 !== null && ema50 !== null && ema200 !== null) {
    if (ema20 > ema50 && ema50 > ema200) {
      bullish.push({ label: "Uptrend structure", detail: `EMA20 > EMA50 > EMA200 (${round(ema20, 2)} > ${round(ema50, 2)} > ${round(ema200, 2)})` });
    } else if (ema20 < ema50 && ema50 < ema200) {
      bearish.push({ label: "Downtrend structure", detail: `EMA20 < EMA50 < EMA200 (${round(ema20, 2)} < ${round(ema50, 2)} < ${round(ema200, 2)})` });
    } else {
      neutral.push({ label: "No EMA alignment", detail: `EMAs not stacked (20=${round(ema20, 2)}, 50=${round(ema50, 2)}, 200=${round(ema200, 2)})` });
    }
  } else {
    neutral.push({ label: "Trend structure unavailable", detail: "EMA features missing" });
  }

  // RSI regime confirmation.
  if (rsi !== null) {
    if (rsi >= params.rsiLongMin) {
      bullish.push({ label: "Momentum confirms long", detail: `RSI ${round(rsi, 1)} ≥ ${params.rsiLongMin}` });
    } else if (rsi <= params.rsiShortMax) {
      bearish.push({ label: "Momentum confirms short", detail: `RSI ${round(rsi, 1)} ≤ ${params.rsiShortMax}` });
    } else {
      neutral.push({ label: "Momentum neutral", detail: `RSI ${round(rsi, 1)} between ${params.rsiShortMax}–${params.rsiLongMin}` });
    }
  }

  // Volatility filter (risk).
  if (rv !== null) {
    if (rv > params.maxRealizedVol) {
      risk.push({ label: "Volatility filter active", detail: `realized_vol_30 ${round(rv, 6)} > max ${params.maxRealizedVol} — rule stands aside (decision FLAT)` });
    } else {
      neutral.push({ label: "Volatility within bounds", detail: `realized_vol_30 ${round(rv, 6)} ≤ max ${params.maxRealizedVol}` });
    }
  }

  // Donchian position vs the channel (only when a fresh mark exists).
  const du = readFeature(features, "donchian_upper_20");
  const dl = readFeature(features, "donchian_lower_20");
  if (price !== null && du !== null && dl !== null && du > dl) {
    const pos = (price.price - dl) / (du - dl);
    if (pos >= 0.8) bullish.push({ label: "Near range high", detail: `price at ${round(pos * 100, 0)}% of the 20-bar Donchian channel (breakout zone)` });
    else if (pos <= 0.2) bearish.push({ label: "Near range low", detail: `price at ${round(pos * 100, 0)}% of the 20-bar Donchian channel` });
    else neutral.push({ label: "Mid-range", detail: `price at ${round(pos * 100, 0)}% of the 20-bar Donchian channel` });
  }

  // Data-quality factor.
  if (dqScore < 100) {
    (dqScore < 95 ? risk : neutral).push({ label: "Data quality", detail: `DQ score ${dqScore}/100 on the admitting report` });
  }

  // Confidence breakdown — mirrors the sealed rule's directional 0.5/0.5 blend.
  let breakdown: ConfidenceBreakdown;
  if (rule && (signal.decision === "LONG" || signal.decision === "SHORT")) {
    breakdown = {
      trendComponent: round(0.5 * rule.trendStrength, 4),
      momentumComponent: round(0.5 * rule.rsiConviction, 4),
      total: signal.confidence,
      basis: "directional confidence = 0.5·trendStrength + 0.5·rsiConviction (sealed rule)",
    };
  } else if (rule && rule.volFiltered) {
    breakdown = {
      trendComponent: null,
      momentumComponent: null,
      total: signal.confidence,
      basis: "FLAT-by-volatility: confidence = excess-vol ratio (sealed rule)",
    };
  } else {
    breakdown = {
      trendComponent: null,
      momentumComponent: null,
      total: signal.confidence,
      basis: "no directional edge — confidence 0 (sealed rule)",
    };
  }

  return {
    bullish,
    bearish,
    neutral,
    risk,
    contributions,
    confidenceBreakdown: breakdown,
    executionReadiness: args.executionReadiness,
    riskApproval: args.riskApproval,
    controlApproval: args.controlApproval,
  };
}
