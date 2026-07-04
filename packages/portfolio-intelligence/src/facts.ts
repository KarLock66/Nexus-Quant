/**
 * derivePortfolioFacts — the ONE place the portfolio engine turns a set of served
 * {@link TradingDecision} + {@link TradePlan} outputs (+ runtime/control/kill context) into
 * the atomic, deterministic facts every builder consumes. Centralizing this means the
 * summary, exposure, allocation, heat, health, warnings and statistics all agree by
 * construction and NO classification logic is duplicated across builders.
 *
 * Nothing here is recomputed from raw signals/features — every value is read VERBATIM off the
 * served decision (direction / confidence / notional / risk% / R:R / regime) and the served
 * plan (readiness / action / canTrade). All aggregates fail closed (absent → contributes
 * nothing); no numeric is ever a NaN. Positions are sorted deterministically (symbol, then
 * signalId) so identical inputs serialize identically regardless of input order.
 */

import {
  DEFAULT_PORTFOLIO_CONFIG,
  type PortfolioConfig,
  type PortfolioInputs,
  type PortfolioItem,
  type PortfolioPosition,
  type PositionState,
} from "./types.js";
import { fin, mv, round, sumFinite, type Tri } from "./util.js";

export interface PortfolioFacts {
  cfg: PortfolioConfig;
  now: number;

  // portfolio-wide gating context (verbatim)
  killEngaged: boolean;
  controlAllowed: Tri;
  runtimeHealthy: Tri;

  // normalized positions (sorted; one per item)
  positions: PortfolioPosition[];
  open: PortfolioPosition[];
  directional: PortfolioPosition[];

  // counts
  openCount: number;
  waitingCount: number;
  blockedCount: number;
  flatCount: number;
  readyCount: number;
  totalCount: number;
  staleCount: number;
  lowDqCount: number;

  // capital + exposure aggregates ($)
  assumedEquity: number;
  longExposure: number;
  shortExposure: number;
  grossExposure: number;
  netExposure: number;
  capitalUsed: number;
  capitalAvailable: number;
  capitalPct: number;

  // risk aggregates
  riskUsedAbs: number;
  riskBudgetAbs: number;
  riskRemainingAbs: number;
  riskUsedPct: number;
}

export function resolveConfig(partial?: Partial<PortfolioConfig>): PortfolioConfig {
  return { ...DEFAULT_PORTFOLIO_CONFIG, ...(partial ?? {}) };
}

/** Stale only when a real age source exists AND exceeds its bound (unknown → not stale here). */
function isStale(item: PortfolioItem, cfg: PortfolioConfig): boolean {
  const d = item.decision;
  const sigAge = fin(d.signalAgeSeconds);
  const featAge = fin(d.featureAgeSeconds);
  const sigStale = sigAge !== null && sigAge > cfg.signalStaleSeconds;
  const featStale = featAge !== null && featAge > cfg.featureStaleSeconds;
  return sigStale || featStale;
}

/** Hard-block exactly as the trade-plan engine does (kill / control / risk / overall). */
function isHardBlocked(item: PortfolioItem, killEngaged: boolean): boolean {
  const d = item.decision;
  return (
    killEngaged ||
    d.controlStatus === "BLOCKED" ||
    d.riskStatus.status === "BLOCKED" ||
    d.overallStatus === "BLOCKED"
  );
}

/**
 * Lifecycle state of one candidate position — a fail-closed partition over the served
 * decision + plan. OPEN requires a directional, actionable, can-trade AND fresh signal, so a
 * stale-but-actionable signal degrades to WAITING (never counted as live exposure).
 */
function classify(item: PortfolioItem, killEngaged: boolean, cfg: PortfolioConfig): PositionState {
  const d = item.decision;
  const directional = d.direction !== "FLAT";
  if (!directional || d.overallStatus === "NO_TRADE") return "FLAT";
  if (isHardBlocked(item, killEngaged)) return "BLOCKED";
  const canTrade = item.plan.summary.canTrade === true && d.overallStatus === "ACTIONABLE";
  if (canTrade && !isStale(item, cfg)) return "OPEN";
  return "WAITING";
}

