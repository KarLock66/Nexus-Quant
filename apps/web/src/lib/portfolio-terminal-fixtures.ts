/**
 * Shared deterministic fixtures for the Phase 10C-2B-1 Portfolio Terminal (presentation
 * derivations + UI render tests). Pure data builders — no logic, no clock, no randomness.
 * They construct the wire-view shapes the `/api/v1/portfolio/*` API serves (verbatim engine
 * output), so the unit + render suites assert against the same shapes the runtime produces.
 * Imported ONLY by *.test.ts; never bundled by the app.
 */

import type { ReadinessRow } from "./trade-plan-types";
import type {
  CapitalAllocation,
  ConfidenceBucket,
  ExposureGroup,
  PortfolioDistribution,
  PortfolioExposure,
  PortfolioExposureView,
  PortfolioHealth,
  PortfolioHealthView,
  PortfolioMeasure,
  PortfolioStatistics,
  PortfolioSummary,
  PortfolioSummaryView,
  PortfolioWarning,
  PortfolioWarnings,
  RiskHeat,
  SymbolAllocation,
} from "./portfolio-types";

// Re-export the decision builders so the table tests share one source of truth.
export { makeDecision, makeFlat } from "./terminal-fixtures";

export const pm = (
  value: number | null,
  provenance: PortfolioMeasure["provenance"] = "derived",
): PortfolioMeasure => ({ value, provenance, basis: "fixture" });

export const pmNa = (): PortfolioMeasure => ({ value: null, provenance: "unavailable", basis: "unavailable" });

export const grp = (over: Partial<ExposureGroup> = {}): ExposureGroup => ({
  key: "BTC-PERP",
  notional: 10_000,
  sharePct: 50,
  count: 1,
  provenance: "derived",
  ...over,
});

export const symAlloc = (over: Partial<SymbolAllocation> = {}): SymbolAllocation => ({
  symbol: "BTC-PERP",
  capitalPct: pm(10),
  riskPct: pm(1),
  exposurePct: pm(50),
  ...over,
});

// ─────────────────────────── summary ───────────────────────────

export function makeSummary(over: Partial<PortfolioSummary> = {}): PortfolioSummary {
  return {
    currentExposure: 20_000,
    longExposure: 12_000,
    shortExposure: 8_000,
    netExposure: 4_000,
    openTrades: 2,
    blockedTrades: 1,
    waitingTrades: 1,
    readyTrades: 1,
    flatTrades: 1,
    capitalUsed: 20_000,
    capitalAvailable: 80_000,
    riskUsed: 1_500,
    riskRemaining: 8_500,
    status: "HEALTHY",
    assumedEquity: 100_000,
    note: "2 OPEN positions on a 100,000 assumed book",
    ...over,
  };
}

export function makeStatistics(over: Partial<PortfolioStatistics> = {}): PortfolioStatistics {
  const distribution: PortfolioDistribution = {
    byAction: { STRONG_BUY: 1, BUY: 1, WATCH: 0, WAIT: 1, NO_TRADE: 1, SELL: 0, STRONG_SELL: 0 },
    byReadinessBand: { READY: 1, NEAR: 1, FORMING: 0, NOT_READY: 1 },
    byRegime: [grp({ key: "TRENDING_BULL", sharePct: 100, count: 2 })],
    confidenceBuckets: [
      { label: "HIGH", count: 1 },
      { label: "MEDIUM", count: 1 },
      { label: "LOW", count: 0 },
    ] satisfies ConfidenceBucket[],
  };
  return {
    sampleSize: 3,
    averageConfidence: 0.78,
    medianConfidence: 0.8,
    highestConfidence: 0.9,
    lowestConfidence: 0.6,
    averageRiskReward: 2.5,
    averageReadiness: 72,
    averageRisk: 1.1,
    bestOpportunity: { symbol: "BTC-PERP", timeframe: "H1", direction: "LONG", value: 88 },
    worstOpportunity: { symbol: "SOL-PERP", timeframe: "H1", direction: "FLAT", value: 12 },
    distribution,
    note: "stats over 3 directional candidates",
    ...over,
  };
}

export function makeAllocation(over: Partial<CapitalAllocation> = {}): CapitalAllocation {
  return {
    capitalPct: pm(20),
    riskPct: pm(1.5),
    exposurePct: pm(20),
    perSymbol: [
      symAlloc({ symbol: "BTC-PERP", capitalPct: pm(12), riskPct: pm(1), exposurePct: pm(60) }),
      symAlloc({ symbol: "ETH-PERP", capitalPct: pm(8), riskPct: pm(0.5), exposurePct: pm(40) }),
    ],
    largestPosition: { symbol: "BTC-PERP", value: 12_000, provenance: "derived", basis: "fixture" },
    largestRisk: { symbol: "BTC-PERP", value: 1_000, provenance: "derived", basis: "fixture" },
    largestOpportunity: { symbol: "BTC-PERP", value: 88, provenance: "derived", basis: "fixture" },
    concentration: pm(52),
    note: "single-name concentration 52 (HHI)",
    ...over,
  };
}

