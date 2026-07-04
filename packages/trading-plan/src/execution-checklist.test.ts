import { describe, expect, it } from "vitest";
import { buildExecutionChecklist } from "./execution-checklist.js";
import { makeDecision, makeFlat, makeInputs, m, na } from "./test-fixtures.js";
import type { CheckStatus } from "./types.js";

const status = (items: { id: string; status: CheckStatus }[], id: string): CheckStatus =>
  items.find((i) => i.id === id)?.status ?? "UNKNOWN";

describe("buildExecutionChecklist — Section B", () => {
  it("all ten checks PASS for a fully-green directional decision", () => {
    const c = buildExecutionChecklist(makeInputs());
    expect(c.items).toHaveLength(10);
    expect(c.passed).toBe(10);
    expect(c.failed).toBe(0);
    expect(c.unknown).toBe(0);
    expect(c.allPass).toBe(true);
  });

  it("directional check FAILs for a FLAT signal", () => {
    const c = buildExecutionChecklist(makeInputs({ decision: makeFlat() }));
    expect(status(c.items, "directional")).toBe("FAIL");
    expect(c.allPass).toBe(false);
  });

  it("liquidity is UNKNOWN (not FAIL) when no order-book snapshot exists", () => {
    const c = buildExecutionChecklist(makeInputs({ decision: makeDecision({ liquidityScore: na() }) }));
    expect(status(c.items, "liquidity")).toBe("UNKNOWN");
  });

  it("volatility is inverted — a HIGH score FAILs 'acceptable'", () => {
    const c = buildExecutionChecklist(makeInputs({ decision: makeDecision({ volatilityScore: m(80) }) }));
    expect(status(c.items, "volatility")).toBe("FAIL");
    const ok = buildExecutionChecklist(makeInputs({ decision: makeDecision({ volatilityScore: m(20) }) }));
    expect(status(ok.items, "volatility")).toBe("PASS");
  });

  it("control / risk / runtime FAIL or UNKNOWN fail-closed", () => {
    const blocked = buildExecutionChecklist(
      makeInputs({ decision: makeDecision({ controlStatus: "BLOCKED" }) }),
    );
    expect(status(blocked.items, "control")).toBe("FAIL");

    const unknownControl = buildExecutionChecklist(
      makeInputs({ decision: makeDecision({ controlStatus: "UNKNOWN" }) }),
    );
    expect(status(unknownControl.items, "control")).toBe("UNKNOWN");

    const noRuntime = buildExecutionChecklist(makeInputs({ runtimeState: null }));
    expect(status(noRuntime.items, "runtime")).toBe("UNKNOWN");
  });

  it("data quality FAILs below the floor and is UNKNOWN when absent", () => {
    expect(status(buildExecutionChecklist(makeInputs({ dqScore: 50 })).items, "dataQuality")).toBe("FAIL");
    expect(status(buildExecutionChecklist(makeInputs({ dqScore: null })).items, "dataQuality")).toBe("UNKNOWN");
    expect(status(buildExecutionChecklist(makeInputs({ dqScore: 95 })).items, "dataQuality")).toBe("PASS");
  });

  it("freshness FAILs when stale and UNKNOWN when an age is missing", () => {
    expect(
      status(buildExecutionChecklist(makeInputs({ decision: makeDecision({ signalAgeSeconds: 99_999 }) })).items, "freshness"),
    ).toBe("FAIL");
    expect(
      status(buildExecutionChecklist(makeInputs({ decision: makeDecision({ featureAgeSeconds: null }) })).items, "freshness"),
    ).toBe("UNKNOWN");
  });

  it("freshness provenance fails closed to 'unavailable' when an age source is absent", () => {
    const items = buildExecutionChecklist(makeInputs({ decision: makeDecision({ featureAgeSeconds: null }) })).items;
    const fresh = items.find((i) => i.id === "freshness");
    expect(fresh?.status).toBe("UNKNOWN");
    expect(fresh?.provenance).toBe("unavailable"); // never claims a "real" source it doesn't have
    // with both ages present it is a real observation
    expect(buildExecutionChecklist(makeInputs()).items.find((i) => i.id === "freshness")?.provenance).toBe("real");
  });

  it("every item carries a non-empty detail and a provenance tag", () => {
    for (const it of buildExecutionChecklist(makeInputs()).items) {
      expect(it.detail.length).toBeGreaterThan(0);
      expect(["verbatim", "real", "derived", "estimated", "unavailable"]).toContain(it.provenance);
    }
  });
});
