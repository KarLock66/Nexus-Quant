/**
 * Section B — deterministic Entry / Stop / Target engine.
 *
 * Levels are derived from the current mark (entry) ± ATR multiples of the REAL
 * persisted `atr_14` feature (Wilder ATR in price units). Direction-aware: a LONG
 * stops below and targets above; a SHORT mirrors. FAIL-CLOSED: no fresh price, no
 * atr_14, or a non-directional (FLAT) signal yields `unavailable` levels — never a
 * fabricated price. No clock, no randomness.
 */

import type { DecisionConfig, Measure, PriceObservation, SignalDecision } from "./types.js";
import { measure, round, unavailable } from "./util.js";

export interface Levels {
  entryPrice: Measure;
  stopLoss: Measure;
  takeProfit1: Measure;
  takeProfit2: Measure;
  takeProfit3: Measure;
  riskRewardRatio: Measure;
  stopDistancePct: Measure;
}

function allUnavailable(reason: string): Levels {
  return {
    entryPrice: unavailable(reason),
    stopLoss: unavailable(reason),
    takeProfit1: unavailable(reason),
    takeProfit2: unavailable(reason),
    takeProfit3: unavailable(reason),
    riskRewardRatio: unavailable(reason),
    stopDistancePct: unavailable(reason),
  };
}

export function computeLevels(
  direction: SignalDecision,
  price: PriceObservation | null,
  atr: number | null,
  cfg: DecisionConfig,
): Levels {
  if (direction === "FLAT") {
    return allUnavailable("FLAT signal — no directional entry/stop/target");
  }
  if (price === null) {
    return allUnavailable("no fresh mark — entry/stop/target not computable");
  }

  const dp = cfg.priceDecimals;
  const entry = price.price;
  // Entry = the current mark; it is available whenever a fresh price exists, even
  // when ATR is missing (only the ATR-derived stop/targets then go unavailable).
  const entryMeasure = measure(round(entry, dp), "real", `current mark ${price.source} @ ${price.ts}`);
  if (atr === null || atr <= 0) {
    const reason = "atr_14 unavailable or non-positive — ATR-based stop/targets not computable";
    return {
      entryPrice: entryMeasure,
      stopLoss: unavailable(reason),
      takeProfit1: unavailable(reason),
      takeProfit2: unavailable(reason),
      takeProfit3: unavailable(reason),
      riskRewardRatio: unavailable(reason),
      stopDistancePct: unavailable(reason),
    };
  }

  const long = direction === "LONG";
  const sign = long ? 1 : -1;

  const stop = entry - sign * cfg.atrStopMult * atr;
  const tp1 = entry + sign * cfg.atrTp1Mult * atr;
  const tp2 = entry + sign * cfg.atrTp2Mult * atr;
  const tp3 = entry + sign * cfg.atrTp3Mult * atr;

  const risk = Math.abs(entry - stop);
  const reward1 = Math.abs(tp1 - entry);
  const rr = risk > 0 ? reward1 / risk : 0;
  const stopPct = entry > 0 ? (risk / entry) * 100 : 0;

  const lvlBasis = `entry ${long ? "−/+" : "+/−"} ATR(atr_14=${round(atr, dp)})×{${cfg.atrStopMult},${cfg.atrTp1Mult},${cfg.atrTp2Mult},${cfg.atrTp3Mult}}`;

  return {
    entryPrice: entryMeasure,
    stopLoss: measure(round(stop, dp), "derived", lvlBasis),
    takeProfit1: measure(round(tp1, dp), "derived", lvlBasis),
    takeProfit2: measure(round(tp2, dp), "derived", lvlBasis),
    takeProfit3: measure(round(tp3, dp), "derived", lvlBasis),
    riskRewardRatio: measure(round(rr, 2), "derived", `reward1/risk = ${round(reward1, dp)}/${round(risk, dp)}`),
    stopDistancePct: measure(round(stopPct, 2), "derived", `|entry−stop|/entry × 100`),
  };
}
