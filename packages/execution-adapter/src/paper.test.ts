import { describe, expect, it } from "vitest";
import { PaperExecutionAdapter as P } from "./paper.js";
import { serializeSession } from "./serialization.js";
import {
  makeFlatDecision,
  makePaperSession,
  makeRuntime,
  makeShortDecision,
  NOW,
  orderIds,
} from "./test-fixtures.js";
import type { AdapterSession } from "./types.js";

const submit = (s: AdapterSession, at = NOW, runtime = makeRuntime()) =>
  P.submit(s, { type: "SUBMIT", at, runtime });
const ack = (s: AdapterSession, at = NOW) => P.acknowledge(s, { type: "ACKNOWLEDGE", at });
const fill = (s: AdapterSession, orderId: string, price: number, quantity: number, at = NOW) =>
  P.fill(s, { type: "FILL", at, orderId, price, quantity });

/** Advance a fresh green session to an OPEN position (submit → ack → full entry fill). */
function opened(): AdapterSession {
  const s0 = makePaperSession();
  const ids = orderIds(s0);
  const s1 = submit(s0).session;
  const s2 = ack(s1).session;
  return fill(s2, ids.entry, 100, 0.6).session;
}

describe("paper.submit", () => {
  it("drives ARM→SUBMIT and emits exactly one SUBMITTED event", () => {
    const r = submit(makePaperSession());
    expect(r.ok).toBe(true);
    expect(r.error).toBeNull();
    expect(r.events.map((e) => e.type)).toEqual(["SUBMITTED"]);
    expect(r.session.core?.status).toBe("SUBMITTED");
    expect(r.session.submitted).toBe(true);
  });

  it("emitted event is deterministic (id, seq, adapter, venue)", () => {
    const r = submit(makePaperSession());
    const e = r.events[0]!;
    expect(e.seq).toBe(1);
    expect(e.adapter).toBe("PAPER");
    expect(e.eventId).toBe(`adapter:${r.session.intentId}:evt:1`);
    expect(e.ts).toBe(NOW);
  });

  it("rejects a non-submittable (FLAT) plan with BLOCKED, no core mutation, no events", () => {
    const s = makePaperSession(makeFlatDecision());
    const r = submit(s);
    expect(r.ok).toBe(false);
    expect(r.error?.reason).toBe("BLOCKED");
    expect(r.events).toEqual([]);
    expect(r.session.core?.status).toBe("PLANNED");
    expect(r.session).toBe(s); // unchanged reference on reject
  });

  it("kill switch → CANCELLED event + fail-closed result", () => {
    const r = submit(makePaperSession(), NOW, makeRuntime({ killEngaged: true }));
    expect(r.ok).toBe(false);
    expect(r.error?.reason).toBe("KILL_SWITCH");
    expect(r.events.map((e) => e.type)).toEqual(["CANCELLED"]);
    expect(r.session.core?.status).toBe("CANCELLED");
  });

  it("runtime unhealthy → FAILED event + fatal fail-closed result", () => {
    const r = submit(makePaperSession(), NOW, makeRuntime({ state: "UNHEALTHY" }));
    expect(r.ok).toBe(false);
    expect(r.error?.reason).toBe("RUNTIME_UNHEALTHY");
    expect(r.error?.fatal).toBe(true);
    expect(r.events.map((e) => e.type)).toEqual(["FAILED"]);
    expect(r.session.core?.status).toBe("FAILED");
  });

  it("duplicate submit is rejected (DUPLICATE_SUBMIT)", () => {
    const s1 = submit(makePaperSession()).session;
    const r = submit(s1);
    expect(r.ok).toBe(false);
    expect(r.error?.reason).toBe("DUPLICATE_SUBMIT");
    expect(r.events).toEqual([]);
  });

  it("works for a SHORT decision (mirror side)", () => {
    const r = submit(makePaperSession(makeShortDecision()));
    expect(r.ok).toBe(true);
    expect(r.session.core?.status).toBe("SUBMITTED");
  });
});

describe("paper.acknowledge", () => {
  it("SUBMITTED → ACKNOWLEDGED, emits ACKNOWLEDGED", () => {
    const s = submit(makePaperSession()).session;
    const r = ack(s);
    expect(r.ok).toBe(true);
    expect(r.events.map((e) => e.type)).toEqual(["ACKNOWLEDGED"]);
    expect(r.session.core?.status).toBe("ACKNOWLEDGED");
  });

  it("rejected before submit (NOT_SUBMITTED)", () => {
    const r = ack(makePaperSession());
    expect(r.ok).toBe(false);
    expect(r.error?.reason).toBe("NOT_SUBMITTED");
  });

  it("event seq is monotonic across submit→ack", () => {
    const s1 = submit(makePaperSession()).session;
    const s2 = ack(s1).session;
    expect(s2.events.map((e) => e.seq)).toEqual([1, 2]);
  });
});

