/**
 * buildPortfolioState — the deterministic orchestration that assembles the complete portfolio
 * state from a set of served TradingDecision + TradePlan outputs (+ live runtime/control/kill
 * context). It derives the shared facts once and delegates to the eight section builders, so
 * every section agrees by construction and no classification logic is duplicated.
 *
 * Invariants mirror @nexus/trading-decision / @nexus/trading-plan: the decision + plan are
 * consumed VERBATIM (nothing they already carry is recomputed), the clock is INJECTED
 * (inputs.now), and every output is fail-closed (null / 0 / UNAVAILABLE — never a NaN or a
 * fabricated figure).
 */

import { derivePortfolioFacts } from "./facts.js";
import { buildPortfolioSummary } from "./summary.js";
import { buildPortfolioExposure } from "./exposure.js";
import { buildCapitalAllocation } from "./allocation.js";
import { buildRiskHeat } from "./heat.js";
import { buildPortfolioHealth } from "./health.js";
import { buildPortfolioWarnings } from "./warnings.js";
import { buildPortfolioStatistics } from "./statistics.js";
import type { PortfolioInputs, PortfolioState } from "./types.js";

export function buildPortfolioState(inputs: PortfolioInputs): PortfolioState {
  const facts = derivePortfolioFacts(inputs);

  return {
    summary: buildPortfolioSummary(inputs),
    exposure: buildPortfolioExposure(inputs),
    allocation: buildCapitalAllocation(inputs),
    heat: buildRiskHeat(inputs),
    health: buildPortfolioHealth(inputs),
    warnings: buildPortfolioWarnings(inputs),
    statistics: buildPortfolioStatistics(inputs),
    positions: facts.positions,
    generatedNote:
      `derived from ${facts.totalCount} served decision/plan pair(s) ` +
      `(consumed verbatim, nothing re-decided; ${facts.openCount} open, ${facts.directional.length} directional)`,
  };
}