function toPosition(item: PortfolioItem, killEngaged: boolean, cfg: PortfolioConfig): PortfolioPosition {
  const d = item.decision;
  const p = item.plan;
  const state = classify(item, killEngaged, cfg);
  const contributesExposure = state === "OPEN";

  return {
    signalId: d.signalId,
    symbol: d.symbol,
    timeframe: d.timeframe,
    direction: d.direction,
    state,
    action: p.summary.action,
    confidence: Number.isFinite(d.confidence) ? d.confidence : 0,
    notional: mv(d.positionNotional),
    maxLoss: fin(p.risk.maximumLoss.value),
    riskPct: mv(d.capitalRiskPercent),
    riskReward: mv(d.riskRewardRatio),
    readiness: Number.isFinite(p.readiness.score) ? p.readiness.score : 0,
    readinessBand: p.readiness.band,
    regime: d.marketRegime.regime,
    contributesExposure,
  };
}

export function derivePortfolioFacts(inputs: PortfolioInputs): PortfolioFacts {
  const cfg = resolveConfig(inputs.config);
  const killEngaged = inputs.killEngaged === true;

  const controlAllowed: Tri =
    inputs.controlPermission === "ALLOWED"
      ? true
      : inputs.controlPermission === "BLOCKED"
        ? false
        : null;
  const runtimeHealthy: Tri =
    inputs.runtimeState === null ? null : inputs.runtimeState === "HEALTHY";

  // Normalize + sort deterministically (symbol, then signalId) — order-independent output.
  const positions = inputs.items
    .map((it) => toPosition(it, killEngaged, cfg))
    .sort((a, b) => (a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : a.signalId < b.signalId ? -1 : a.signalId > b.signalId ? 1 : 0));

  const open = positions.filter((p) => p.state === "OPEN");
  const directional = positions.filter((p) => p.direction !== "FLAT");

  const openCount = open.length;
  const waitingCount = positions.filter((p) => p.state === "WAITING").length;
  const blockedCount = positions.filter((p) => p.state === "BLOCKED").length;
  const flatCount = positions.filter((p) => p.state === "FLAT").length;
  const readyCount = open.filter((p) => p.readinessBand === "READY").length;
  const totalCount = positions.length;
  const staleCount = inputs.items.filter((it) => it.decision.direction !== "FLAT" && isStale(it, cfg)).length;
  const lowDqCount = inputs.items.filter(
    (it) => it.dqScore !== null && Number.isFinite(it.dqScore) && (it.dqScore as number) < cfg.minDqScore,
  ).length;

  // Assumed equity — the served decisions all carry the SAME web-tier equity assumption;
  // take the max across OPEN-or-any decisions (deterministic), fall back to the config default.
  const equities = inputs.items
    .map((it) => fin(it.decision.assumedEquity))
    .filter((x): x is number => x !== null && x > 0);
  const assumedEquity = equities.length > 0 ? Math.max(...equities) : cfg.defaultEquity;

  // Exposure ($) — OPEN positions only (a blocked/waiting/flat candidate exposes nothing).
  const longExposure = round(sumFinite(open.filter((p) => p.direction === "LONG").map((p) => p.notional)), 2);
  const shortExposure = round(sumFinite(open.filter((p) => p.direction === "SHORT").map((p) => p.notional)), 2);
  const grossExposure = round(longExposure + shortExposure, 2);
  const netExposure = round(longExposure - shortExposure, 2);

  const capitalUsed = grossExposure;
  const capitalAvailable = round(Math.max(0, assumedEquity - capitalUsed), 2);
  const capitalPct = assumedEquity > 0 ? round((capitalUsed / assumedEquity) * 100, 2) : 0;

  // Risk ($) — Σ maxLoss of OPEN positions vs the documented portfolio risk budget.
  const riskUsedAbs = round(sumFinite(open.map((p) => p.maxLoss)), 2);
  const riskBudgetAbs = round((assumedEquity * cfg.maxPortfolioRiskPct) / 100, 2);
  const riskRemainingAbs = round(Math.max(0, riskBudgetAbs - riskUsedAbs), 2);
  const riskUsedPct = assumedEquity > 0 ? round((riskUsedAbs / assumedEquity) * 100, 2) : 0;

  return {
    cfg,
    now: inputs.now,
    killEngaged,
    controlAllowed,
    runtimeHealthy,
    positions,
    open,
    directional,
    openCount,
    waitingCount,
    blockedCount,
    flatCount,
    readyCount,
    totalCount,
    staleCount,
    lowDqCount,
    assumedEquity,
    longExposure,
    shortExposure,
    grossExposure,
    netExposure,
    capitalUsed,
    capitalAvailable,
    capitalPct,
    riskUsedAbs,
    riskBudgetAbs,
    riskRemainingAbs,
    riskUsedPct,
  };
}
