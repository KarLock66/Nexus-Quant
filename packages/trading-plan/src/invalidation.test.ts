import { describe, expect, it } from "vitest";
import { buildInvalidation } from "./invalidation.js";
import { makeDecision, makeFlat, makeInputs, m } from "./test-fixtures.js";
import type { Invalidation, TriggerState } from "./types.js";

const state = (inv: Invalidation, id: string): TriggerState =>
  inv.triggers.find((t) => t.id === id)?.state ?? "NOT_APPLICABLE";

describe("buildInvalidation — Section D", () => {
  it("lists all nine triggers ARMED for a healthy directional trade", () => {
    const inv = buildInvalidation(makeInputs());
    expect(inv.triggers).toHaveLength(9);
    expect(inv.triggered).toBe(0);
    expect(inv.armed).toBe(9);
    expect(inv.summary).toMatch(/armed/i);
  });

  it("collapses every trigger to NOT_APPLICABLE for a FLAT signal", () => {
    const inv = buildInvalidation(makeInputs({ decision: makeFlat() }));
    expect(inv.triggers.every((t) => t.state === "NOT_APPLICABLE")).toBe(true);
    expect(inv.armed).toBe(0);
    expect(inv.triggered).toBe(0);
    expect(inv.summary).toMatch(/FLAT/);
  });

  it("TRIGGERED when control is blocked / risk disabled / data stale", () => {
    expect(state(buildInvalidation(makeInputs({ decision: makeDecision({ controlStatus: "BLOCKED" }) })), "control_blocked")).toBe("TRIGGERED");
    expect(state(buildInvalidation(makeInputs({ decision: makeDecision({ riskStatus: { status: "BLOCKED", reason: "x", staticOnly: true } }) })), "risk_disabled")).toBe("TRIGGERED");
    expect(state(buildInvalidation(makeInputs({ decision: makeDecision({ featureAgeSeconds: 99_999 }) })), "feature_stale")).toBe("TRIGGERED");
    expect(state(buildInvalidation(makeInputs({ dqScore: 10 })), "dq_degraded")).toBe("TRIGGERED");
  });

  it("stop-loss-hit TRIGGERED when the LONG mark is already at/below the stop", () => {
    const d = makeDecision({ currentPrice: m(96, "real"), stopLoss: m(97) }); // mark < stop for a LONG
    expect(state(buildInvalidation(makeInputs({ decision: d })), "stop_hit")).toBe("TRIGGERED");
  });

  it("trend-lost / momentum-reversal / vol-expansion TRIGGER on the score thresholds", () => {
    expect(state(buildInvalidation(makeInputs({ decision: makeDecision({ trendStrength: m(10) }) })), "trend_lost")).toBe("TRIGGERED");
    expect(state(buildInvalidation(makeInputs({ decision: makeDecision({ momentumScore: m(5) }) })), "momentum_reversal")).toBe("TRIGGERED");
    expect(state(buildInvalidation(makeInputs({ decision: makeDecision({ volatilityScore: m(90) }) })), "vol_expansion")).toBe("TRIGGERED");
  });

  it("every trigger carries a description, provenance and basis", () => {
    for (const t of buildInvalidation(makeInputs()).triggers) {
      expect(t.description.length).toBeGreaterThan(0);
      expect(t.basis.length).toBeGreaterThan(0);
      expect(["verbatim", "real", "derived", "estimated", "unavailable"]).toContain(t.provenance);
    }
  });
});
