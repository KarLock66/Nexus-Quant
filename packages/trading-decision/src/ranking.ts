/**
 * Section F — deterministic opportunity ranking. Every active TradingDecision is scored
 * by a fixed weighted blend of confidence, risk/reward, liquidity, feature quality, and
 * the three approvals (execution-ready / risk-approved / control-approved), then sorted
 * into Top Long / Top Short / Watchlist / Blocked / Waiting. Pure + stable: identical
 * input order + values → identical board (ties broken by symbol then timeframe).
 */

import type {
  OpportunityBoard,
  RankComponents,
  RankedDecision,
  TradingDecision,
} from "./types.js";
import { clamp01, round } from "./util.js";

/** Component weights (sum need not be 1; relative magnitude defines the ranking). */
const W = {
  confidence: 0.30,
  riskReward: 0.20,
  liquidity: 0.15,
  featureQuality: 0.10,
  executionReady: 0.10,
  riskApproved: 0.075,
  controlApproved: 0.075,
} as const;

function components(d: TradingDecision): RankComponents {
  const rr = d.riskRewardRatio.value;
  return {
    confidence: clamp01(d.confidence),
    // Normalize R:R with a soft cap at 3.0 (3:1 → full marks).
    riskReward: rr === null ? 0 : clamp01(rr / 3),
    liquidity: d.liquidityScore.value === null ? 0 : clamp01(d.liquidityScore.value / 100),
    // featureQuality is supplied per-decision by the caller (dqScore/100) in toRanked.
    featureQuality: 0,
    executionReady: d.executionStatus === "READY" ? 1 : 0,
    riskApproved: d.riskStatus.status === "APPROVED" ? 1 : 0,
    controlApproved: d.controlStatus === "ALLOWED" ? 1 : 0,
  };
}

function score(c: RankComponents): number {
  return round(
    W.confidence * c.confidence +
      W.riskReward * c.riskReward +
      W.liquidity * c.liquidity +
      W.featureQuality * c.featureQuality +
      W.executionReady * c.executionReady +
      W.riskApproved * c.riskApproved +
      W.controlApproved * c.controlApproved,
    4,
  );
}

function toRanked(d: TradingDecision, featureQuality: number): RankedDecision {
  const c = { ...components(d), featureQuality: clamp01(featureQuality) };
  return {
    symbol: d.symbol,
    timeframe: d.timeframe,
    direction: d.direction,
    rankScore: score(c),
    confidence: d.confidence,
    riskReward: d.riskRewardRatio.value,
    liquidityScore: d.liquidityScore.value,
    executionStatus: d.executionStatus,
    riskStatus: d.riskStatus.status,
    controlStatus: d.controlStatus,
    overallStatus: d.overallStatus,
    components: c,
  };
}

/** Deterministic, locale-independent string order (byte-stable across environments). */
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const byScore = (a: RankedDecision, b: RankedDecision): number =>
  b.rankScore - a.rankScore || cmp(a.symbol, b.symbol) || cmp(a.timeframe, b.timeframe);

/**
 * Rank a set of decisions. `featureQuality` is supplied per decision (dqScore/100) by
 * the caller, which holds the DataQualityReport score the decision was admitted under.
 */
export function rankOpportunities(
  items: { decision: TradingDecision; featureQuality: number }[],
): OpportunityBoard {
  const ranked = items.map((i) => toRanked(i.decision, i.featureQuality));

  // Mutually exclusive, exhaustive partition (every decision lands in exactly ONE
  // bucket — no double-counting). Only a complete, ACTIONABLE directional decision is a
  // Top Long/Short opportunity; INCOMPLETE/NO_TRADE/FLAT fall to the watchlist.
  const isTop = (r: RankedDecision): boolean =>
    r.overallStatus === "ACTIONABLE" && (r.direction === "LONG" || r.direction === "SHORT");

  const blocked = ranked.filter((r) => r.overallStatus === "BLOCKED").sort(byScore);
  const waiting = ranked.filter((r) => r.overallStatus === "WAITING").sort(byScore);
  const topLong = ranked.filter((r) => isTop(r) && r.direction === "LONG").sort(byScore);
  const topShort = ranked.filter((r) => isTop(r) && r.direction === "SHORT").sort(byScore);
  const watchlist = ranked
    .filter((r) => r.overallStatus !== "BLOCKED" && r.overallStatus !== "WAITING" && !isTop(r))
    .sort(byScore);

  return {
    topLong,
    topShort,
    watchlist,
    blocked,
    waiting,
    total: ranked.length,
    note: `${ranked.length} decisions ranked — ${topLong.length} long / ${topShort.length} short / ${watchlist.length} watch / ${blocked.length} blocked / ${waiting.length} waiting`,
  };
}
