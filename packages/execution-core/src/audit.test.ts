import { describe, expect, it } from "vitest";
import { appendEvent, emptyAudit, lastEvent } from "./audit.js";
import { makeEvent } from "./events.js";
import { createExecution, advanceExecution } from "./execution.js";
import { reduceSequence } from "./state.js";
import { makeExecInput } from "./test-fixtures.js";
import type { ExecutionCommand } from "./types.js";

const ENTRY = "exec:sig-1:plan:ord:entry:0";

function ev(seq: number) {
  return makeEvent({
    intentId: "exec:sig-1",
    seq,
    entity: "EXECUTION",
    entityId: "exec:sig-1",
    type: "ARMED",
    previousStatus: "PLANNED",
    newStatus: "READY",
    source: "EXECUTION_CORE",
    provenance: "DERIVED",
    reason: "test",
    ts: 1000 + seq,
  });
}

describe("audit — immutable append-only trail", () => {
  it("appends without mutating the prior audit", () => {
    const a0 = emptyAudit("exec:sig-1");
    const a1 = appendEvent(a0, ev(1));
    expect(a0.count).toBe(0); // original untouched
    expect(a1.count).toBe(1);
    expect(lastEvent(a1)?.seq).toBe(1);
  });

  it("event ids are deterministic in (intent, seq)", () => {
    expect(ev(3).eventId).toBe("exec:sig-1:evt:3");
  });

  it("a full lifecycle records one event per transition, gap-free and monotonic", () => {
    const res = createExecution(makeExecInput());
    const cmds: ExecutionCommand[] = [
      { type: "ARM", at: 10 },
      { type: "SUBMIT", at: 20 },
      { type: "ACKNOWLEDGE", at: 30 },
      { type: "FILL", at: 40, orderId: ENTRY, price: 100, quantity: 0.6 },
      { type: "OPEN", at: 50 },
    ];
    const final = reduceSequence(res.state!, cmds).state;
    // PLAN event (from createExecution) + 5 transitions = 6 events.
    expect(final.audit.count).toBe(6);
    const seqs = final.audit.events.map((e) => e.seq);
    expect(seqs).toEqual([1, 2, 3, 4, 5, 6]);
    expect(final.audit.events.every((e) => e.ts !== null)).toBe(true);
    expect(final.audit.events.map((e) => e.newStatus)).toEqual([
      "PLANNED",
      "READY",
      "SUBMITTED",
      "ACKNOWLEDGED",
      "FILLED",
      "OPEN",
    ]);
  });

  it("a rejected command appends NO event (seq unchanged)", () => {
    const planned = createExecution(makeExecInput()).state!;
    const before = planned.audit.count;
    const res = advanceExecution(planned, { type: "SUBMIT", at: 99 }); // illegal before ARM
    expect(res.ok).toBe(false);
    expect(res.state.audit.count).toBe(before);
  });
});
