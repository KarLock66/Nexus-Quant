import { describe, expect, it } from "vitest";
import { createElement as h, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  buildAllocationBars,
  buildCapitalMeter,
  buildExposureBars,
  buildHealthView,
  buildRiskHeatBar,
  buildStatistics,
  buildSummaryCards,
  buildTableRows,
  buildWarningGroups,
  sortPortfolio,
} from "@/lib/portfolio-terminal-derivations";
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
} from "@/lib/portfolio-terminal-fixtures";
import type { PanelPollState } from "./console-ui";
import { PortfolioSummaryPanel } from "./portfolio-summary-panel";
import { PortfolioHealthPanel } from "./portfolio-health-panel";
import { PortfolioExposurePanel } from "./portfolio-exposure-panel";
import { PortfolioAllocationPanel } from "./portfolio-allocation-panel";
import { PortfolioRiskPanel } from "./portfolio-risk-panel";
import { PortfolioWarningPanel } from "./portfolio-warning-panel";
import { PortfolioStatisticsPanel } from "./portfolio-statistics-panel";
import { PortfolioTable } from "./portfolio-table";
import { PortfolioEmpty } from "./portfolio-empty";
import { PortfolioLoading } from "./portfolio-loading";

/**
 * Phase 10C-2B-1 — Portfolio Terminal UI render tests. Renders every panel to static markup
 * via react-dom/server (node-env vitest, no jsdom/RTL). The core fail-closed assertion:
 * across populated, empty, blocked, waiting, missing-price and null fixtures, NO panel ever
 * emits "NaN" or a literal "undefined" — unavailable data renders as "—" / UNAVAILABLE with
 * provenance intact. Snapshot-free: assertions are on invariants, not markup hashes.
 */

const STATE: PanelPollState = { loading: false, error: null, lastUpdated: 1_700_000_000_000 };

function render(el: ReactElement): string {
  return renderToStaticMarkup(el);
}

/** No panel may leak a NaN, a literal undefined, or a raw null as text. */
function assertClean(html: string) {
  expect(html.length).toBeGreaterThan(10);
  expect(html).not.toContain("NaN");
  expect(html).not.toContain("undefined");
  expect(html).not.toContain("null<");
}

interface RenderOpts {
  summary?: ReturnType<typeof makeSummary>;
  allocation?: ReturnType<typeof makeAllocation>;
  statistics?: ReturnType<typeof makeStatistics>;
  exposure?: ReturnType<typeof makeExposure>;
  heat?: ReturnType<typeof makeHeat>;
  health?: ReturnType<typeof makeHealth>;
  warnings?: ReturnType<typeof makeWarnings>;
  rows?: ReturnType<typeof buildTableRows>;
}

function renderAll({
  summary = makeSummary(),
  allocation = makeAllocation(),
  statistics = makeStatistics(),
  exposure = makeExposure(),
  heat = makeHeat(),
  health = makeHealth(),
  warnings = makeWarnings(),
  rows = [],
}: RenderOpts = {}): string {
  const cards = buildSummaryCards(summary);
  const meters = buildCapitalMeter(summary);
  const alloc = buildAllocationBars(allocation);
  const stats = buildStatistics(statistics);
  const bars = buildExposureBars(exposure);
  const heatView = buildRiskHeatBar(heat);
  const healthView = buildHealthView(health);
  const warn = buildWarningGroups(warnings);
  return [
    render(h(PortfolioSummaryPanel, { cards, capital: meters.capital, risk: meters.risk, state: STATE })),
    render(h(PortfolioHealthPanel, { view: healthView, state: STATE })),
    render(h(PortfolioRiskPanel, { view: heatView, warningsCount: warn.total, state: STATE })),
    render(h(PortfolioExposurePanel, { bars, state: STATE })),
    render(h(PortfolioAllocationPanel, { view: alloc, state: STATE })),
    render(h(PortfolioWarningPanel, { view: warn, state: STATE })),
    render(h(PortfolioStatisticsPanel, { view: stats, state: STATE })),
    render(h(PortfolioTable, { rows, sortKey: "exposure", direction: "desc", state: STATE })),
  ].join("\n");
}

