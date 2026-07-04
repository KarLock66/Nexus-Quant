/**
 * @nexus/trading-plan — Phase 10C-1 Production Actionable Decision Engine.
 *
 * Pure, deterministic, fail-closed core that turns an already-served TradingDecision (the
 * single source of truth) into an actionable TradePlan: a decision-summary action verdict
 * (Should/Can I trade? · Why?), a 10-item execution checklist, a risk checklist, a trade
 * invalidation list, and a documented-weight readiness score. IO-free; imported by the web
 * tier. The decision is consumed VERBATIM — this package never re-decides, it only reshapes
 * the served decision into an actionable view and never fabricates a value.
 */

export * from "./types.js";
export { buildTradePlan } from "./plan.js";
export { buildDecisionSummary } from "./summary.js";
export { buildExecutionChecklist } from "./execution-checklist.js";
export { buildRiskChecklist } from "./risk-checklist.js";
export { buildInvalidation } from "./invalidation.js";
export { buildTradeReadiness } from "./readiness.js";
export { deriveFacts, resolveConfig, type PlanFacts } from "./facts.js";
export { clamp, clamp01, round, mv, triStatus, toRiskTag, type Tri } from "./util.js";
