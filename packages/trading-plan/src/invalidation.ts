/**
 * Section D — buildInvalidation. The deterministic list of conditions that would break
 * THIS trade. Each trigger is ARMED (a watch condition that would invalidate), TRIGGERED
 * (already breached now), or NOT_APPLICABLE (no active directional trade). Every basis
 * cites a live decision value vs its threshold — nothing is fabricated. For a FLAT signal
 * there is no trade to invalidate, so all triggers are NOT_APPLICABLE.
 */

import { deriveFacts, type PlanFacts } from "./facts.js";
import { mv } from "./util.js";
import type {
  Invalidation,
  InvalidationTrigger,
  Provenance,
  TradePlanInputs,
  TradingDecision,
  TriggerState,
} from "./types.js";

export function buildInvalidation(inputs: TradePlanInputs): Invalidation {
  const f: PlanFacts = deriveFacts(inputs);
  const d: TradingDecision = inputs.decision;
  const na = !f.directional;

  const t = (
    id: string,
    label: string,
    description: string,
    state: TriggerState,
    provenance: Provenance,
    basis: string,
  ): InvalidationTrigger => ({
    id,
    label,
    description,
    // FLAT / no trade always collapses to NOT_APPLICABLE regardless of the raw condition.
    state: na ? "NOT_APPLICABLE" : state,
    provenance,
    basis,
  });

  const current = mv(d.currentPrice);

  // stop-loss hit — the most direct invalidation.
  let stopState: TriggerState = "ARMED";
  if (f.stop !== null && current !== null) {
    if (f.isLong && current <= f.stop) stopState = "TRIGGERED";
    else if (f.isShort && current >= f.stop) stopState = "TRIGGERED";
  } else if (f.stop === null) {
    stopState = "NOT_APPLICABLE";
  }
  const stop = t(
    "stop_hit",
    "Stop loss hit",
    "Price closes through the protective stop",
    stopState,
    f.stop === null ? "unavailable" : "derived",
    f.stop === null
      ? "no stop level (no fresh mark / FLAT)"
      : `stop ${f.stop}${current === null ? "" : `, mark ${current}`} (${f.direction})`,
  );

  const signalExpired = t(
    "signal_expired",
    "Signal expired",
    "The EngineSignal ages past its freshness bound",
    f.signalFresh === false ? "TRIGGERED" : f.signalFresh === null ? "ARMED" : "ARMED",
    f.signalAgeSeconds === null ? "unavailable" : "real",
    `signal age ${f.signalAgeSeconds ?? "?"}s vs ≤ ${f.cfg.signalStaleSeconds}s`,
  );

  const featureStale = t(
    "feature_stale",
    "Feature stale",
    "The FeatureSnapshot ages past its freshness bound",
    f.featureFresh === false ? "TRIGGERED" : "ARMED",
    f.featureAgeSeconds === null ? "unavailable" : "real",
    `feature age ${f.featureAgeSeconds ?? "?"}s vs ≤ ${f.cfg.featureStaleSeconds}s`,
  );

  const controlBlocked = t(
    "control_blocked",
    "Control blocked",
    "The control plane blocks trading",
    f.controlStatus === "BLOCKED" ? "TRIGGERED" : "ARMED",
    "verbatim",
    `control status ${f.controlStatus}`,
  );

  const riskDisabled = t(
    "risk_disabled",
    "Risk disabled",
    "The risk engine blocks or disables the order",
    f.riskStatusLabel === "BLOCKED" ? "TRIGGERED" : "ARMED",
    "verbatim",
    `risk status ${f.riskStatusLabel}`,
  );

  const dqDegraded = t(
    "dq_degraded",
    "Data quality degraded",
    "The admitting data-quality score drops below the floor",
    f.dqOk === false ? "TRIGGERED" : "ARMED",
    inputs.dqScore === null ? "unavailable" : "real",
    `DQ ${inputs.dqScore ?? "?"} vs ≥ ${f.cfg.minDqScore}`,
  );

  const momentumReversal = t(
    "momentum_reversal",
    "RSI reversal",
    "Momentum collapses back toward neutral (RSI reversal)",
    f.momentumScoreVal !== null && f.momentumScoreVal < f.cfg.momentumReversalBelow ? "TRIGGERED" : "ARMED",
    d.momentumScore.provenance,
    `momentum ${f.momentumScoreVal ?? "?"} vs < ${f.cfg.momentumReversalBelow} (RSI-only)`,
  );

  const trendLost = t(
    "trend_lost",
    "Trend lost",
    "Trend strength fades / EMA stack flattens (crossover lost)",
    f.trendScore !== null && f.trendScore < f.cfg.trendLostBelow ? "TRIGGERED" : "ARMED",
    d.trendStrength.provenance,
    `trend strength ${f.trendScore ?? "?"} vs < ${f.cfg.trendLostBelow}`,
  );

  const volExpansion = t(
    "vol_expansion",
    "Volatility expansion",
    "Realized volatility expands beyond the acceptable band (ATR expansion)",
    f.volScore !== null && f.volScore > f.cfg.maxVolScore ? "TRIGGERED" : "ARMED",
    d.volatilityScore.provenance,
    `volatility score ${f.volScore ?? "?"} vs > ${f.cfg.maxVolScore}`,
  );

  const triggers: InvalidationTrigger[] = [
    stop,
    signalExpired,
    featureStale,
    controlBlocked,
    riskDisabled,
    dqDegraded,
    momentumReversal,
    trendLost,
    volExpansion,
  ];

  let armed = 0;
  let triggered = 0;
  for (const tr of triggers) {
    if (tr.state === "ARMED") armed++;
    else if (tr.state === "TRIGGERED") triggered++;
  }

  const summary = na
    ? "FLAT — no active directional trade to invalidate"
    : triggered > 0
      ? `${triggered} invalidation condition${triggered > 1 ? "s" : ""} already breached`
      : `${armed} invalidation conditions armed — none breached yet`;

  return { triggers, armed, triggered, summary };
}