export function makeSummaryView(over: Partial<PortfolioSummaryView> = {}): PortfolioSummaryView {
  return {
    summary: makeSummary(),
    statistics: makeStatistics(),
    allocation: makeAllocation(),
    symbolsMissingPrice: [],
    ...over,
  };
}

// ─────────────────────────── exposure + heat ───────────────────────────

export function makeExposure(over: Partial<PortfolioExposure> = {}): PortfolioExposure {
  return {
    bySymbol: [
      grp({ key: "BTC-PERP", notional: 12_000, sharePct: 60, count: 1 }),
      grp({ key: "ETH-PERP", notional: 8_000, sharePct: 40, count: 1 }),
    ],
    bySide: [
      grp({ key: "LONG", notional: 12_000, sharePct: 60, count: 1 }),
      grp({ key: "SHORT", notional: 8_000, sharePct: 40, count: 1 }),
    ],
    byRegime: [grp({ key: "TRENDING_BULL", notional: 20_000, sharePct: 100, count: 2 })],
    buckets: {
      byState: [grp({ key: "OPEN", notional: 20_000, sharePct: 100, count: 2 })],
      byConfidence: [
        grp({ key: "HIGH", notional: 12_000, sharePct: 60, count: 1 }),
        grp({ key: "MEDIUM", notional: 8_000, sharePct: 40, count: 1 }),
      ],
      byRisk: [grp({ key: "MODERATE", notional: 20_000, sharePct: 100, count: 2 })],
    },
    grossExposure: 20_000,
    netExposure: 4_000,
    note: "gross 20,000 across 2 OPEN positions",
    ...over,
  };
}

export function makeHeat(over: Partial<RiskHeat> = {}): RiskHeat {
  return {
    heatScore: 42,
    heatBand: "WARM",
    diversificationScore: 48,
    concentrationScore: 52,
    portfolioRisk: 15,
    portfolioStability: 58,
    components: [
      { key: "capital", label: "Capital", weight: 25, earned: 5, basis: "20% deployed" },
      { key: "risk", label: "Risk", weight: 30, earned: 4.5, basis: "15% of budget" },
      { key: "concentration", label: "Concentration", weight: 20, earned: 10.4, basis: "HHI 52" },
      { key: "directionalSkew", label: "Directional Skew", weight: 15, earned: 3, basis: "60/40 split" },
      { key: "gating", label: "Gating", weight: 10, earned: 0, basis: "no blocked" },
    ],
    provenance: "derived",
    note: "heat 42 (WARM)",
    ...over,
  };
}

export function makeExposureView(over: Partial<PortfolioExposureView> = {}): PortfolioExposureView {
  return { exposure: makeExposure(), heat: makeHeat(), ...over };
}

// ─────────────────────────── health + warnings ───────────────────────────

export function makeWarning(over: Partial<PortfolioWarning> = {}): PortfolioWarning {
  return {
    id: "w-conc",
    severity: "MEDIUM",
    reason: "single-name concentration 60% ≥ 60% warn threshold",
    source: "concentration",
    provenance: "derived",
    basis: "concentration 60% vs 60% threshold",
    ...over,
  };
}

export function makeWarnings(over: Partial<PortfolioWarnings> = {}): PortfolioWarnings {
  const warnings = over.warnings ?? [
    makeWarning({ id: "w-kill", severity: "CRITICAL", source: "control", reason: "kill switch engaged", provenance: "real", basis: "killEngaged=true" }),
    makeWarning({ id: "w-risk", severity: "HIGH", source: "risk", reason: "risk used 95% of budget", provenance: "derived", basis: "9,500 / 10,000" }),
    makeWarning({ id: "w-conc", severity: "MEDIUM", source: "concentration" }),
    makeWarning({ id: "w-dq", severity: "LOW", source: "data-quality", reason: "one signal at DQ 86", provenance: "real", basis: "dq 86" }),
  ];
  const count = (sev: PortfolioWarning["severity"]) => warnings.filter((w) => w.severity === sev).length;
  return {
    warnings,
    critical: count("CRITICAL"),
    high: count("HIGH"),
    medium: count("MEDIUM"),
    low: count("LOW"),
    note: `${warnings.length} active warnings`,
    ...over,
  };
}

export function makeHealth(over: Partial<PortfolioHealth> = {}): PortfolioHealth {
  return {
    status: "CAUTION",
    reasons: ["risk used 95% of budget", "single-name concentration 60%"],
    runtimeHealthy: true,
    controlAllowed: true,
    killEngaged: false,
    heatBand: "WARM",
    note: "CAUTION — elevated risk usage",
    ...over,
  };
}

export function makeHealthView(over: Partial<PortfolioHealthView> = {}): PortfolioHealthView {
  return { health: makeHealth(), warnings: makeWarnings(), ...over };
}

// ─────────────────────────── readiness rows (table source) ───────────────────────────

export function makeReadinessRow(over: Partial<ReadinessRow> = {}): ReadinessRow {
  return {
    symbol: "BTC-PERP",
    timeframe: "H1",
    direction: "LONG",
    action: "BUY",
    score: 82,
    band: "READY",
    ...over,
  };
}
