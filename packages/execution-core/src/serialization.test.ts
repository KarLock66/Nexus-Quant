import { describe, expect, it } from "vitest";
import { serializeAudit, serializeExecutionState, stableStringify } from "./serialization.js";
import { createExecution } from "./execution.js";
import { reduceSequence } from "./state.js";
import { makeExecInput } from "./test-fixtures.js";
import type { ExecutionCommand } from "./types.js";

const ENTRY = "exec:sig-1:plan:ord:entry:0";

describe("serialization — stable + replay-safe", () => {
  it("stableStringify sorts keys at every depth (order-independent)", () => {
    const a = stableStringify({ b: 1, a: { d: 2, c: 3 } });
    const b = stableStringify({ a: { c: 3, d: 2 }, b: 1 });
    expect(a).toBe(b);
    expect(a).toBe('{"a":{"c":3,"d":2},"b":1}');
  });

  it("non-finite numbers serialize as null (never invalid JSON tokens)", () => {
    expect(stableStringify({ x: NaN, y: Infinity })).toBe('{"x":null,"y":null}');
  });

  it("a full execution serializes identically across two independent replays", () => {
    const cmds: ExecutionCommand[] = [
      { type: "ARM", at: 10 },
      { type: "SUBMIT", at: 20 },
      { type: "ACKNOWLEDGE", at: 30 },
      { type: "FILL", at: 40, orderId: ENTRY, price: 100, quantity: 0.6 },
      { type: "OPEN", at: 50 },
    ];
    const a = reduceSequence(createExecution(makeExecInput()).state!, cmds).state;
    const b = reduceSequence(createExecution(makeExecInput()).state!, cmds).state;
    expect(serializeExecutionState(a)).toBe(serializeExecutionState(b));
    expect(serializeAudit(a.audit)).toBe(serializeAudit(b.audit));
  });
});
