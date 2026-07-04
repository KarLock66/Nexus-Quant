import { describe, expect, it } from "vitest";
import { buildTradeReadiness } from "./readiness.js";
import { DEFAULT_READINESS_WEIGHTS } from "./types.js";
import { makeDecision, makeFlat, makeInputs } from "./test-fixtures.js";

describe("buildTradeReadiness — Section E", () => {
  it("documented weights sum to exactly 100", () => {
    const sum = Object.values(DEFAULT_READINESS_WEIGHTS).reduce((a, b) => a + b, 0);
    expect(sum).toBe(100);
    const r = buildTradeReadiness(makeInputs());
    expect(r.components.reduce((a, c) => a + c.weight, 0)).toBe(100);
  });

  it("scores a fully-green directional trade READY (≈97.8)", () => {
    const r = buildTradeReadiness(makeInputs());
    expect(r.score).toBeCloseTo(97.8, 1);
    expect(r.band).toBe("READY");
    expect(r.provenance).toBe("derived");
  });

  it("never READY/NEAR for a FLAT signal", () => {
    const r = buildTradeReadiness(makeInputs({ decision: makeFlat() }));
    expect(r.band).not.toBe("READY");
    expect(r.band).not.toBe("NEAR");
    expect(r.score).toBeLessThan(55);
  });

  it("is always within 0..100 and finite across mixed inputs", () => {
    const cases = [
      makeInputs(),
      makeInputs({ decision: makeFlat() }),
      makeInputs({ runtimeState: null, dqScore: null }),
      makeInputs({ killEngaged: true }),
      makeInputs({ decision: makeDecision({ confidence: 5 }) }), // out-of-range conviction → clamped
    ];
    for (const c of cases) {
      const r = buildTradeReadiness(c);
      expect(Number.isFinite(r.score)).toBe(true);
      expect(r.score).toBeGreaterThanOrEqual(0);
      expect(r.score).toBeLessThanOrEqual(100);
      for (const comp of r.components) {
        expect(comp.earned).toBeGreaterThanOrEqual(0);
        expect(comp.earned).toBeLessThanOrEqual(comp.weight);
      }
    }
  });

  it("fail-closed — unknown gates earn 0 points", () => {
    const r = buildTradeReadiness(makeInputs({ runtimeState: null, dqScore: null, decision: makeDecision({ controlStatus: "UNKNOWN" }) }));
    const earned = (k: string) => r.components.find((c) => c.key === k)?.earned ?? -1;
    expect(earned("runtime")).toBe(0);
    expect(earned("dataQuality")).toBe(0);
    expect(earned("control")).toBe(0);
  });

  it("band cut-points are config-driven (not hidden) — a higher readyBand re-bands the same score", () => {
    const base = buildTradeReadiness(makeInputs());
    expect(base.band).toBe("READY"); // ~97.8 with default readyBand 75
    const strict = buildTradeReadiness(makeInputs({ config: { readyBand: 99 } }));
    expect(strict.score).toBe(base.score); // same score …
    expect(strict.band).toBe("NEAR"); // … re-banded by the documented config knob
  });

  it("is deterministic — identical inputs serialize identically", () => {
    expect(JSON.stringify(buildTradeReadiness(makeInputs()))).toBe(JSON.stringify(buildTradeReadiness(makeInputs())));
  });
});