describe("portfolio panels — populated multi-position book", () => {
  const rows = sortPortfolio(
    buildTableRows({
      perSymbol: makeAllocation().perSymbol,
      bySymbol: makeExposure().bySymbol,
      decisions: [makeDecision({ symbol: "BTC-PERP" }), makeDecision({ symbol: "ETH-PERP", direction: "SHORT", bias: "SHORT" })],
      readiness: [makeReadinessRow({ symbol: "BTC-PERP" }), makeReadinessRow({ symbol: "ETH-PERP", band: "NEAR", score: 60 })],
    }),
    "exposure",
    "desc",
  );
  const html = renderAll({ rows });

  it("renders cleanly with no NaN / undefined", () => assertClean(html));

  it("shows symbols, status, heat band and currency figures", () => {
    expect(html).toContain("BTC-PERP");
    expect(html).toContain("ETH-PERP");
    expect(html).toContain("HEALTHY");
    expect(html).toContain("WARM");
    expect(html).toContain("$");
  });

  it("preserves provenance tags (verbatim / derived) on the table rows", () => {
    expect(html).toContain("VERBATIM");
    expect(html).toContain("DERIVED");
  });
});

describe("portfolio panels — empty / flat book", () => {
  const html = renderAll({
    summary: makeSummary({
      currentExposure: 0,
      longExposure: 0,
      shortExposure: 0,
      netExposure: 0,
      openTrades: 0,
      blockedTrades: 0,
      waitingTrades: 0,
      readyTrades: 0,
      flatTrades: 0,
      capitalUsed: 0,
      capitalAvailable: 100_000,
      riskUsed: 0,
      riskRemaining: 10_000,
      status: "HEALTHY",
    }),
    warnings: makeWarnings({ warnings: [], critical: 0, high: 0, medium: 0, low: 0 }),
    rows: [],
  });

  it("renders cleanly and shows the 'clear' / no-warning copy", () => {
    assertClean(html);
    expect(html).toContain("No active warnings");
  });

  it("empty-state component renders honest flat-book copy", () => {
    const e = render(h(PortfolioEmpty, { reason: "flat book" }));
    assertClean(e);
    expect(e).toContain("No portfolio positions yet");
  });

  it("loading skeleton renders cleanly", () => {
    const l = render(h(PortfolioLoading, {}));
    expect(l.length).toBeGreaterThan(10);
    expect(l).not.toContain("NaN");
  });
});

describe("portfolio panels — blocked book (kill engaged, RISK status)", () => {
  const html = renderAll({
    summary: makeSummary({ status: "BLOCKED" }),
    health: makeHealth({ status: "BLOCKED", killEngaged: true, controlAllowed: false, reasons: ["kill switch engaged"] }),
    heat: makeHeat({ heatScore: 92, heatBand: "EXTREME" }),
    rows: buildTableRows({
      perSymbol: [],
      bySymbol: [],
      decisions: [makeDecision({ symbol: "BTC-PERP", overallStatus: "BLOCKED", controlStatus: "BLOCKED" })],
      readiness: [],
    }),
  });

  it("renders cleanly with no NaN / undefined", () => assertClean(html));

  it("surfaces the EXTREME heat band and BLOCKED status", () => {
    expect(html).toContain("EXTREME");
    expect(html).toContain("BLOCKED");
  });
});

describe("portfolio panels — waiting book", () => {
  const html = renderAll({
    summary: makeSummary({ status: "CAUTION", openTrades: 0, waitingTrades: 2, readyTrades: 0 }),
    health: makeHealth({ status: "CAUTION" }),
    rows: buildTableRows({
      perSymbol: [],
      bySymbol: [],
      decisions: [makeDecision({ symbol: "BTC-PERP", overallStatus: "WAITING", executionStatus: "WAITING" })],
      readiness: [makeReadinessRow({ symbol: "BTC-PERP", band: "FORMING", score: 35, action: "WAIT" })],
    }),
  });

  it("renders cleanly and shows WAITING", () => {
    assertClean(html);
    expect(html).toContain("WAITING");
  });
});

