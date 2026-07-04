import { describe, expect, it } from "vitest";
import { buildRiskChecklist } from "./risk-checklist.js";
import { makeDecision, makeFlat, makeInputs, m } from "./test-fixtures.js";
import type { RiskChecklist, RiskField } from "./types.js";

const VALID_TAGS = ["REAL", "DERIVED", "ESTIMATED", "UNAVAILABLE"];

function allFields(r: RiskChecklist): RiskField[] {
  return [r.maximumLoss, r.capitalAtRisk, r.rMultiple, r.distancePct, r.atrPct, r.rewardPct, r.expectedHoldSeconds];
}

describe("buildRiskChecklist — Section C", () => {
  it("computes maximum loss = size × |entry − stop| (DERIVED)", () => {
    const r = buildRiskChecklist(makeInputs()); // size 0.5, entry 100, stop 97
    expect(r.maximumLoss.value).toBeCloseTo(1.5, 6);
    expect(r.maximumLoss.tag).toBe("DERIVED");
    expect(r.maximumLoss.unit).toBe("$");
  });

  it("recovers ATR% and reward% from the served levels", () => {
    const r = buildRiskChecklist(makeInputs()); // atr = 3/1.5 = 2 → 2% ; reward = 3/100 = 3%
    expect(r.atrPct.value).toBeCloseTo(2, 6);
    expect(r.rewardPct.value).toBeCloseTo(3, 6);
  });

  it("carries R multiple / distance / capital-at-risk verbatim from the decision", () => {
    const r = buildRiskChecklist(makeInputs());
    expect(r.rMultiple.value).toBe(3);
    expect(r.distancePct.value).toBe(3);
    expect(r.capitalAtRisk.value).toBe(1);
  });

  it("bands the risk category from the stop distance", () => {
    expect(buildRiskChecklist(makeInputs({ decision: makeDecision({ stopDistancePct: m(1) }) })).category.label).toBe("TIGHT");
    expect(buildRiskChecklist(makeInputs()).category.label).toBe("NORMAL"); // 3%
    expect(buildRiskChecklist(makeInputs({ decision: makeDecision({ stopDistancePct: m(6) }) })).category.label).toBe("WIDE");
    expect(buildRiskChecklist(makeInputs({ decision: makeDecision({ stopDistancePct: m(12) }) })).category.label).toBe("VERY_WIDE");
  });

  it("category cut-points are config-driven (not hidden) — a wider TIGHT band re-labels 3%", () => {
    expect(buildRiskChecklist(makeInputs({ config: { riskTightBelowPct: 5 } })).category.label).toBe("TIGHT");
  });

  it("every numeric field is UNAVAILABLE (null) for a FLAT decision — never fabricated", () => {
    const r = buildRiskChecklist(makeInputs({ decision: makeFlat() }));
    for (const f of allFields(r)) {
      expect(f.value).toBeNull();
      expect(f.tag).toBe("UNAVAILABLE");
    }
    expect(r.category.tag).toBe("UNAVAILABLE");
  });

  it("only ever tags fields with the Section-C tag set and never emits a NaN", () => {
    for (const inputs of [makeInputs(), makeInputs({ decision: makeFlat() })]) {
      const r = buildRiskChecklist(inputs);
      for (const f of [...allFields(r)]) {
        expect(VALID_TAGS).toContain(f.tag);
        if (f.value !== null) expect(Number.isFinite(f.value)).toBe(true);
      }
    }
  });
});
