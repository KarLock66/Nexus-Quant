import { describe, expect, it } from "vitest";
import {
  validateAcknowledge,
  validateCancel,
  validateCancelAll,
  validateFill,
  validateSubmit,
} from "./validation.js";
import { PaperExecutionAdapter } from "./paper.js";
import { makeFlatDecision, makePaperSession, makeRuntime, NOW, orderIds } from "./test-fixtures.js";
import type { AdapterSession } from "./types.js";

const submitCmd = (over = {}) => ({ type: "SUBMIT" as const, at: NOW, runtime: makeRuntime(), ...over });

describe("validateSubmit — fail-closed gate order", () => {
  it("passes (null) on a fresh green session", () => {
    expect(validateSubmit(makePaperSession(), submitCmd())).toBeNull();
  });

  it("ADAPTER_SHUTDOWN when the adapter is shut down", () => {
    const s = PaperExecutionAdapter.shutdown(makePaperSession(), { type: "SHUTDOWN", at: NOW }).session;
    expect(validateSubmit(s, submitCmd())).toBe("ADAPTER_SHUTDOWN");
  });

  it("NOT_BOUND when no core state is attached", () => {
    const s: AdapterSession = { ...makePaperSession(), core: null };
    expect(validateSubmit(s, submitCmd())).toBe("NOT_BOUND");
  });

  it("TERMINAL when the execution is already terminal", () => {
    const s = PaperExecutionAdapter.cancelAll(makePaperSession(), { type: "CANCEL_ALL", at: NOW }).session;
    expect(validateSubmit(s, submitCmd())).toBe("TERMINAL");
  });

  it("DUPLICATE_SUBMIT after a successful submit", () => {
    const s = PaperExecutionAdapter.submit(makePaperSession(), submitCmd()).session;
    expect(validateSubmit(s, submitCmd())).toBe("DUPLICATE_SUBMIT");
  });

  it("KILL_SWITCH when the runtime snapshot has kill engaged", () => {
    expect(validateSubmit(makePaperSession(), submitCmd({ runtime: makeRuntime({ killEngaged: true }) }))).toBe(
      "KILL_SWITCH",
    );
  });

  it("RUNTIME_UNHEALTHY when the runtime is not HEALTHY", () => {
    expect(validateSubmit(makePaperSession(), submitCmd({ runtime: makeRuntime({ state: "UNHEALTHY" }) }))).toBe(
      "RUNTIME_UNHEALTHY",
    );
    expect(validateSubmit(makePaperSession(), submitCmd({ runtime: makeRuntime({ state: "DEGRADED" }) }))).toBe(
      "RUNTIME_UNHEALTHY",
    );
    expect(validateSubmit(makePaperSession(), submitCmd({ runtime: makeRuntime({ state: "UNKNOWN" }) }))).toBe(
      "RUNTIME_UNHEALTHY",
    );
  });

  it("BLOCKED (from the plan) when the served plan is not submittable", () => {
    expect(validateSubmit(makePaperSession(makeFlatDecision()), submitCmd())).toBe("BLOCKED");
  });

  it("kill takes priority over an unhealthy runtime", () => {
    const runtime = makeRuntime({ killEngaged: true, state: "UNHEALTHY" });
    expect(validateSubmit(makePaperSession(), submitCmd({ runtime }))).toBe("KILL_SWITCH");
  });

  it("terminal/duplicate are checked before the runtime snapshot", () => {
    const s = PaperExecutionAdapter.cancelAll(makePaperSession(), { type: "CANCEL_ALL", at: NOW }).session;
    expect(validateSubmit(s, submitCmd({ runtime: makeRuntime({ killEngaged: true }) }))).toBe("TERMINAL");
  });
});

describe("validateAcknowledge", () => {
  it("NOT_SUBMITTED before a submit", () => {
    expect(validateAcknowledge(makePaperSession())).toBe("NOT_SUBMITTED");
  });
  it("passes after submit", () => {
    const s = PaperExecutionAdapter.submit(makePaperSession(), submitCmd()).session;
    expect(validateAcknowledge(s)).toBeNull();
  });
});

describe("validateFill", () => {
  function submitted(): AdapterSession {
    return PaperExecutionAdapter.submit(makePaperSession(), submitCmd()).session;
  }
  it("NOT_SUBMITTED before a submit", () => {
    const ids = orderIds(makePaperSession());
    expect(validateFill(makePaperSession(), { type: "FILL", at: NOW, orderId: ids.entry, price: 100, quantity: 0.1 })).toBe(
      "NOT_SUBMITTED",
    );
  });
  it("UNKNOWN_ORDER for an order not in the plan", () => {
    expect(validateFill(submitted(), { type: "FILL", at: NOW, orderId: "nope", price: 100, quantity: 0.1 })).toBe(
      "UNKNOWN_ORDER",
    );
  });
  it("VALIDATION_FAILED for a non-positive quantity", () => {
    const ids = orderIds(makePaperSession());
    expect(validateFill(submitted(), { type: "FILL", at: NOW, orderId: ids.entry, price: 100, quantity: 0 })).toBe(
      "VALIDATION_FAILED",
    );
  });
  it("VALIDATION_FAILED for a non-finite price", () => {
    const ids = orderIds(makePaperSession());
    expect(
      validateFill(submitted(), { type: "FILL", at: NOW, orderId: ids.entry, price: Number.NaN, quantity: 0.1 }),
    ).toBe("VALIDATION_FAILED");
  });
  it("passes for a known order with a positive quantity + finite price", () => {
    const ids = orderIds(makePaperSession());
    expect(validateFill(submitted(), { type: "FILL", at: NOW, orderId: ids.entry, price: 100, quantity: 0.1 })).toBeNull();
  });
});

describe("validateCancel / validateCancelAll", () => {
  it("cancel UNKNOWN_ORDER for a foreign order id", () => {
    expect(validateCancel(makePaperSession(), { type: "CANCEL", at: NOW, orderId: "nope" })).toBe("UNKNOWN_ORDER");
  });
  it("cancel passes for a known order", () => {
    const ids = orderIds(makePaperSession());
    expect(validateCancel(makePaperSession(), { type: "CANCEL", at: NOW, orderId: ids.entry })).toBeNull();
  });
  it("cancelAll passes on a live execution", () => {
    expect(validateCancelAll(makePaperSession())).toBeNull();
  });
  it("cancelAll TERMINAL once cancelled", () => {
    const s = PaperExecutionAdapter.cancelAll(makePaperSession(), { type: "CANCEL_ALL", at: NOW }).session;
    expect(validateCancelAll(s)).toBe("TERMINAL");
  });
});
