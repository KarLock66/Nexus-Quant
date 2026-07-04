import { describe, expect, it } from "vitest";
import { buildExecutionIntent } from "./intent.js";
import { buildExecutionPlan } from "./plan.js";
import { makeDecision, makeFlatDecision, makePlan, makeShortDecision, NOW } from "./test-fixtures.js";

function intentFor(decision = makeDecision()) {
  return buildExecutionIntent(decision, makePlan(decision), { now: NOW });
}

describe("buildExecutionPlan — order-set derivation", () => {
  it("produces one ENTRY, one STOP and one TARGET per served take-profit", () => {
    const plan = buildExecutionPlan(intentFor());
    const roles = plan.orders.map((o) => o.role);
    expect(roles.filter((r) => r === "ENTRY").length).toBe(1);
    expect(roles.filter((r) => r === "STOP").length).toBe(1);
    expect(roles.filter((r) => r === "TARGET").length).toBe(3);
  });

  it("prices are VERBATIM from the intent levels", () => {
    const plan = buildExecutionPlan(intentFor());
    expect(plan.orders.find((o) => o.role === "ENTRY")?.price).toBe(100);
    expect(plan.orders.find((o) => o.role === "STOP")?.price).toBe(97);
    expect(plan.orders.filter((o) => o.role === "TARGET").map((o) => o.price)).toEqual([103, 106, 109]);
  });

  it("splits the VERBATIM position size across targets, remainder to the last (sum preserved)", () => {
    const plan = buildExecutionPlan(intentFor());
    const targetQtys = plan.orders.filter((o) => o.role === "TARGET").map((o) => o.quantity ?? 0);
    expect(targetQtys.reduce((a, b) => a + b, 0)).toBeCloseTo(0.6, 8);
    expect(plan.totalQuantity).toBe(0.6);
  });

  it("LONG → entry BUY, protective SELL; SHORT → entry SELL, protective BUY", () => {
    const long = buildExecutionPlan(intentFor(makeDecision()));
    expect(long.orders.find((o) => o.role === "ENTRY")?.side).toBe("BUY");
    expect(long.orders.find((o) => o.role === "STOP")?.side).toBe("SELL");
    const short = buildExecutionPlan(intentFor(makeShortDecision()));
    expect(short.orders.find((o) => o.role === "ENTRY")?.side).toBe("SELL");
    expect(short.orders.find((o) => o.role === "STOP")?.side).toBe("BUY");
  });

  it("green directional plan is submittable", () => {
    const plan = buildExecutionPlan(intentFor());
    expect(plan.submittable).toBe(true);
    expect(plan.blockedReason).toBeNull();
  });

  it("FLAT plan is NOT submittable, blockedReason explains WHY, orders carry UNAVAILABLE prices", () => {
    const flat = makeFlatDecision();
    const plan = buildExecutionPlan(intentFor(flat));
    expect(plan.submittable).toBe(false);
    expect(plan.blockedReason).toBe("BLOCKED");
    expect(plan.orders.find((o) => o.role === "ENTRY")?.provenance).toBe("UNAVAILABLE");
  });

  it("has deterministic order ids and is replay-stable", () => {
    const a = buildExecutionPlan(intentFor());
    const b = buildExecutionPlan(intentFor());
    expect(a.orders.map((o) => o.orderId)).toEqual([
      "exec:sig-1:plan:ord:entry:0",
      "exec:sig-1:plan:ord:stop:1",
      "exec:sig-1:plan:ord:target:2",
      "exec:sig-1:plan:ord:target:3",
      "exec:sig-1:plan:ord:target:4",
    ]);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});
