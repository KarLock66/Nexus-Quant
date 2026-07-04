import { describe, expect, it } from "vitest";
import {
  buildAllocationBars,
  buildCapitalMeter,
  buildExposureBars,
  buildHealthView,
  buildPortfolioStatus,
  buildRiskHeatBar,
  buildStatistics,
  buildSummaryCards,
  buildTableRows,
  buildWarningGroups,
  finite,
  formatConfidence,
  formatCurrency,
  formatNumber,
  formatPercent,
  formatRatio,
  formatRisk,
  sortPortfolio,
  type PortfolioTableRow,
} from "./portfolio-terminal-derivations";
import {
  makeAllocation,
  makeDecision,
  makeExposure,
  makeFlat,
  makeHeat,
  makeHealth,
  makeReadinessRow,
  makeStatistics,
  makeSummary,
  makeWarnings,
  pm,
  pmNa,
} from "./portfolio-terminal-fixtures";

/**
 * Phase 10C-2B-1 — Portfolio Terminal presentation derivations. Pure-function unit tests:
 * deterministic output, provenance preserved verbatim, and the hard fail-closed contract —
 * null / undefined / NaN / Infinity NEVER become a fabricated 0 or a NaN; they become null
 * (rendered "—" upstream). Sorting is stable with nulls always last.
 */

describe("formatters — fail closed", () => {
  it("formatPercent", () => {
    expect(formatPercent(12.34, 1)).toBe("12.3%");
    expect(formatPercent(0)).toBe("0.0%");
    expect(formatPercent(null)).toBe("—");
    expect(formatPercent(undefined)).toBe("—");
    expect(formatPercent(NaN)).toBe("—");
    expect(formatPercent(Infinity)).toBe("—");
    expect(formatPercent(-Infinity)).toBe("—");
  });

  it("formatCurrency", () => {
    expect(formatCurrency(50_000)).toBe("$50,000");
    expect(formatCurrency(0)).toBe("$0");
    expect(formatCurrency(-1_000)).toBe("-$1,000");
    expect(formatCurrency(null)).toBe("—");
    expect(formatCurrency(NaN)).toBe("—");
  });

  it("formatRatio / formatNumber / formatRisk / formatConfidence", () => {
    expect(formatRatio(3)).toBe("3.00:1");
    expect(formatRatio(null)).toBe("—");
    expect(formatNumber(72, 0)).toBe("72");
    expect(formatNumber(null)).toBe("—");
    expect(formatRisk(1, 2)).toBe("1.00%");
    expect(formatRisk(null)).toBe("—");
    expect(formatConfidence(0.9)).toBe("90%");
    expect(formatConfidence(null)).toBe("—");
  });

  it("finite", () => {
    expect(finite(5)).toBe(5);
    expect(finite(null)).toBeNull();
    expect(finite(NaN)).toBeNull();
    expect(finite(Infinity)).toBeNull();
  });
});

describe("buildPortfolioStatus", () => {
  it("maps each status to a tone, unknown → UNAVAILABLE/neutral", () => {
    expect(buildPortfolioStatus("HEALTHY")).toEqual({ label: "HEALTHY", tone: "positive" });
    expect(buildPortfolioStatus("CAUTION")).toEqual({ label: "CAUTION", tone: "warning" });
    expect(buildPortfolioStatus("RISK")).toEqual({ label: "RISK", tone: "negative" });
    expect(buildPortfolioStatus("BLOCKED")).toEqual({ label: "BLOCKED", tone: "negative" });
    expect(buildPortfolioStatus(null)).toEqual({ label: "UNAVAILABLE", tone: "neutral" });
    expect(buildPortfolioStatus(undefined)).toEqual({ label: "UNAVAILABLE", tone: "neutral" });
  });
});

describe("buildSummaryCards", () => {
  it("renders counts verbatim and $-figures fail closed", () => {
    const cards = buildSummaryCards(makeSummary());
    const byLabel = Object.fromEntries(cards.map((c) => [c.label, c.value]));
    expect(byLabel.Status).toBe("HEALTHY");
    expect(byLabel["Net Exposure"]).toBe("$4,000");
    expect(byLabel["Open Trades"]).toBe("2");
  });

  it("null summary fails every figure closed (no fabricated 0 for $)", () => {
    const cards = buildSummaryCards(null);
    const byLabel = Object.fromEntries(cards.map((c) => [c.label, c.value]));
    expect(byLabel["Net Exposure"]).toBe("—");
    expect(byLabel["Capital Used"]).toBe("—");
    expect(byLabel["Open Trades"]).toBe("—");
    expect(byLabel.Status).toBe("UNAVAILABLE");
  });

  it("NaN counts/figures never leak", () => {
    const cards = buildSummaryCards(makeSummary({ netExposure: NaN, openTrades: NaN }));
    const byLabel = Object.fromEntries(cards.map((c) => [c.label, c.value]));
    expect(byLabel["Net Exposure"]).toBe("—");
    expect(byLabel["Open Trades"]).toBe("—");
  });
});

