/**
 * buildTradingDecision — the deterministic orchestration that assembles one actionable
 * TradingDecision from an admitted EngineSignal (+ its FeatureSnapshot, a freshness-
 * bounded mark, a liquidity observation, and the live risk/control context).
 *
 * Invariants:
 *  - decision / bias / confidence / hashes are carried VERBATIM from the signal (SSoT).
 *  - the clock is INJECTED (inputs.now); no Date.now here → deterministic & replay-safe.
 *  - every added value is provenance-tagged; missing sources fail closed to `unavailable`
 *    (never NaN, never fabricated). `provenanceNotes` lists the honest gaps in THIS row.
 */

import {
  DEFAULT_DECISION_CONFIG,
  type Contributions,
  type DecisionConfig,
  type DecisionInputs,
  type Measure,
  type TradingDecision,
} from "./types.js";
import { computeLevels } from "./entry-stop-target.js";
import { liquidityScore, momentumScore, trendScore, volatilityScore } from "./scores.js";
import { deriveRegime } from "./regime.js";
import { computeSizing } from "./sizing.js";
import { estimateHoldingTime } from "./holding-time.js";
import { buildExplainability } from "./explainability.js";
import { applyRule } from "./signal-rule.js";
import {
  deriveControlStatus,
  deriveExecutionStatus,
  deriveOverallStatus,
  evaluateStaticRisk,
} from "./status.js";
import { ageSeconds, measure, readFeature, round, unavailable } from "./util.js";

export function buildTradingDecision(inputs: DecisionInputs): TradingDecision {
  const cfg: DecisionConfig = { ...DEFAULT_DECISION_CONFIG, ...(inputs.config ?? {}) };
  const { signal, features, now } = inputs;
  const params = signal.strategyParams;

  // 1) Price + ATR-based levels (Section B).
  const atr = readFeature(features, "atr_14");
  const levels = computeLevels(signal.decision, inputs.price, atr, cfg);

  const currentPrice: Measure =
    inputs.price === null
      ? unavailable("no fresh mark (stale >freshness bound or absent)")
      : measure(round(inputs.price.price, cfg.priceDecimals), "real", `mark ${inputs.price.source} @ ${inputs.price.ts}`);

  // 2) Scores (0..100).
  const trend = trendScore(features);
  const momentum = momentumScore(features);
  const volatility = volatilityScore(features, params);
  const liquidity = liquidityScore(inputs.liquidity, cfg);
  const contributions: Contributions = { trend, momentum, volatility, liquidity };

  // 3) Regime + holding time.
  const marketRegime = deriveRegime(features, params);
  const expectedHoldingTime = estimateHoldingTime(inputs.timeframe, cfg);

  // 4) Sizing (assumed equity).
  const sizing = computeSizing(signal.decision, levels.entryPrice.value, levels.stopLoss.value, inputs.risk);

  // 5) Statuses (fail-closed).
  const controlStatus = deriveControlStatus(inputs.control);
  const executionStatus = deriveExecutionStatus(inputs.control, controlStatus);
  const riskStatus = evaluateStaticRisk(signal.decision, sizing.positionNotional.value, inputs.risk);
  // A directional decision is only ACTIONABLE with a complete tradeable level set
  // (entry + ATR-derived stop); an entry mark alone is not enough.
  const levelsComplete = levels.stopLoss.value !== null;
  const overallStatus = deriveOverallStatus(
    signal.decision,
    controlStatus,
    riskStatus.status,
    executionStatus,
    levelsComplete,
  );

  // 6) Explainability (Section C) — uses the sealed-rule mirror for the breakdown.
  const rule = applyRule(features, params);
  const controlApproval =
    controlStatus === "ALLOWED"
      ? "control ALLOWED"
      : controlStatus === "UNKNOWN"
        ? "control state unknown (control plane off or no data)"
        : `control BLOCKED${inputs.control.blockedReasons.length ? `: ${inputs.control.blockedReasons.join("; ")}` : ""}`;
  const explain = buildExplainability({
    features,
    params,
    signal,
    rule,
    contributions,
    price: inputs.price,
    dqScore: inputs.dqScore,
    executionReadiness: `${executionStatus}`,
    riskApproval: `${riskStatus.status}: ${riskStatus.reason}`,
    controlApproval,
  });

  // 7) Honest gap notes.
  const provenanceNotes: string[] = [];
  if (signal.decision === "FLAT") provenanceNotes.push("FLAT signal — no directional entry/stop/targets/size");
  if (inputs.price === null) provenanceNotes.push("current mark unavailable — price-dependent fields not computed");
  if (liquidity.value === null) provenanceNotes.push("liquidity unavailable — no order-book/liquidity snapshot");
  if (marketRegime.provenance === "derived") provenanceNotes.push("market regime is DERIVED (no M8 classifier)");
  provenanceNotes.push("momentum is RSI-only (no MACD/ROC feature exists)");
  if (sizing.positionSize.value !== null) {
    provenanceNotes.push(`position size assumes equity $${round(inputs.risk.assumedEquity, 2)} (no live account)`);
  }
  provenanceNotes.push("expected holding time is a timeframe-based estimate");
  if (riskStatus.staticOnly) provenanceNotes.push("risk status is STATIC (daily-loss/drawdown need a live account)");
  // Always disclose: the control verdict is global per-runtime, not a per-order check —
  // true regardless of READY/WAITING/BLOCKED.
  provenanceNotes.push("execution status is the global control verdict (not per-order)");

  return {
    signalId: signal.id,
    symbol: signal.symbol,
    timeframe: inputs.timeframe,
    direction: signal.decision,
    bias: signal.side,
    confidence: signal.confidence,
    createdAt: signal.createdAt,
    signalAgeSeconds: ageSeconds(now, signal.createdAt) ?? 0,
    featureAgeSeconds: ageSeconds(now, inputs.featureTs),

    currentPrice,
    entryPrice: levels.entryPrice,
    stopLoss: levels.stopLoss,
    takeProfit1: levels.takeProfit1,
    takeProfit2: levels.takeProfit2,
    takeProfit3: levels.takeProfit3,
    riskRewardRatio: levels.riskRewardRatio,
    stopDistancePct: levels.stopDistancePct,

    positionSize: sizing.positionSize,
    positionNotional: sizing.positionNotional,
    capitalRiskPercent: sizing.capitalRiskPercent,
    assumedEquity: round(inputs.risk.assumedEquity, 2),
    expectedHoldingTime,

    trendStrength: trend,
    momentumScore: momentum,
    volatilityScore: volatility,
    liquidityScore: liquidity,

    marketRegime,

    executionStatus,
    riskStatus,
    controlStatus,
    overallStatus,

    explain,
    featureHash: signal.featureHash,
    datasetHash: signal.datasetHash,
    strategyVersionId: signal.strategyVersionId,
    provenanceNotes,
  };
}
