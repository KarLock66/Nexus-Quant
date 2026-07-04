import { describe, expect, it } from "vitest";
import { createExecution } from "./execution.js";
import {
  canTransition,
  initExecutionState,
  isTerminal,
  reduceExecution,
  reduceSequence,
} from "./state.js";
import { buildExecutionIntent } from "./intent.js";
import { buildExecutionPlan } from "./plan.js";
import { makeDecision, makeExecInput, makeFlatDecision, makePlan, NOW } from "./test-fixtures.js";
import type { ExecutionCommand, ExecutionState } from "./types.js";

const ENTRY = "exec:sig-1:plan:ord:entry:0";
const TARGET0 = "exec:sig-1:plan:ord:target:2";

/** A green, PLANNED execution ready to be armed. */
function planned(): ExecutionState {
  const res = createExecution(makeExecInput());
  if (!res.state) throw new Error("expected state");
  return res.state;
}

let clock = NOW;
const at = () => (clock += 1000);

describe("state machine — happy path lifecycle", () => {
  it("drives PLANNED → READY → SUBMITTED → ACKNOWLEDGED → FILLED → OPEN", () => {
    const cmds: ExecutionCommand[] = [
      { type: "ARM", at: at() },
      { type: "SUBMIT", at: at() },
      { type: "ACKNOWLEDGE", at: at() },
      { type: "FILL", at: at(), orderId: ENTRY, price: 100, quantity: 0.6 },
      { type: "OPEN", at: at() },
    ];
    const res = reduceSequence(planned(), cmds);
    expect(res.ok).toBe(true);
    expect(res.state.status).toBe("OPEN");
    expect(res.state.lifecycle.history).toEqual([
      "NOT_CREATED",
      "PLANNED",
      "READY",
      "SUBMITTED",
      "ACKNOWLEDGED",
      "FILLED",
      "OPEN",
    ]);
    expect(res.state.position?.status).toBe("OPEN");
    expect(res.state.position?.quantity).toBe(0.6);
    expect(res.state.position?.avgEntryPrice).toBe(100);
  });

  it("reduces an open position via a TARGET fill and CLOSES when exposure hits zero", () => {
    const open = reduceSequence(planned(), [
      { type: "ARM", at: at() },
      { type: "SUBMIT", at: at() },
      { type: "ACKNOWLEDGE", at: at() },
      { type: "FILL", at: at(), orderId: ENTRY, price: 100, quantity: 0.6 },
      { type: "OPEN", at: at() },
    ]).state;

    const reduced = reduceExecution(open, { type: "FILL", at: at(), orderId: TARGET0, price: 103, quantity: 0.2 });
    expect(reduced.state.status).toBe("REDUCING");
    expect(reduced.state.position?.status).toBe("REDUCING");
    expect(reduced.state.position?.quantity).toBeCloseTo(0.4, 8);

    const closed = reduceExecution(reduced.state, { type: "CLOSE", at: at() });
    expect(closed.state.status).toBe("CLOSED");
    expect(closed.state.position?.status).toBe("CLOSED");
    expect(closed.state.position?.quantity).toBe(0);
    expect(closed.state.lifecycle.terminal).toBe(true);
  });

  it("partial entry fill → PARTIALLY_FILLED, then a second fill completes → FILLED", () => {
    const acked = reduceSequence(planned(), [
      { type: "ARM", at: at() },
      { type: "SUBMIT", at: at() },
      { type: "ACKNOWLEDGE", at: at() },
    ]).state;
    const p1 = reduceExecution(acked, { type: "FILL", at: at(), orderId: ENTRY, price: 100, quantity: 0.25 });
    expect(p1.state.status).toBe("PARTIALLY_FILLED");
    const p2 = reduceExecution(p1.state, { type: "FILL", at: at(), orderId: ENTRY, price: 100, quantity: 0.35 });
    expect(p2.state.status).toBe("FILLED");
    expect(p2.state.orders.find((o) => o.orderId === ENTRY)?.filledQuantity).toBeCloseTo(0.6, 8);
    expect(p2.state.fills.length).toBe(2);
  });
});

describe("state machine — illegal transitions rejected (fail-closed)", () => {
  it("cannot SUBMIT before ARM", () => {
    const res = reduceExecution(planned(), { type: "SUBMIT", at: at() });
    expect(res.ok).toBe(false);
    expect(res.failure?.reason).toBe("ILLEGAL_TRANSITION");
    expect(res.state.status).toBe("PLANNED"); // unchanged
    expect(res.event).toBeNull(); // no phantom event
  });

  it("cannot OPEN before an entry is filled", () => {
    const res = reduceExecution(planned(), { type: "OPEN", at: at() });
    expect(res.ok).toBe(false);
    expect(res.state.status).toBe("PLANNED");
  });

  it("rejects any command out of a terminal state", () => {
    const cancelled = reduceExecution(planned(), { type: "CANCEL", at: at() }).state;
    expect(cancelled.status).toBe("CANCELLED");
    const res = reduceExecution(cancelled, { type: "ARM", at: at() });
    expect(res.ok).toBe(false);
    expect(res.state.status).toBe("CANCELLED");
  });

  it("ARM is rejected when the plan is not submittable (FLAT), with the WHY", () => {
    const res = createExecution(makeExecInput({ decision: makeFlatDecision(), plan: makePlan(makeFlatDecision()) }));
    const armed = reduceExecution(res.state!, { type: "ARM", at: at() });
    expect(armed.ok).toBe(false);
    expect(armed.failure?.reason).toBe("BLOCKED");
    expect(armed.state.status).toBe("PLANNED");
  });
});