describe("paper.fill — entry lifecycle", () => {
  it("full entry fill → FILLED event and auto-opens the position", () => {
    const s0 = makePaperSession();
    const ids = orderIds(s0);
    const s = ack(submit(s0).session).session;
    const r = fill(s, ids.entry, 100, 0.6);
    expect(r.ok).toBe(true);
    expect(r.events.map((e) => e.type)).toEqual(["FILLED"]);
    expect(r.events[0]!.orderId).toBe(ids.entry);
    expect(r.session.core?.status).toBe("OPEN");
    expect(r.session.core?.position?.status).toBe("OPEN");
    expect(r.session.core?.position?.quantity).toBe(0.6);
  });

  it("partial entry fill → PARTIAL_FILL, does not open", () => {
    const s0 = makePaperSession();
    const ids = orderIds(s0);
    const s = ack(submit(s0).session).session;
    const r = fill(s, ids.entry, 100, 0.3);
    expect(r.events.map((e) => e.type)).toEqual(["PARTIAL_FILL"]);
    expect(r.session.core?.status).toBe("PARTIALLY_FILLED");
    expect(r.session.core?.position?.status).toBe("NONE");
  });

  it("two partial fills complete → FILLED then OPEN", () => {
    const s0 = makePaperSession();
    const ids = orderIds(s0);
    let s = ack(submit(s0).session).session;
    s = fill(s, ids.entry, 100, 0.3).session;
    const r = fill(s, ids.entry, 100, 0.3);
    expect(r.events.map((e) => e.type)).toEqual(["FILLED"]);
    expect(r.session.core?.status).toBe("OPEN");
  });

  it("fill before acknowledge fails closed (core ILLEGAL_TRANSITION)", () => {
    const s0 = makePaperSession();
    const ids = orderIds(s0);
    const s = submit(s0).session; // SUBMITTED, not acknowledged
    const r = fill(s, ids.entry, 100, 0.6);
    expect(r.ok).toBe(false);
    expect(r.error?.reason).toBe("ILLEGAL_TRANSITION");
    expect(r.events).toEqual([]);
    expect(r.session).toBe(s);
  });

  it("unknown order rejected UNKNOWN_ORDER", () => {
    const s = ack(submit(makePaperSession()).session).session;
    const r = fill(s, "nope", 100, 0.1);
    expect(r.error?.reason).toBe("UNKNOWN_ORDER");
  });

  it("zero-quantity fill rejected VALIDATION_FAILED", () => {
    const s0 = makePaperSession();
    const ids = orderIds(s0);
    const s = ack(submit(s0).session).session;
    expect(fill(s, ids.entry, 100, 0).error?.reason).toBe("VALIDATION_FAILED");
  });
});

describe("paper.fill — protective reduce/close lifecycle", () => {
  it("target fill on an open position reduces it (PARTIAL_FILL → REDUCING)", () => {
    const s = opened();
    const ids = orderIds(s);
    const r = fill(s, ids.targets[0]!, 103, 0.2);
    expect(r.ok).toBe(true);
    expect(r.events.map((e) => e.type)).toEqual(["PARTIAL_FILL"]);
    expect(r.session.core?.status).toBe("REDUCING");
  });

  it("protective fill of the whole size closes the position (FILLED → CLOSED terminal)", () => {
    const s = opened();
    const ids = orderIds(s);
    const r = fill(s, ids.stop, 97, 0.6);
    expect(r.ok).toBe(true);
    expect(r.events.map((e) => e.type)).toEqual(["FILLED"]);
    expect(r.session.core?.status).toBe("CLOSED");
    expect(r.session.core?.position?.status).toBe("CLOSED");
  });
});

describe("paper.cancel / cancelAll", () => {
  it("cancel is execution-scoped: CANCELLED event has orderId=null (honest blast radius), reason names the order", () => {
    const s0 = makePaperSession();
    const ids = orderIds(s0);
    const r = P.cancel(s0, { type: "CANCEL", at: NOW, orderId: ids.entry });
    expect(r.ok).toBe(true);
    expect(r.events.map((e) => e.type)).toEqual(["CANCELLED"]);
    // The sealed core cancels the WHOLE execution, so the event must not claim a single order.
    expect(r.events[0]!.orderId).toBeNull();
    expect(r.session.core?.status).toBe("CANCELLED");
    // Every order actually moved to a terminal state — confirms the execution-scoped blast radius.
    expect(r.session.core?.orders.every((o) => o.status === "CANCELLED")).toBe(true);
  });

  it("cancelAll emits CANCELLED with no order tag", () => {
    const r = P.cancelAll(makePaperSession(), { type: "CANCEL_ALL", at: NOW });
    expect(r.ok).toBe(true);
    expect(r.events[0]!.orderId).toBeNull();
    expect(r.session.core?.status).toBe("CANCELLED");
  });

  it("cancel of an unknown order fails closed", () => {
    const r = P.cancel(makePaperSession(), { type: "CANCEL", at: NOW, orderId: "nope" });
    expect(r.ok).toBe(false);
    expect(r.error?.reason).toBe("UNKNOWN_ORDER");
  });

  it("cancel of an already-terminal execution is TERMINAL", () => {
    const s = P.cancelAll(makePaperSession(), { type: "CANCEL_ALL", at: NOW }).session;
    const ids = orderIds(s);
    const r = P.cancel(s, { type: "CANCEL", at: NOW, orderId: ids.entry });
    expect(r.error?.reason).toBe("TERMINAL");
  });
});

