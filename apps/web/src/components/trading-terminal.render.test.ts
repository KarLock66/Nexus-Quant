import { describe, expect, it } from "vitest";
import { createElement as h, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { makeDecision, makeFlat, makeRankedRow } from "@/lib/terminal-fixtures";
import {
  entryZone,
  setupGrade,
  winProbability,
  type PanelLiveStatus,
} from "@/lib/terminal-derivations";
import type { PanelPollState } from "./console-ui";
import {
  AiExplainPanel,
  MarketAnalysisPanel,
  MarketOverviewPanel,
  OpportunityBoardPanel,
  TradePlanPanel,
  type SortedBoard,
} from "./trading-terminal";
import type { TradingDecision } from "@/lib/trading-decision-types";

/**
 * UI render tests — Phase 10A-2. Renders the five terminal panels to static markup via
 * react-dom/server (no jsdom/RTL dependency, matching the repo's node-env vitest). The
 * core fail-closed assertion: across populated, FLAT (no levels), blocked, and missing-
 * price fixtures, NO panel ever emits "NaN" or a literal "undefined" — unavailable data
 * renders as "—" / "n/a" with provenance intact.
 */

const STATE: PanelPollState = { loading: false, error: null, lastUpdated: 1_700_000_000_000 };

function render(el: ReactElement): string {
  return renderToStaticMarkup(el);
}

/** Every panel's markup must be non-empty and free of NaN / literal undefined. */
function assertClean(html: string) {
  expect(html.length).toBeGreaterThan(10);
  expect(html).not.toContain("NaN");
  expect(html).not.toContain("undefined");
  expect(html).not.toContain("null<"); // a raw null leaking as text
}

function renderAllPanels(d: TradingDecision, dqScore: number | null, live: PanelLiveStatus): string {
  const grade = setupGrade(d);
  const prob = winProbability(d);
  const zone = entryZone(d);
  return [
    render(h(MarketOverviewPanel, { d, grade, prob, runtimeState: "HEALTHY", live, state: STATE })),
    render(h(TradePlanPanel, { d, zone, live, state: STATE })),
    render(h(AiExplainPanel, { d, live, state: STATE, withConsensus: false })),
    render(h(MarketAnalysisPanel, { d, dqScore, live, state: STATE })),
  ].join("\n");
}

describe("terminal panels — populated LONG decision", () => {
  const html = renderAllPanels(makeDecision(), 98, "LIVE");

  it("renders cleanly with no NaN / undefined", () => assertClean(html));

  it("shows the symbol, grade, prices and DQ", () => {
    expect(html).toContain("BTC-PERP");
    expect(html).toContain("A+"); // strong setup grade
    expect(html).toContain("103"); // TP1
    expect(html).toContain("98/100"); // DQ score
    expect(html).toContain("EXCELLENT"); // DQ band
  });

  it("labels the win probability as an estimate", () => {
    expect(html.toLowerCase()).toContain("estimate");
  });

  it("tags the derived DQ band DERIVED, not REAL (provenance honesty)", () => {
    // The score is a real observed value; the EXCELLENT/GOOD/FAIR/POOR band is a
    // deterministic categorization of it — so the band Stat must read DERIVED, not REAL.
    const ma = render(h(MarketAnalysisPanel, { d: makeDecision(), dqScore: 98, live: "LIVE", state: STATE }));
    expect(ma).toContain("EXCELLENT"); // the band itself rendered
    // The provenance tag immediately following the "Data Quality" label is the band's tag.
    const after = ma.slice(ma.indexOf("Data Quality"));
    const firstTag = after.match(/VERBATIM|REAL|DERIVED|EST|N\/A/);
    expect(firstTag?.[0]).toBe("DERIVED");
  });
});

describe("terminal panels — FLAT decision (no levels, demo seed-42 reality)", () => {
  const html = renderAllPanels(makeFlat(), 88, "BLOCKED");

  it("renders cleanly with no NaN / undefined", () => assertClean(html));

  it("shows unavailable levels as dashes, never fabricated prices", () => {
    expect(html).toContain("BTC-PERP");
    expect(html).toContain("F"); // FLAT graded F
    // R:R visual fails closed to its placeholder
    expect(html).toContain("R:R visual unavailable");
  });
});

describe("terminal panels — missing price (signal present, no fresh mark)", () => {
  const noPrice = makeDecision({
    currentPrice: { value: null, provenance: "unavailable", basis: "no mark" },
    entryPrice: { value: null, provenance: "unavailable", basis: "no mark" },
    stopLoss: { value: null, provenance: "unavailable", basis: "no mark" },
    takeProfit1: { value: null, provenance: "unavailable", basis: "no mark" },
    takeProfit2: { value: null, provenance: "unavailable", basis: "no mark" },
    takeProfit3: { value: null, provenance: "unavailable", basis: "no mark" },
    riskRewardRatio: { value: null, provenance: "unavailable", basis: "no mark" },
    overallStatus: "INCOMPLETE",
  });
  const html = renderAllPanels(noPrice, null, "WAITING");

  it("renders cleanly with no NaN / undefined and shows UNKNOWN DQ", () => {
    assertClean(html);
    expect(html).toContain("UNKNOWN");
  });
});

describe("Opportunity Board panel", () => {
  const board: SortedBoard = {
    topLong: [makeRankedRow({ symbol: "BTC-PERP" }), makeRankedRow({ symbol: "ETH-PERP", confidence: 0.7 })],
    topShort: [],
    watchlist: [makeRankedRow({ symbol: "SOL-PERP", riskReward: null })],
    blocked: [],
    waiting: [],
    total: 3,
    note: "3 active decisions ranked",
  };

  it("renders sortable columns cleanly", () => {
    const html = render(
      h(OpportunityBoardPanel, { board, sortKey: "rank", selected: "BTC-PERP", live: "LIVE", state: STATE }),
    );
    assertClean(html);
    expect(html).toContain("Top Long");
    expect(html).toContain("Signal Age"); // sort control present
    expect(html).toContain("BTC-PERP");
    expect(html).toContain("rr —"); // null R:R renders as dash, not NaN
  });

  it("renders a null board (still loading) without crashing", () => {
    const html = render(
      h(OpportunityBoardPanel, { board: null, sortKey: "rank", selected: null, live: "UNAVAILABLE", state: STATE }),
    );
    expect(html).toContain("Opportunity Board");
    expect(html).not.toContain("NaN");
  });
});