describe("state machine — fail-closed operational guards", () => {
  it("kill switch → immediate CANCELLED from any non-terminal state, orders cancelled", () => {
    const open = reduceSequence(planned(), [
      { type: "ARM", at: at() },
      { type: "SUBMIT", at: at() },
      { type: "ACKNOWLEDGE", at: at() },
      { type: "FILL", at: at(), orderId: ENTRY, price: 100, quantity: 0.6 },
      { type: "OPEN", at: at() },
    ]).state;
    const killed = reduceExecution(open, { type: "KILL", at: at() });
    expect(killed.state.status).toBe("CANCELLED");
    expect(killed.state.failure?.reason).toBe("KILL_SWITCH");
    expect(killed.state.position?.status).toBe("CLOSED");
    // Every still-live order is cancelled; an already-FILLED order stays FILLED (can't un-fill).
    expect(killed.state.orders.filter((o) => o.status !== "FILLED").every((o) => o.status === "CANCELLED")).toBe(true);
    expect(killed.state.orders.some((o) => o.role === "ENTRY" && o.status === "FILLED")).toBe(true);
  });

  it("runtime unhealthy → FAILED (fatal)", () => {
    const res = reduceExecution(planned(), { type: "RUNTIME_UNHEALTHY", at: at() });
    expect(res.state.status).toBe("FAILED");
    expect(res.state.failure?.reason).toBe("RUNTIME_UNHEALTHY");
    expect(res.state.failure?.fatal).toBe(true);
  });
});

describe("state machine — FILL validation", () => {
  it("rejects a fill for an unknown order", () => {
    const acked = reduceSequence(planned(), [
      { type: "ARM", at: at() },
      { type: "SUBMIT", at: at() },
      { type: "ACKNOWLEDGE", at: at() },
    ]).state;
    const res = reduceExecution(acked, { type: "FILL", at: at(), orderId: "nope", price: 100, quantity: 1 });
    expect(res.ok).toBe(false);
    expect(res.failure?.reason).toBe("VALIDATION_FAILED");
  });

  it("rejects a non-positive quantity or non-finite price", () => {
    const acked = reduceSequence(planned(), [
      { type: "ARM", at: at() },
      { type: "SUBMIT", at: at() },
      { type: "ACKNOWLEDGE", at: at() },
    ]).state;
    expect(reduceExecution(acked, { type: "FILL", at: at(), orderId: ENTRY, price: 100, quantity: 0 }).ok).toBe(false);
    expect(reduceExecution(acked, { type: "FILL", at: at(), orderId: ENTRY, price: NaN, quantity: 1 }).ok).toBe(false);
  });
});

describe("state machine — helpers + determinism", () => {
  it("isTerminal / canTransition reflect the documented map", () => {
    expect(isTerminal("CLOSED")).toBe(true);
    expect(isTerminal("PLANNED")).toBe(false);
    expect(canTransition("PLANNED", "READY")).toBe(true);
    expect(canTransition("PLANNED", "OPEN")).toBe(false);
  });

  it("does not mutate the input state (pure reducer)", () => {
    const s = planned();
    const snapshot = JSON.stringify(s);
    reduceExecution(s, { type: "ARM", at: at() });
    expect(JSON.stringify(s)).toBe(snapshot);
  });

  it("identical command streams produce byte-identical states (replay)", () => {
    const cmds: ExecutionCommand[] = [
      { type: "ARM", at: 1 },
      { type: "SUBMIT", at: 2 },
      { type: "ACKNOWLEDGE", at: 3 },
      { type: "FILL", at: 4, orderId: ENTRY, price: 100, quantity: 0.6 },
      { type: "OPEN", at: 5 },
    ];
    const a = reduceSequence(planned(), cmds).state;
    const b = reduceSequence(planned(), cmds).state;
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("initExecutionState with no plan starts NOT_CREATED with empty orders", () => {
    const d = makeDecision();
    const intent = buildExecutionIntent(d, makePlan(d), { now: NOW });
    const s = initExecutionState(intent, null);
    expect(s.status).toBe("NOT_CREATED");
    expect(s.orders).toEqual([]);
    // PLAN with no attached plan fails closed.
    expect(reduceExecution(s, { type: "PLAN", at: at() }).failure?.reason).toBe("NO_PLAN");
    // sanity: buildExecutionPlan still produces a plan for the same intent.
    expect(buildExecutionPlan(intent).submittable).toBe(true);
  });
});