describe("buildCapitalMeter", () => {
  it("computes used/(used+remaining) fill", () => {
    const { capital, risk } = buildCapitalMeter(makeSummary({ capitalUsed: 20_000, capitalAvailable: 80_000, riskUsed: 1_500, riskRemaining: 8_500 }));
    expect(capital.pct).toBeCloseTo(20, 5);
    expect(capital.available).toBe(true);
    expect(risk.pct).toBeCloseTo(15, 5);
  });

  it("fails closed when a leg is missing (no fabricated fill)", () => {
    const { capital } = buildCapitalMeter(makeSummary({ capitalUsed: NaN }));
    expect(capital.available).toBe(false);
    expect(capital.pct).toBe(0);
    expect(capital.usedLabel).toBe("—");
  });

  it("zero total yields 0 fill, not NaN", () => {
    const { capital } = buildCapitalMeter(makeSummary({ capitalUsed: 0, capitalAvailable: 0 }));
    expect(capital.pct).toBe(0);
    expect(capital.available).toBe(true);
  });
});

describe("buildExposureBars", () => {
  it("preserves group order and provenance, clamps width only", () => {
    const bars = buildExposureBars(makeExposure());
    expect(bars).not.toBeNull();
    expect(bars!.bySymbol.map((b) => b.key)).toEqual(["BTC-PERP", "ETH-PERP"]);
    expect(bars!.bySymbol[0]!.provenance).toBe("derived");
    expect(bars!.bySide[0]!.label).toBe("Long");
  });

  it("clamps an out-of-range sharePct to 0..100 and NaN → 0", () => {
    const bars = buildExposureBars(
      makeExposure({ bySymbol: [{ key: "X", notional: 1, sharePct: 250, count: 1, provenance: "derived" }, { key: "Y", notional: 1, sharePct: NaN, count: 1, provenance: "derived" }] }),
    );
    expect(bars!.bySymbol[0]!.pct).toBe(100);
    expect(bars!.bySymbol[1]!.pct).toBe(0);
  });

  it("null exposure → null", () => {
    expect(buildExposureBars(null)).toBeNull();
  });
});

describe("buildAllocationBars", () => {
  it("derives diversification = 100 − concentration", () => {
    const view = buildAllocationBars(makeAllocation({ concentration: pm(52) }));
    expect(view!.diversification.label).toBe("48.0%");
    expect(view!.diversification.pct).toBeCloseTo(48, 5);
  });

  it("null concentration fails closed (no fabricated diversification)", () => {
    const view = buildAllocationBars(makeAllocation({ concentration: pmNa() }));
    expect(view!.concentration.label).toBe("—");
    expect(view!.diversification.label).toBe("—");
    expect(view!.diversification.pct).toBe(0);
  });

  it("preserves per-symbol measure provenance", () => {
    const view = buildAllocationBars(makeAllocation());
    expect(view!.perSymbol[0]!.exposure.provenance).toBe("derived");
    expect(view!.largestPosition.symbol).toBe("BTC-PERP");
  });
});

describe("buildRiskHeatBar", () => {
  it("carries score verbatim and computes earned/weight per component", () => {
    const view = buildRiskHeatBar(makeHeat());
    expect(view!.heatScoreLabel).toBe("42");
    expect(view!.fillPct).toBe(42);
    expect(view!.band).toEqual({ label: "WARM", tone: "info" });
    const conc = view!.components.find((c) => c.key === "concentration")!;
    expect(conc.earnedPct).toBeCloseTo(52, 0); // 10.4 / 20 * 100
    expect(view!.provenance).toBe("derived");
  });

  it("null heatScore fails closed", () => {
    const view = buildRiskHeatBar(makeHeat({ heatScore: NaN }));
    expect(view!.heatScore).toBeNull();
    expect(view!.heatScoreLabel).toBe("—");
    expect(view!.fillPct).toBe(0);
  });
});