describe("paper.replace — fail-closed (no live broker)", () => {
  it("always rejects with UNSUPPORTED_OPERATION and never mutates", () => {
    const s = makePaperSession();
    const r = P.replace(s, { type: "REPLACE", at: NOW, orderId: orderIds(s).entry });
    expect(r.ok).toBe(false);
    expect(r.error?.reason).toBe("UNSUPPORTED_OPERATION");
    expect(r.events).toEqual([]);
    expect(r.session).toBe(s);
  });
});

describe("paper.shutdown", () => {
  it("cancels a live execution (CANCELLED) and enters SHUTDOWN", () => {
    const r = P.shutdown(makePaperSession(), { type: "SHUTDOWN", at: NOW });
    expect(r.ok).toBe(true);
    expect(r.events.map((e) => e.type)).toEqual(["CANCELLED"]);
    expect(r.session.status).toBe("SHUTDOWN");
    expect(r.session.core?.status).toBe("CANCELLED");
  });

  it("is idempotent — a second shutdown emits nothing", () => {
    const s = P.shutdown(makePaperSession(), { type: "SHUTDOWN", at: NOW }).session;
    const r = P.shutdown(s, { type: "SHUTDOWN", at: NOW });
    expect(r.ok).toBe(true);
    expect(r.events).toEqual([]);
    expect(r.session.status).toBe("SHUTDOWN");
  });

  it("shutting down an already-terminal execution emits nothing (nothing live to cancel)", () => {
    const s = P.cancelAll(makePaperSession(), { type: "CANCEL_ALL", at: NOW }).session;
    const r = P.shutdown(s, { type: "SHUTDOWN", at: NOW });
    expect(r.ok).toBe(true);
    expect(r.events).toEqual([]);
    expect(r.session.status).toBe("SHUTDOWN");
  });

  it("after shutdown, all mutating ops fail closed with ADAPTER_SHUTDOWN", () => {
    const s = P.shutdown(makePaperSession(), { type: "SHUTDOWN", at: NOW }).session;
    expect(submit(s).error?.reason).toBe("ADAPTER_SHUTDOWN");
    expect(ack(s).error?.reason).toBe("ADAPTER_SHUTDOWN");
    expect(P.cancelAll(s, { type: "CANCEL_ALL", at: NOW }).error?.reason).toBe("ADAPTER_SHUTDOWN");
  });
});

describe("paper.status / health", () => {
  it("status reflects the green plan (5 orders, NONE position, PLANNED)", () => {
    const v = P.status(makePaperSession());
    expect(v.bound).toBe(true);
    expect(v.executionStatus).toBe("PLANNED");
    expect(v.orders).toHaveLength(5);
    expect(v.position?.status).toBe("NONE");
    expect(v.terminal).toBe(false);
  });

  it("status after an open shows the OPEN position", () => {
    const v = P.status(opened());
    expect(v.executionStatus).toBe("OPEN");
    expect(v.position?.status).toBe("OPEN");
    expect(v.submitted).toBe(true);
  });

  it("health READY + canSubmit before submit; not canSubmit after", () => {
    expect(P.health(makePaperSession()).canSubmit).toBe(true);
    const s = submit(makePaperSession()).session;
    const h = P.health(s);
    expect(h.status).toBe("READY");
    expect(h.canSubmit).toBe(false);
    expect(h.submitted).toBe(true);
  });

  it("health after shutdown is SHUTDOWN and cannot submit", () => {
    const s = P.shutdown(makePaperSession(), { type: "SHUTDOWN", at: NOW }).session;
    const h = P.health(s);
    expect(h.status).toBe("SHUTDOWN");
    expect(h.canSubmit).toBe(false);
  });
});

describe("paper — full happy-path lifecycle", () => {
  it("submit → ack → fill → target reduce → stop close, monotonic seq, terminal", () => {
    const s0 = makePaperSession();
    const ids = orderIds(s0);
    let s = submit(s0).session;
    s = ack(s).session;
    s = fill(s, ids.entry, 100, 0.6).session;
    s = fill(s, ids.targets[0]!, 103, 0.2).session;
    const last = fill(s, ids.stop, 97, 0.4);
    s = last.session;
    expect(s.core?.status).toBe("CLOSED");
    expect(s.events.map((e) => e.type)).toEqual(["SUBMITTED", "ACKNOWLEDGED", "FILLED", "PARTIAL_FILL", "FILLED"]);
    expect(s.events.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5]);
    // serialization is stable / non-empty
    expect(serializeSession(s).length).toBeGreaterThan(0);
  });
});
