/**
 * PortfolioSummary — the top-line snapshot: exposure ($ long/short/net/gross), the trade
 * count buckets (open/blocked/waiting/ready/flat), capital used/available, risk used/remaining
 * and the overall status. Every figure is an aggregate of already-served decision/plan values
 * (consumed verbatim via the shared facts); nothing is recomputed and nothing is fabricated.
 * The status mirrors PortfolioHealth by construction (single precedence ladder).
 */

import { derivePortfolioFacts } from "./facts.js";
import { buildPortfolioHealth } from "./health.js";
import type { PortfolioInputs, PortfolioSummary } from "./types.js";

export function buildPortfolioSummary(inputs: PortfolioInputs): PortfolioSummary {
  const facts = derivePortfolioFacts(inputs);
  const status = buildPortfolioHealth(inputs).status;

  return {
    currentExposure: facts.grossExposure,
    longExposure: facts.longExposure,
    shortExposure: facts.shortExposure,
    netExposure: facts.netExposure,
    openTrades: facts.openCount,
    blockedTrades: facts.blockedCount,
    waitingTrades: facts.waitingCount,
    readyTrades: facts.readyCount,
    flatTrades: facts.flatCount,
    capitalUsed: facts.capitalUsed,
    capitalAvailable: facts.capitalAvailable,
    riskUsed: facts.riskUsedAbs,
    riskRemaining: facts.riskRemainingAbs,
    status,
    assumedEquity: facts.assumedEquity,
    note:
      `${facts.openCount} open / ${facts.waitingCount} waiting / ${facts.blockedCount} blocked / ` +
      `${facts.flatCount} flat of ${facts.totalCount}; capital ${facts.capitalPct}% deployed, ` +
      `risk $${facts.riskUsedAbs} of $${facts.riskBudgetAbs} budget (assumed equity $${facts.assumedEquity})`,
  };
}
