import { describe, expect, it } from "vitest";
import { NullExecutionAdapter as N } from "./null.js";
import { makeNullSession, makeRuntime, NOW, orderIds } from "./test-fixtures.js";

const s = () => makeNullSession();

describe("null adapter — always fail-closed, never throws, never mutates", () => {
  it("submit refuses with ADAPTER_UNAVAILABLE and no events", () => {
    const r = N.submit(s(), { type: "SUBMIT", at: NOW, runtime: makeRuntime() });
    expect(r.ok).toBe(false);
    expect(r.error?.reason).toBe("ADAPTER_UNAVAILABLE");
    expect(r.events).toEqual([]);
  });

  it("acknowledge refuses", () => {
    expect(N.acknowledge(s(), { type: "ACKNOWLEDGE", at: NOW }).error?.reason).toBe("ADAPTER_UNAVAILABLE");
  });

  it("fill refuses", () => {
    const ids = orderIds(s());
    expect(N.fill(s(), { type: "FILL", at: NOW, orderId: ids.entry, price: 100, quantity: 0.1 }).error?.reason).toBe(
      "ADAPTER_UNAVAILABLE",
    );
  });

  it("cancel refuses", () => {
    const ids = orderIds(s());
    expect(N.cancel(s(), { type: "CANCEL", at: NOW, orderId: ids.entry }).error?.reason).toBe("ADAPTER_UNAVAILABLE");
  });

  it("cancelAll refuses", () => {
    expect(N.cancelAll(s(), { type: "CANCEL_ALL", at: NOW }).error?.reason).toBe("ADAPTER_UNAVAILABLE");
  });

  it("replace refuses", () => {
    const ids = orderIds(s());
    expect(N.replace(s(), { type: "REPLACE", at: NOW, orderId: ids.entry }).error?.reason).toBe("ADAPTER_UNAVAILABLE");
  });

  it("never mutates the core state on any refusal", () => {
    const before = s();
    N.submit(before, { type: "SUBMIT", at: NOW, runtime: makeRuntime() });
    N.cancelAll(before, { type: "CANCEL_ALL", at: NOW });
    expect(before.core?.status).toBe("PLANNED");
    expect(before.events).toEqual([]);
  });

  it("refusals are total — no throw across the whole surface", () => {
    expect(() => {
      N.submit(s(), { type: "SUBMIT", at: NOW, runtime: makeRuntime() });
      N.acknowledge(s(), { type: "ACKNOWLEDGE", at: NOW });
      N.fill(s(), { type: "FILL", at: NOW, orderId: "x", price: 1, quantity: 1 });
      N.cancel(s(), { type: "CANCEL", at: NOW, orderId: "x" });
      N.cancelAll(s(), { type: "CANCEL_ALL", at: NOW });
      N.replace(s(), { type: "REPLACE", at: NOW, orderId: "x" });
    }).not.toThrow();
  });

  it("shutdown is a benign, successful state flip to SHUTDOWN", () => {
    const r = N.shutdown(s(), { type: "SHUTDOWN", at: NOW });
    expect(r.ok).toBe(true);
    expect(r.session.status).toBe("SHUTDOWN");
    expect(r.events).toEqual([]);
  });

  it("health is UNAVAILABLE and cannot submit", () => {
    const h = N.health(s());
    expect(h.kind).toBe("NULL");
    expect(h.status).toBe("UNAVAILABLE");
    expect(h.canSubmit).toBe(false);
  });

  it("status is still a readable projection", () => {
    const v = N.status(s());
    expect(v.bound).toBe(true);
    expect(v.executionStatus).toBe("PLANNED");
    expect(v.orders).toHaveLength(5);
  });
});
