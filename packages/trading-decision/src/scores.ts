/**
 * Deterministic 0..100 factor scores derived from REAL persisted features (+ a real
 * order-book liquidity observation). Each score is fail-closed: a missing input yields
 * an `unavailable` Measure, never a fabricated number. Honesty labels are baked into
 * each basis string (e.g. momentum is RSI-only; no MACD/ROC feature exists).
 */

import type {
  DecisionConfig,
  LiquidityObservation,
  Measure,
  SignalParams,
} from "./types.js";
import { clamp01, clampScore, measure, readFeature, round, unavailable } from "./util.js";

/** Trend strength 0..100 — the sealed rule's trendStrength × 100 (EMA20 vs EMA200). */
export function trendScore(features: Record<string, number>): Measure {
  const ema20 = readFeature(features, "ema_20");
  const ema200 = readFeature(features, "ema_200");
  if (ema20 === null || ema200 === null || ema200 === 0) {
    return unavailable("ema_20/ema_200 unavailable — trend strength not computable");
  }
  const s = clamp01(Math.abs(ema20 - ema200) / Math.abs(ema200)) * 100;
  return measure(round(s, 1), "derived", "clamp01(|ema_20−ema_200|/|ema_200|) × 100 (sealed-rule trendStrength)");
}

/** Momentum 0..100 — RSI distance from 50 (RSI-only; no MACD/ROC feature is computed). */
export function momentumScore(features: Record<string, number>): Measure {
  const rsi = readFeature(features, "rsi_14");
  if (rsi === null) return unavailable("rsi_14 unavailable — momentum not computable");
  const s = clamp01(Math.abs(rsi - 50) / 50) * 100;
  return measure(round(s, 1), "derived", "clamp01(|rsi_14−50|/50) × 100 — RSI-only (no MACD/ROC feature)");
}

/** Volatility 0..100 — realized_vol_30 normalized against the strategy's maxRealizedVol. */
export function volatilityScore(
  features: Record<string, number>,
  params: SignalParams,
): Measure {
  const rv = readFeature(features, "realized_vol_30");
  if (rv === null) return unavailable("realized_vol_30 unavailable — volatility not computable");
  const ceiling = params.maxRealizedVol > 0 ? 2 * params.maxRealizedVol : 0.04;
  const s = clamp01(rv / ceiling) * 100;
  return measure(
    round(s, 1),
    "derived",
    `clamp01(realized_vol_30/${round(ceiling, 6)}) × 100 (normalized vs 2× strategy maxRealizedVol)`,
  );
}

/**
 * Liquidity 0..100 from a REAL order-book observation (tighter spread + deeper USD =
 * higher). Unavailable when no order-book/liquidity snapshot exists (demo-only / no
 * live ingestion) — volume_zscore is NOT liquidity, so it is never substituted.
 */
export function liquidityScore(
  liq: LiquidityObservation | null,
  cfg: DecisionConfig,
): Measure {
  if (liq === null || (liq.spreadBps === null && liq.depthUsd === null)) {
    return unavailable("no order-book/liquidity snapshot — liquidity not computable");
  }
  const parts: number[] = [];
  const bits: string[] = [];
  if (liq.spreadBps !== null) {
    const spreadScore = clamp01(1 - liq.spreadBps / cfg.refSpreadBps);
    parts.push(spreadScore);
    bits.push(`spread ${round(liq.spreadBps, 2)}bps`);
  }
  if (liq.depthUsd !== null) {
    const depthScore = clamp01(liq.depthUsd / cfg.refDepthUsd);
    parts.push(depthScore);
    bits.push(`depth $${round(liq.depthUsd, 0)}`);
  }
  const avg = parts.reduce((a, b) => a + b, 0) / parts.length;
  return measure(
    round(clampScore(avg * 100), 1),
    "derived",
    `from ${bits.join(" + ")} (refSpread ${cfg.refSpreadBps}bps, refDepth $${cfg.refDepthUsd})`,
  );
}