describe("buildWarningGroups", () => {
  it("groups by severity in CRITICAL→LOW order with engine tallies", () => {
    const view = buildWarningGroups(makeWarnings());
    expect(view.groups.map((g) => g.severity)).toEqual(["CRITICAL", "HIGH", "MEDIUM", "LOW"]);
    expect(view.counts.CRITICAL).toBe(1);
    expect(view.total).toBe(4);
    expect(view.groups[0]!.items[0]!.provenance).toBe("real");
    expect(view.groups[0]!.items[0]!.title).toBe("Control Plane");
  });

  it("empty warnings → all-zero groups, total 0", () => {
    const view = buildWarningGroups(makeWarnings({ warnings: [], critical: 0, high: 0, medium: 0, low: 0 }));
    expect(view.total).toBe(0);
    expect(view.groups.every((g) => g.items.length === 0)).toBe(true);
  });

  it("null warnings → empty fail-closed view", () => {
    const view = buildWarningGroups(null);
    expect(view.total).toBe(0);
    expect(view.groups).toHaveLength(4);
  });
});

describe("buildStatistics", () => {
  it("formats tiles fail-closed and computes distribution shares", () => {
    const view = buildStatistics(makeStatistics());
    expect(view!.sampleSize).toBe(3);
    const byLabel = Object.fromEntries(view!.tiles.map((t) => [t.label, t.value]));
    expect(byLabel["Avg Confidence"]).toBe("78%");
    expect(byLabel["Avg R:R"]).toBe("2.50:1");
    expect(view!.best.symbol).toBe("BTC-PERP");
  });

  it("null averages fail closed to —", () => {
    const view = buildStatistics(makeStatistics({ averageConfidence: null, averageRiskReward: null, averageReadiness: null, averageRisk: null }));
    const byLabel = Object.fromEntries(view!.tiles.map((t) => [t.label, t.value]));
    expect(byLabel["Avg Confidence"]).toBe("—");
    expect(byLabel["Avg R:R"]).toBe("—");
    expect(byLabel["Avg Readiness"]).toBe("—");
  });
});

describe("buildHealthView", () => {
  it("maps gates to tones and carries reasons verbatim", () => {
    const view = buildHealthView(makeHealth());
    expect(view!.status).toEqual({ label: "CAUTION", tone: "warning" });
    expect(view!.reasons).toHaveLength(2);
    const kill = view!.gates.find((g) => g.label === "Kill Engaged")!;
    expect(kill.tone).toBe("positive"); // killEngaged=false is GOOD
    expect(kill.text).toBe("NO");
  });

  it("kill engaged renders negative", () => {
    const view = buildHealthView(makeHealth({ killEngaged: true }));
    const kill = view!.gates.find((g) => g.label === "Kill Engaged")!;
    expect(kill.tone).toBe("negative");
    expect(kill.text).toBe("YES");
  });

  it("null gate flags → UNKNOWN/neutral", () => {
    const view = buildHealthView(makeHealth({ runtimeHealthy: null, controlAllowed: null }));
    expect(view!.gates.find((g) => g.label === "Runtime Healthy")!.text).toBe("UNKNOWN");
  });
});

