/**
 * Deterministic market-regime derivation. There is NO M8 regime engine in the runtime
 * (RegimeSnapshot is never written), so the regime is DERIVED from the persisted EMA
 * stack + realized_vol_30 and clearly labeled as such. Only 5 of the 7 canonical states
 * are emitted: PANIC and EUPHORIA require drawdown-velocity / euphoria signals that the
 * core-technical feature set does not compute, so they are NEVER fabricated.
 */

import type { MarketRegime } from "@nexus/core";
import type { RegimeView, SignalParams } from "./types.js";
import { readFeature } from "./util.js";

const NO_M8 =
  "derived from EMA stack + realized_vol_30 (no M8 classifier; PANIC/EUPHORIA need unavailable drawdown/euphoria signals)";

export function deriveRegime(
  features: Record<string, number>,
  params: SignalParams,
): RegimeView {
  const ema20 = readFeature(features, "ema_20");
  const ema50 = readFeature(features, "ema_50");
  const ema200 = readFeature(features, "ema_200");
  const rv = readFeature(features, "realized_vol_30");
  if (ema20 === null || ema50 === null || ema200 === null || rv === null) {
    return { regime: null, provenance: "unavailable", basis: "required features missing — regime not derivable" };
  }

  const maxVol = params.maxRealizedVol > 0 ? params.maxRealizedVol : 0.02;
  const bull = ema20 > ema50 && ema50 > ema200;
  const bear = ema20 < ema50 && ema50 < ema200;

  let regime: MarketRegime;
  if (rv > 2 * maxVol) regime = "HIGH_VOL";
  else if (bull) regime = "TRENDING_BULL";
  else if (bear) regime = "TRENDING_BEAR";
  else if (rv < 0.25 * maxVol) regime = "LOW_VOL";
  else regime = "RANGE_BOUND";

  return { regime, provenance: "derived", basis: NO_M8 };
}
