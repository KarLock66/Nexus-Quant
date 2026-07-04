/**
 * Deterministic test fixtures for the portfolio-intelligence engine. Pure data builders — no
 * logic, no clock, no randomness. Excluded from the package build (tsconfig `exclude`);
 * imported only by *.test.ts. Self-contained: builds a served {@link TradingDecision} locally
 * (mirroring the web tier's contract) and derives the {@link TradePlan} with the REAL
 * @nexus/trading-plan engine, so the portfolio engine always consumes a genuine plan.
 */

import { buildTradePlan } from "@nexus/trading-plan";
import type { Measure, TradingDecision } from "@nexus/trading-decision";
import type { PortfolioInputs, PortfolioItem } from "./types.js";

export const m = (value: number | null, provenance: Measure["provenance"] = "derived"): Measure => ({
  value,
  provenance,
  basis: "fixture",
});

export const na = (): Measure => ({ value: null, provenance: "unavailable", basis: "unavailable" });

/** A fully-populated directional (LONG), actionable, all-gates-green decision. */
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
      neutral: [],
      risk: [],
      contributions: { trend: m(90), momentum: m(80), volatility: m(40), liquidity: m(80) },
      confidenceBreakdown: { trendComponent: 0.45, momentumComponent: 0.45, total: 0.9, basis: "fixture" },
      executionReadiness: "ready",
      riskApproval: "approved",
      controlApproval: "allowed",
    },
    featureHash: "fh-abc123",
    datasetHash: "ds-abc123",
    strategyVersionId: "sv-abc123",
    provenanceNotes: ["single-TF only — consensus N/A"],
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
    provenanceNotes: ["FLAT this hour — no directional levels (never fabricated)"],
    ...over,
  });
}

/**
 * Build one served {decision, plan, dqScore} item. The plan is derived with the REAL
 * @nexus/trading-plan engine (all gates green by default) so the portfolio engine consumes a
 * genuine plan, never a hand-faked one.
 */
export function makeItem(decision: TradingDecision, dqScore: number | null = 98): PortfolioItem {
  const plan = buildTradePlan({
    now: 1_700_000_000_000,
    decision,
    dqScore: dqScore,
    runtimeState: "HEALTHY",
    killEngaged: false,
  });
  return { decision, plan, dqScore };
}

/** A fully-populated directional LONG actionable item (10k notional on the 100k assumed book). */
export function makeLongItem(over: Partial<TradingDecision> = {}): PortfolioItem {
  return makeItem(makeDecision({ symbol: "BTC-PERP", signalId: "sig-long", positionNotional: m(10_000), ...over }));
}

/** A directional SHORT actionable item (mirror of the LONG fixture). */
export function makeShortItem(over: Partial<TradingDecision> = {}): PortfolioItem {
  return makeItem(makeDecision({ symbol: "ETH-PERP", signalId: "sig-short", direction: "SHORT", bias: "SHORT", positionNotional: m(10_000), ...over }));
}

/** A FLAT (no directional edge) item — the demo seed-42 reality. */
export function makeFlatItem(over: Partial<TradingDecision> = {}): PortfolioItem {
  return makeItem(makeFlat({ symbol: "SOL-PERP", signalId: "sig-flat", ...over }));
}

/** Wrap items into portfolio inputs with sane defaults (all gates green). */
export function makeInputs(over: Partial<PortfolioInputs> = {}): PortfolioInputs {
  const base: PortfolioInputs = {
    now: 1_700_000_000_000,
    items: [makeLongItem(), makeShortItem()],
    runtimeState: "HEALTHY",
    controlPermission: "ALLOWED",
    killEngaged: false,
  };
  return { ...base, ...over };
}
