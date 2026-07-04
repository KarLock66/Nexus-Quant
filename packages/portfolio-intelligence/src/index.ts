/**
 * @nexus/portfolio-intelligence — Phase 10C-2A Production Portfolio Intelligence Engine.
 *
 * Pure, deterministic, fail-closed core that aggregates a set of already-served
 * TradingDecision + TradePlan outputs (the single source of truth) into a complete portfolio
 * state: summary, exposure, capital allocation, risk heat, health, warnings and statistics.
 * IO-free, clock-injected, replay-safe; imported by the web tier. The decision/plan are
 * consumed VERBATIM — this package never re-decides or recomputes signal logic, confidence,
 * entries, targets or readiness; it only derives the portfolio view and never fabricates a
 * value.
 */

export * from "./types.js";
export { buildPortfolioState } from "./portfolio.js";
export { buildPortfolioSummary } from "./summary.js";
export { buildPortfolioExposure } from "./exposure.js";
export { buildCapitalAllocation } from "./allocation.js";
export { buildRiskHeat, concentrationScore } from "./heat.js";
export { buildPortfolioHealth } from "./health.js";
export { buildPortfolioWarnings } from "./warnings.js";
export { buildPortfolioStatistics } from "./statistics.js";
export { derivePortfolioFacts, resolveConfig, type PortfolioFacts } from "./facts.js";
export {
  clamp,
  clamp01,
  round,
  mv,
  fin,
  sumFinite,
  avg,
  median,
  maxFinite,
  minFinite,
  safeDiv,
  type Tri,
} from "./util.js";
