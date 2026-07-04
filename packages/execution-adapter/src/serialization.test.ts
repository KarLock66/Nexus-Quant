import { describe, expect, it } from "vitest";
import { serializeEvents, serializeSession, stableStringify } from "./serialization.js";
import { PaperExecutionAdapter as P } from "./paper.js";
import { makePaperSession, makeRuntime, NOW, orderIds } from "./test-fixtures.js";

describe("stableStringify — sorted keys, fail-closed numbers", () => {
  it("sorts object keys at every depth", () => {
    const a = stableStringify({ b: 1, a: { d: 2, c: 3 } });
    expect(a).toBe('{"a":{"c":3,"d":2},"b":1}');
  });

  it("is insertion-order independent", () => {
    expect(stableStringify({ x: 1, y: 2 })).toBe(stableStringify({ y: 2, x: 1 }));
  });

  it("emits non-finite numbers as null (never NaN / Infinity)", () => {
    expect(stableStringify({ n: Number.NaN, i: Number.POSITIVE_INFINITY })).toBe('{"i":null,"n":null}');
  });

  it("preserves array order (order is semantic)", () => {
    expect(stableStringify([3, 1, 2])).toBe("[3,1,2]");
  });

  it("normalizes undefined to null", () => {
    expect(stableStringify({ a: undefined })).toBe('{"a":null}');
  });
});

describe("serialize — replay byte-identical", () => {
  function run() {
    const s0 = makePaperSession();
    const ids = orderIds(s0);
    let s = P.submit(s0, { type: "SUBMIT", at: NOW, runtime: makeRuntime() }).session;
    s = P.acknowledge(s, { type: "ACKNOWLEDGE", at: NOW }).session;
    s = P.fill(s, { type: "FILL", at: NOW, orderId: ids.entry, price: 100, quantity: 0.6 }).session;
    return s;
  }

  it("two independent identical runs serialize byte-identically", () => {
    expect(serializeSession(run())).toBe(serializeSession(run()));
  });

  it("event log serialization is stable and byte-identical across runs", () => {
    expect(serializeEvents(run().events)).toBe(serializeEvents(run().events));
  });

  it("a diverging command changes the serialization", () => {
    const a = run();
    const b = P.cancelAll(makePaperSession(), { type: "CANCEL_ALL", at: NOW }).session;
    expect(serializeSession(a)).not.toBe(serializeSession(b));
  });
});