describe("buildTableRows — join + provenance", () => {
  it("joins allocation + exposure + decision + readiness verbatim", () => {
    const rows = buildTableRows({
      perSymbol: makeAllocation().perSymbol,
      bySymbol: makeExposure().bySymbol,
      decisions: [makeDecision({ symbol: "BTC-PERP" })],
      readiness: [makeReadinessRow({ symbol: "BTC-PERP", score: 82, band: "READY" })],
    });
    const btc = rows.find((r) => r.symbol === "BTC-PERP")!;
    expect(btc.direction).toBe("LONG");
    expect(btc.confidence).toBe(0.9);
    expect(btc.readiness).toBe(82);
    expect(btc.riskReward).toBe(3);
    expect(btc.risk.value).toBe(1); // capitalRiskPercent verbatim
    expect(btc.status).toEqual({ label: "READY", tone: "positive" });
    expect(btc.rowProvenance).toBe("verbatim");
  });

  it("allocation-only symbol (no decision) fails closed but still renders, DERIVED row", () => {
    const rows = buildTableRows({
      perSymbol: makeAllocation().perSymbol, // BTC, ETH
      bySymbol: [],
      decisions: [], // none
      readiness: [],
    });
    const eth = rows.find((r) => r.symbol === "ETH-PERP")!;
    expect(eth.direction).toBeNull();
    expect(eth.confidence).toBeNull();
    expect(eth.readiness).toBeNull();
    expect(eth.riskReward).toBeNull();
    expect(eth.status).toEqual({ label: "UNAVAILABLE", tone: "neutral" });
    expect(eth.rowProvenance).toBe("derived");
    expect(eth.capitalPct.value).toBe(8); // allocation present
  });

  it("decision-only symbol (no allocation) still renders with verbatim decision fields", () => {
    const rows = buildTableRows({
      perSymbol: [],
      bySymbol: [],
      decisions: [makeDecision({ symbol: "XRP-PERP" })],
      readiness: [],
    });
    const xrp = rows.find((r) => r.symbol === "XRP-PERP")!;
    expect(xrp.direction).toBe("LONG");
    expect(xrp.capitalPct.value).toBeNull(); // no allocation
    expect(xrp.rowProvenance).toBe("verbatim");
  });

  it("FLAT decision → FLAT status, control-blocked → BLOCKED", () => {
    const rows = buildTableRows({
      perSymbol: [],
      bySymbol: [],
      decisions: [makeFlat({ symbol: "SOL-PERP" })],
      readiness: [],
    });
    // makeFlat has overallStatus NO_TRADE and controlStatus BLOCKED → BLOCKED wins.
    expect(rows[0]!.status.label).toBe("BLOCKED");
  });

  it("deterministic symbol union order: allocation, then exposure-only, then decision-only", () => {
    const rows = buildTableRows({
      perSymbol: [{ symbol: "AAA", capitalPct: pm(1), riskPct: pm(1), exposurePct: pm(1) }],
      bySymbol: [{ key: "BBB", notional: 1, sharePct: 1, count: 1, provenance: "derived" }],
      decisions: [makeDecision({ symbol: "CCC" })],
      readiness: [],
    });
    expect(rows.map((r) => r.symbol)).toEqual(["AAA", "BBB", "CCC"]);
  });
});

describe("sortPortfolio — stable, nulls last", () => {
  const mkRow = (symbol: string, confidence: number | null): PortfolioTableRow => ({
    symbol,
    direction: "LONG",
    directionProvenance: "verbatim",
    status: { label: "READY", tone: "positive" },
    confidence,
    readiness: null,
    readinessBand: null,
    risk: { value: null, provenance: "unavailable" },
    capitalPct: { value: null, provenance: "unavailable" },
    exposurePct: { value: null, provenance: "unavailable" },
    notional: null,
    riskReward: null,
    riskRewardProvenance: "unavailable",
    rowProvenance: "verbatim",
  });

  it("sorts numeric desc with nulls last", () => {
    const rows = [mkRow("A", 0.5), mkRow("B", null), mkRow("C", 0.9)];
    const sorted = sortPortfolio(rows, "confidence", "desc");
    expect(sorted.map((r) => r.symbol)).toEqual(["C", "A", "B"]);
  });

  it("nulls still last when ascending", () => {
    const rows = [mkRow("A", 0.5), mkRow("B", null), mkRow("C", 0.9)];
    const sorted = sortPortfolio(rows, "confidence", "asc");
    expect(sorted.map((r) => r.symbol)).toEqual(["A", "C", "B"]);
  });

  it("ties break by symbol (stable total order)", () => {
    const rows = [mkRow("C", 0.5), mkRow("A", 0.5), mkRow("B", 0.5)];
    const sorted = sortPortfolio(rows, "confidence", "desc");
    expect(sorted.map((r) => r.symbol)).toEqual(["A", "B", "C"]);
  });

  it("text key (symbol) sorts ascending by default", () => {
    const rows = [mkRow("C", 0.5), mkRow("A", 0.5), mkRow("B", 0.5)];
    expect(sortPortfolio(rows, "symbol", "asc").map((r) => r.symbol)).toEqual(["A", "B", "C"]);
    expect(sortPortfolio(rows, "symbol", "desc").map((r) => r.symbol)).toEqual(["C", "B", "A"]);
  });

  it("does not mutate the input array", () => {
    const rows = [mkRow("C", 0.5), mkRow("A", 0.9)];
    const before = rows.map((r) => r.symbol);
    sortPortfolio(rows, "confidence", "desc");
    expect(rows.map((r) => r.symbol)).toEqual(before);
  });

  it("is idempotent / deterministic across repeated sorts", () => {
    const rows = [mkRow("C", 0.5), mkRow("A", null), mkRow("B", 0.9), mkRow("D", null)];
    const once = sortPortfolio(rows, "confidence", "desc");
    const twice = sortPortfolio(once, "confidence", "desc");
    expect(twice.map((r) => r.symbol)).toEqual(once.map((r) => r.symbol));
    expect(once.map((r) => r.symbol)).toEqual(["B", "C", "A", "D"]); // nulls last, tiebreak A<D
  });
});
