import { describe, expect, it } from "vitest";
import { createElement as h, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { buildTradePlan } from "@nexus/trading-plan";
import { makeDecision, makeFlat } from "@/lib/terminal-fixtures";
import type { PanelPollState } from "./console-ui";
import {
  DecisionSummaryPanel,
  ExecutionChecklistPanel,
  InvalidationPanel,
  ReadinessPanel,
  RiskChecklistPanel,
} from "./decision-terminal";

/**
 * UI render tests — Phase 10C-1. Renders the five decision panels to static markup via
 * react-dom/server (no jsdom/RTL — matches the repo's node-env vitest). The core fail-closed
 * assertion: across a populated LONG plan, a FLAT plan (no levels), and a blocked plan, NO
 * panel ever emits "NaN" or a literal "undefined" — unavailable data renders as "—" / N/A.
 */

const STATE: PanelPollState = { loading: false, error: null, lastUpdated: 1_700_000_000_000 };
const NOW = 1_700_000_000_000;

function render(el: ReactElement): string {
  return renderToStaticMarkup(el);
}

function assertClean(html: string) {
  expect(html.length).toBeGreaterThan(10);
  expect(html).not.toContain("NaN");
  expect(html).not.toContain("undefined");
  expect(html).not.toContain("null<");
}

function plan(decision = makeDecision(), opts: { dqScore?: number | null; runtimeState?: string | null; killEngaged?: boolean } = {}) {
  return buildTradePlan({
    now: NOW,
    decision,
    dqScore: opts.dqScore ?? 98,
    runtimeState: opts.runtimeState ?? "HEALTHY",
    killEngaged: opts.killEngaged ?? false,
  });
}

function renderAll(p: ReturnType<typeof buildTradePlan>): string {
  return [
    render(h(DecisionSummaryPanel, { symbol: p.symbol, timeframe: p.timeframe, summary: p.summary, state: STATE })),
    render(h(ExecutionChecklistPanel, { execution: p.execution, state: STATE })),
    render(h(RiskChecklistPanel, { risk: p.risk, state: STATE })),
    render(h(InvalidationPanel, { invalidation: p.invalidation, state: STATE })),
    render(h(ReadinessPanel, { readiness: p.readiness, state: STATE })),
  ].join("\n");
}

describe("decision panels — populated STRONG_BUY plan", () => {
  const html = renderAll(plan());

  it("renders cleanly with no NaN / undefined", () => assertClean(html));

  it("shows the action verdict, checklist and readiness", () => {
    expect(html).toContain("BTC-PERP");
    expect(html).toContain("STRONG BUY");
    expect(html).toContain("Maximum loss");
    expect(html).toContain("READY");
    expect(html).toContain("10/10"); // all execution checks pass
  });

  it("tags risk fields with the Section-C provenance set", () => {
    const risk = render(h(RiskChecklistPanel, { risk: plan().risk, state: STATE }));
    expect(risk).toMatch(/REAL|DERIVED|ESTIMATED/);
  });
});

describe("decision panels — FLAT plan (no levels, demo seed-42 reality)", () => {
  const html = renderAll(plan(makeFlat()));

  it("renders cleanly with no NaN / undefined", () => assertClean(html));

  it("shows NO TRADE and unavailable risk figures as dashes, never fabricated", () => {
    expect(html).toContain("NO TRADE");
    expect(html).toContain("UNAVAILABLE"); // risk fields fail closed
    expect(html).toContain("N/A"); // invalidation triggers N/A for FLAT
  });
});

describe("decision panels — blocked plan (kill engaged)", () => {
  const html = renderAll(plan(makeDecision(), { killEngaged: true }));

  it("renders cleanly and shows the trade cannot proceed", () => {
    assertClean(html);
    expect(html).toContain("NO TRADE");
    expect(html).toContain("can trade: no");
  });
});
