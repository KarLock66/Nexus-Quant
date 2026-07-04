import { describe, expect, it } from "vitest";
import { createExecution } from "./execution.js";
import { makeExecInput, makeFlatDecision, makePlan } from "./test-fixtures.js";

describe("createExecution — orchestration + fail-closed guards", () => {
  it("no decision → NO_DECISION, no state built", () => {
    const res = createExecution(makeExecInput({ decision: null }));
    expect(res.ok).toBe(false);
    expect(res.state).toBeNull();
    expect(res.failure?.reason).toBe("NO_DECISION");
  });

  it("no plan → NO_PLAN, no state built", () => {
    const res = createExecution(makeExecInput({ plan: null }));
    expect(res.ok).toBe(false);
    expect(res.state).toBeNull();
    expect(res.failure?.reason).toBe("NO_PLAN");
  });

  it("green input → PLANNED state with a submittable plan and a PLAN audit event", () => {
    const res = createExecution(makeExecInput());
    expect(res.ok).toBe(true);
    expect(res.state?.status).toBe("PLANNED");
    expect(res.state?.plan?.submittable).toBe(true);
    expect(res.state?.audit.count).toBe(1);
    expect(res.state?.audit.events[0]?.type).toBe("PLANNED");
    expect(res.state?.mode).toBe("SIMULATION");
    expect(res.state?.venue).toBe("SIMULATED");
  });

  it("kill switch engaged → immediate CANCELLED", () => {
    const res = createExecution(makeExecInput({ killEngaged: true }));
    expect(res.state?.status).toBe("CANCELLED");
    expect(res.state?.failure?.reason).toBe("KILL_SWITCH");
  });

  it("runtime unhealthy → FAILED", () => {
    const res = createExecution(makeExecInput({ runtimeHealthy: false }));
    expect(res.state?.status).toBe("FAILED");
    expect(res.state?.failure?.reason).toBe("RUNTIME_UNHEALTHY");
  });

  it("kill switch takes priority over an unhealthy runtime", () => {
    const res = createExecution(makeExecInput({ killEngaged: true, runtimeHealthy: false }));
    expect(res.state?.status).toBe("CANCELLED");
  });

  it("a FLAT decision still PLANS but is not submittable (blocked)", () => {
    const flat = makeFlatDecision();
    const res = createExecution(makeExecInput({ decision: flat, plan: makePlan(flat) }));
    expect(res.state?.status).toBe("PLANNED");
    expect(res.state?.plan?.submittable).toBe(false);
    expect(res.state?.plan?.blockedReason).toBe("BLOCKED");
  });
});
