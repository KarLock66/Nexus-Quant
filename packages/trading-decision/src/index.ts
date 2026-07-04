/**
 * @nexus/trading-decision — Phase 10A-1 Production Trading Decision Engine.
 *
 * Pure, deterministic, fail-closed core that converts an admitted EngineSignal into an
 * actionable TradingDecision (entry/stop/targets, R:R, 0..100 scores, derived regime,
 * explainability, position size) plus multi-timeframe consensus and opportunity ranking.
 * IO-free; imported by the web tier. The signal decision/side/confidence are carried
 * VERBATIM — this package never re-decides, it only derives the actionable view.
 */

export * from "./types.js";
export { buildTradingDecision } from "./decision.js";
export { computeLevels } from "./entry-stop-target.js";
export { trendScore, momentumScore, volatilityScore, liquidityScore } from "./scores.js";
export { deriveRegime } from "./regime.js";
export { computeSizing } from "./sizing.js";
export { estimateHoldingTime } from "./holding-time.js";
export { buildExplainability } from "./explainability.js";
export { computeConsensus } from "./consensus.js";
export { rankOpportunities } from "./ranking.js";
export { applyRule, type RuleResult } from "./signal-rule.js";
export {
  deriveControlStatus,
  deriveExecutionStatus,
  evaluateStaticRisk,
  deriveOverallStatus,
} from "./status.js";
export {
  clamp01,
  clampScore,
  round,
  readFeature,
  measure,
  unavailable,
  ageSeconds,
  resolveSignalParams,
} from "./util.js";