describe("portfolio panels — null / missing data fails closed", () => {
  it("null views render dashes, never NaN/undefined", () => {
    const cards = buildSummaryCards(null);
    const meters = buildCapitalMeter(null);
    const html = [
      render(h(PortfolioSummaryPanel, { cards, capital: meters.capital, risk: meters.risk, state: STATE })),
      render(h(PortfolioHealthPanel, { view: null, state: STATE })),
      render(h(PortfolioRiskPanel, { view: null, warningsCount: null, state: STATE })),
      render(h(PortfolioExposurePanel, { bars: null, state: STATE })),
      render(h(PortfolioAllocationPanel, { view: null, state: STATE })),
      render(h(PortfolioStatisticsPanel, { view: null, state: STATE })),
      render(h(PortfolioTable, { rows: [], sortKey: "exposure", direction: "desc", state: STATE })),
    ].join("\n");
    assertClean(html);
    expect(html).toContain("—");
  });

  it("NaN-laden summary never leaks NaN into markup", () => {
    const bad = makeSummary({ netExposure: NaN, capitalUsed: Infinity, riskUsed: NaN });
    const cards = buildSummaryCards(bad);
    const meters = buildCapitalMeter(bad);
    const html = render(h(PortfolioSummaryPanel, { cards, capital: meters.capital, risk: meters.risk, state: STATE }));
    assertClean(html);
  });

  it("FLAT decision-only table row renders FLAT/blocked cleanly", () => {
    const rows = buildTableRows({ perSymbol: [], bySymbol: [], decisions: [makeFlat({ symbol: "SOL-PERP" })], readiness: [] });
    const html = render(h(PortfolioTable, { rows, sortKey: "symbol", direction: "asc", state: STATE }));
    assertClean(html);
    expect(html).toContain("SOL-PERP");
  });
});

describe("portfolio table — accessible sort state", () => {
  const rows = buildTableRows({
    perSymbol: makeAllocation().perSymbol,
    bySymbol: makeExposure().bySymbol,
    decisions: [makeDecision({ symbol: "BTC-PERP" })],
    readiness: [makeReadinessRow({ symbol: "BTC-PERP" })],
  });

  it("marks the active column with aria-sort and the arrow glyph as decorative", () => {
    const html = render(h(PortfolioTable, { rows, sortKey: "confidence", direction: "desc", state: STATE }));
    // Exactly one descending column, the rest sortable-but-unsorted.
    expect(html).toContain('aria-sort="descending"');
    expect(html.match(/aria-sort="descending"/g)).toHaveLength(1);
    expect(html).toContain('aria-sort="none"');
    // The direction arrow is hidden from assistive tech (sort state is announced via aria-sort).
    expect(html).toContain('aria-hidden="true"');
    // Sort buttons carry an explicit label.
    expect(html).toContain("Sort by");
    assertClean(html);
  });

  it("ascending direction is announced and is deterministic across renders", () => {
    const a = render(h(PortfolioTable, { rows, sortKey: "symbol", direction: "asc", state: STATE }));
    const b = render(h(PortfolioTable, { rows, sortKey: "symbol", direction: "asc", state: STATE }));
    expect(a).toBe(b); // pure, props-only render
    expect(a).toContain('aria-sort="ascending"');
    expect(a.match(/aria-sort="ascending"/g)).toHaveLength(1);
  });
});

describe("portfolio panels — degraded poll state (stale error)", () => {
  it("renders the stale banner without crashing", () => {
    const errState: PanelPollState = { loading: false, error: "summary: HTTP 500", lastUpdated: 1_700_000_000_000 };
    const cards = buildSummaryCards(makeSummary());
    const meters = buildCapitalMeter(makeSummary());
    const html = render(h(PortfolioSummaryPanel, { cards, capital: meters.capital, risk: meters.risk, state: errState }));
    expect(html).toContain("stale");
    expect(html).not.toContain("NaN");
  });
});
