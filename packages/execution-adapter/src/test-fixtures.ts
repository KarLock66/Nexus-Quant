/**
 * Deterministic test fixtures for the execution adapter. Pure data builders — no logic, no
 * clock, no randomness. Excluded from the package build (tsconfig `exclude`); imported only by
 * *.test.ts. The core ExecutionState is produced by the SEALED @nexus/execution-core over a
 * real @nexus/trading-plan built from a TradingDecision fixture, so the adapter suite asserts
 * against the SAME SSoT contracts the core consumes in production (nothing hand-forged).
 */

import { createExecution } from "@nexus/execution-core";
import { buildTradePlan } from "@nexus/trading-plan";
import type { Measure, TradingDecision } from "@nexus/trading-decision";
import type { ExecutionState, TradePlan } from "@nexus/execution-core";
import { createSession } from "./factory.js";
import { NullExecutionAdapter } from "./null.js";
import { PaperExecutionAdapter } from "./paper.js";
import type { RuntimeContext } from "./runtime.js";
import type { AdapterSession } from "./types.js";

export const NOW = 1_700_000_000_000;

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
    positionSize: m(0.6),
    positionNotional: m(60_000),
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
    provenanceNotes: ["single-TF only — consensus N/A for M1/M5/M15/H4/D1"],
    ...over,
  };
}

/** A short-side mirror (SELL) of the green decision. */
export function makeShortDecision(over: Partial<TradingDecision> = {}): TradingDecision {
  return makeDecision({
    direction: "SHORT",
    bias: "SHORT",
    stopLoss: m(103),
    takeProfit1: m(97),
    takeProfit2: m(94),
    takeProfit3: m(91),
    ...over,
  });
}

/** A FLAT decision (no directional levels) — the demo seed-42 reality. */
export function makeFlatDecision(over: Partial<TradingDecision> = {}): TradingDecision {
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

/** Build a real TradePlan via the sealed engine from a decision fixture. */
export function makePlan(decision: TradingDecision = makeDecision()): TradePlan {
  return buildTradePlan({ now: NOW, decision, dqScore: 98, runtimeState: "HEALTHY", killEngaged: false });
}

/**
 * Build a sealed-core ExecutionState (PLANNED, green) from a decision. Uses the public
 * createExecution entry point — the adapter never hand-forges core state.
 */
export function makeCoreState(decision: TradingDecision = makeDecision()): ExecutionState {
  const plan = makePlan(decision);
  const result = createExecution({
    now: NOW,
    decision,
    plan,
    killEngaged: false,
    runtimeHealthy: true,
    mode: "PAPER",
    venue: "SIMULATED",
  });
  if (!result.state) throw new Error("fixture: createExecution returned no state");
  return result.state;
}

/** A fresh paper-adapter session bound to a green core execution. */
export function makePaperSession(decision: TradingDecision = makeDecision()): AdapterSession {
  return createSession(PaperExecutionAdapter, makeCoreState(decision), { now: NOW });
}

/** A fresh null-adapter session bound to a green core execution. */
export function makeNullSession(decision: TradingDecision = makeDecision()): AdapterSession {
  return createSession(NullExecutionAdapter, makeCoreState(decision), { now: NOW });
}

/** A healthy runtime snapshot (override to simulate kill / unhealthy). */
export function makeRuntime(over: Partial<RuntimeContext> = {}): RuntimeContext {
  return { state: "HEALTHY", killEngaged: false, clock: NOW, ...over };
}

/** The deterministic ids of the green plan's orders (entry / stop / 3 targets). */
export function orderIds(session: AdapterSession): { entry: string; stop: string; targets: string[] } {
  const orders = session.core?.plan?.orders ?? [];
  const entry = orders.find((o) => o.role === "ENTRY");
  const stop = orders.find((o) => o.role === "STOP");
  const targets = orders.filter((o) => o.role === "TARGET").map((o) => o.orderId);
  if (!entry || !stop) throw new Error("fixture: green plan missing entry/stop");
  return { entry: entry.orderId, stop: stop.orderId, targets };
}
