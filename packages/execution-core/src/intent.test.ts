import { describe, expect, it } from "vitest";
import { buildExecutionIntent } from "./intent.js";
import { makeDecision, makeFlatDecision, makePlan, NOW } from "./test-fixtures.js";

describe("buildExecutionIntent — VERBATIM projection", () => {
  it("copies direction / confidence / levels / RR verbatim from the decision (never recomputed)", () => {
    const d = makeDecision();
    const intent = buildExecutionIntent(d, makePlan(d), { now: NOW });
    expect(intent.direction).toBe("LONG");
    expect(intent.confidence).toBe(0.9);
    expect(intent.entry).toBe(100);
    expect(intent.stop).toBe(97);
    expect(intent.targets).toEqual([103, 106, 109]);
    expect(intent.riskReward).toBe(3);
    expect(intent.positionSize).toBe(0.6);
    expect(intent.provenance.direction).toBe("VERBATIM");
    expect(intent.provenance.entry).toBe("VERBATIM");
  });

  it("carries the plan's action / gates / readiness verbatim", () => {
    const d = makeDecision();
    const intent = buildExecutionIntent(d, makePlan(d), { now: NOW });
    expect(intent.action).toBe("STRONG_BUY");
    expect(intent.canTrade).toBe(true);
    expect(intent.shouldTrade).toBe(true);
    expect(intent.readinessScore).toBe(97.8);
    expect(intent.readinessBand).toBe("READY");
    expect(intent.provenance.readiness).toBe("VERBATIM");
  });

  it("has a deterministic intent id derived from the signal id", () => {
    const d = makeDecision();
    expect(buildExecutionIntent(d, makePlan(d), { now: NOW }).intentId).toBe("exec:sig-1");
  });

  it("FLAT decision → levels UNAVAILABLE, never fabricated", () => {
    const d = makeFlatDecision();
    const intent = buildExecutionIntent(d, makePlan(d), { now: NOW });
    expect(intent.entry).toBeNull();
    expect(intent.stop).toBeNull();
    expect(intent.targets).toEqual([]);
    expect(intent.provenance.entry).toBe("UNAVAILABLE");
    expect(intent.provenance.targets).toBe("UNAVAILABLE");
    expect(intent.action).toBe("NO_TRADE");
    expect(intent.canTrade).toBe(false);
  });

  it("carries the decision's honest provenance notes forward", () => {
    const d = makeDecision();
    const intent = buildExecutionIntent(d, makePlan(d), { now: NOW });
    expect(intent.notes.some((n) => n.includes("single-TF only"))).toBe(true);
  });

  it("flags a plan/decision signal mismatch (fail-closed note, still binds to the decision)", () => {
    const d = makeDecision({ signalId: "sig-A" });
    const plan = makePlan(makeDecision({ signalId: "sig-B" }));
    const intent = buildExecutionIntent(d, plan, { now: NOW });
    expect(intent.signalId).toBe("sig-A");
    expect(intent.notes.some((n) => n.includes("signal mismatch"))).toBe(true);
  });

  it("defaults mode SIMULATION / venue UNSET (no broker in the foundation)", () => {
    const d = makeDecision();
    const intent = buildExecutionIntent(d, makePlan(d), { now: NOW });
    expect(intent.mode).toBe("SIMULATION");
    expect(intent.venue).toBe("UNSET");
  });

  it("is deterministic — identical inputs serialize identically", () => {
    const d = makeDecision();
    const a = buildExecutionIntent(d, makePlan(d), { now: NOW });
    const b = buildExecutionIntent(d, makePlan(d), { now: NOW });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});
