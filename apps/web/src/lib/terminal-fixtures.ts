/**
 * Shared test fixtures for the Phase 10A-2 trading terminal (deterministic derivations
 * + UI render tests). Pure data builders — no logic, no clock. Kept in one place so the
 * unit suite and the render suite assert against the same shapes (no duplicated fixtures).
 * This module is imported only by *.test.ts files; it is never bundled by the app.
 */

import type { Measure, RankedDecision, TradingDecision } from "./trading-decision-types";
import type { RankedRow } from "./terminal-derivations";

export const m = (value: number | null, provenance: Measure["provenance"] = "derived"): Measure => ({
  value,
  provenance,
  basis: "fixture",
});

export const na = (): Measure => ({ value: null, provenance: "unavailable", basis: "unavailable" });

/** A fully-populated directional (LONG) decision; override any field per test. */
export function makeDecision(over: Partial<TradingDecision> = {}): TradingDecision {
  return {
    signalId: "sig-1",
    symbol: "BTC-PERP",
    timeframe: "H1",
    direction: "LONG",
    bias: "LONG",
    confidence: 0.9,
    createdAt: "2026-06-27T00:00:00.000Z",
    signalAgeSeconds: 30,
    featureAgeSeconds: 45,
    currentPrice: m(100, "real"),
    entryPrice: m(100, "real"),
    stopLoss: m(97),
    takeProfit1: m(103),
    takeProfit2: m(106),
    takeProfit3: m(109),
    riskRewardRatio: m(3),
    stopDistancePct: m(3),
    positionSize: m(0.5),
    positionNotional: m(50_000),
    capitalRiskPercent: m(1),
    assumedEquity: 100_000,
    expectedHoldingTime: { seconds: 72_000, bars: 20, provenance: "estimated", basis: "fixture" },
    trendStrength: m(90),
    momentumScore: m(80),
    volatilityScore: m(40),
    liquidityScore: m(80),
    marketRegime: { regime: "TRENDING_BULL", provenance: "derived", basis: "fixture" },
    executionStatus: "READY",
    riskStatus: { status: "APPROVED", reason: "ok", staticOnly: true },
    controlStatus: "ALLOWED",
    overallStatus: "ACTIONABLE",
    explain: {
      bullish: [{ label: "Uptrend structure", detail: "EMA20 > EMA50 > EMA200" }],
      bearish: [],
      neutral: [{ label: "Mid-range", detail: "price at 50% of channel" }],
      risk: [],
      contributions: { trend: m(90), momentum: m(80), volatility: m(40), liquidity: m(80) },
      confidenceBreakdown: { trendComponent: 0.45, momentumComponent: 0.45, total: 0.9, basis: "fixture" },
      executionReadiness: "ready",
      riskApproval: "approved",
      controlApproval: "allowed",
    },
    featureHash: "fh-abc123def456",
    datasetHash: "ds-abc123def456",
    strategyVersionId: "sv-abc123def456",
    provenanceNotes: ["single-TF only — consensus N/A for M1/M5/M15/H4/D1"],
    ...over,
  };
}

/** A FLAT decision (no directional levels) — the demo seed-42 reality. */
export function makeFlat(over: Partial<TradingDecision> = {}): TradingDecision {
  return makeDecision({
    direction: "FLAT",
    bias: "FLAT",
    confidence: 0,
    entryPrice: na(),
    stopLoss: na(),
    takeProfit1: na(),
    takeProfit2: na(),
    takeProfit3: na(),
    riskRewardRatio: na(),
    stopDistancePct: na(),
    positionSize: na(),
    positionNotional: na(),
    capitalRiskPercent: na(),
    trendStrength: na(),
    momentumScore: na(),
    volatilityScore: na(),
    liquidityScore: na(),
    marketRegime: { regime: null, provenance: "unavailable", basis: "no directional edge" },
    overallStatus: "NO_TRADE",
    executionStatus: "BLOCKED",
    riskStatus: { status: "NOT_APPLICABLE", reason: "FLAT", staticOnly: true },
    controlStatus: "BLOCKED",
    expectedHoldingTime: { seconds: null, bars: null, provenance: "unavailable", basis: "FLAT" },
    explain: {
      bullish: [],
      bearish: [],
      neutral: [{ label: "No EMA alignment", detail: "EMAs not stacked" }],
      risk: [{ label: "Volatility filter active", detail: "realized_vol_30 > max — rule stands aside" }],
      contributions: { trend: na(), momentum: na(), volatility: na(), liquidity: na() },
      confidenceBreakdown: { trendComponent: null, momentumComponent: null, total: 0, basis: "FLAT" },
      executionReadiness: "blocked",
      riskApproval: "n/a",
      controlApproval: "blocked",
    },
    provenanceNotes: ["FLAT this hour — no directional levels (never fabricated)"],
    ...over,
  });
}

export function makeRankedRow(over: Partial<RankedRow> = {}): RankedRow {
  const base: RankedDecision = {
    symbol: "BTC-PERP",
    timeframe: "H1",
    direction: "LONG",
    rankScore: 0.5,
    confidence: 0.5,
    riskReward: 2,
    liquidityScore: 50,
    executionStatus: "READY",
    riskStatus: "APPROVED",
    controlStatus: "ALLOWED",
    overallStatus: "ACTIONABLE",
    components: {
      confidence: 0.5,
      riskReward: 0.5,
      liquidity: 0.5,
      featureQuality: 0.9,
      executionReady: 1,
      riskApproved: 1,
      controlApproved: 1,
    },
  };
  return { ...base, signalAgeSeconds: 10, featureAgeSeconds: 20, ...over };
}
