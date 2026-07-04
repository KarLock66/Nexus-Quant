import { describe, expect, it } from "vitest";
import { buildExecutionIntent } from "./intent.js";
import { checkSubmittable, isSubmittable, validateInput } from "./validation.js";
import { makeDecision, makeExecInput, makeFlatDecision, makePlan, NOW } from "./test-fixtures.js";
import type { ExecutionIntent } from "./types.js";

function intentFor(decision = makeDecision()): ExecutionIntent {
  return buildExecutionIntent(decision, makePlan(decision), { now: NOW });
}

describe("validateInput — fail-closed input gate", () => {
  it("NO_DECISION when the decision is absent", () => {
    expect(validateInput(makeExecInput({ decision: null }))).toBe("NO_DECISION");
  });
  it("NO_PLAN when the plan is absent", () => {
    expect(validateInput(makeExecInput({ plan: null }))).toBe("NO_PLAN");
  });
  it("passes (null) when both are present", () => {
    expect(validateInput(makeExecInput())).toBeNull();
  });
});

describe("checkSubmittable — fail-closed submit gate", () => {
  it("green directional intent is submittable", () => {
    expect(checkSubmittable(intentFor())).toBeNull();
    expect(isSubmittable(intentFor())).toBe(true);
  });

  it("BLOCKED when the served plan says no-trade / cannot-trade", () => {
    expect(checkSubmittable(intentFor(makeFlatDecision()))).toBe("BLOCKED");
  });

  it("MISSING_READINESS when readiness was never scored", () => {
    const base = intentFor();
    const intent: ExecutionIntent = { ...base, readinessScore: null, readinessBand: null };
    expect(checkSubmittable(intent)).toBe("MISSING_READINESS");
  });

  it("MISSING_ENTRY / MISSING_STOP / MISSING_TARGET in deterministic order", () => {
    const base = intentFor();
    expect(checkSubmittable({ ...base, entry: null })).toBe("MISSING_ENTRY");
    expect(checkSubmittable({ ...base, stop: null })).toBe("MISSING_STOP");
    expect(checkSubmittable({ ...base, targets: [] })).toBe("MISSING_TARGET");
  });

  it("gating is checked before individual levels (BLOCKED wins over a missing level)", () => {
    const base = intentFor();
    const intent: ExecutionIntent = { ...base, canTrade: false, entry: null };
    expect(checkSubmittable(intent)).toBe("BLOCKED");
  });
});
