import { describe, expect, it } from "vitest";
import { PaperExecutionAdapter as P } from "./paper.js";
import { serializeSession } from "./serialization.js";
import { makePaperSession, makeRuntime, NOW, orderIds } from "./test-fixtures.js";
import type { AdapterCommand } from "./commands.js";
import type { AdapterSession } from "./types.js";

/** Drive one command through the paper adapter (dispatch used only in these determinism tests). */
function step(session: AdapterSession, cmd: AdapterCommand): AdapterSession {
  switch (cmd.type) {
    case "SUBMIT":
      return P.submit(session, cmd).session;
    case "ACKNOWLEDGE":
      return P.acknowledge(session, cmd).session;
    case "FILL":
      return P.fill(session, cmd).session;
    case "CANCEL":
      return P.cancel(session, cmd).session;
    case "CANCEL_ALL":
      return P.cancelAll(session, cmd).session;
    case "REPLACE":
      return P.replace(session, cmd).session;
    case "SHUTDOWN":
      return P.shutdown(session, cmd).session;
  }
}

function replay(commands: AdapterCommand[]): AdapterSession {
  return commands.reduce<AdapterSession>((s, c) => step(s, c), makePaperSession());
}

describe("determinism & purity", () => {
  const ids = orderIds(makePaperSession());
  const script: AdapterCommand[] = [
    { type: "SUBMIT", at: NOW, runtime: makeRuntime() },
    { type: "ACKNOWLEDGE", at: NOW },
    { type: "FILL", at: NOW, orderId: ids.entry, price: 100, quantity: 0.6 },
    { type: "FILL", at: NOW, orderId: ids.targets[0]!, price: 103, quantity: 0.3 },
  ];

  it("identical command scripts produce byte-identical sessions", () => {
    expect(serializeSession(replay(script))).toBe(serializeSession(replay(script)));
  });

  it("a single call is pure — inputs are not mutated", () => {
    const s = makePaperSession();
    const beforeStatus = s.core?.status;
    const beforeEvents = s.events.length;
    const beforeSeq = s.seq;
    P.submit(s, { type: "SUBMIT", at: NOW, runtime: makeRuntime() });
    expect(s.core?.status).toBe(beforeStatus);
    expect(s.events.length).toBe(beforeEvents);
    expect(s.seq).toBe(beforeSeq);
  });

  it("a rejected call returns the same session reference (no copy, no mutation)", () => {
    const s = makePaperSession();
    const r = P.acknowledge(s, { type: "ACKNOWLEDGE", at: NOW }); // NOT_SUBMITTED
    expect(r.session).toBe(s);
  });

  it("event seq is gap-free and monotonic across a full script", () => {
    const s = replay(script);
    const seqs = s.events.map((e) => e.seq);
    expect(seqs).toEqual(seqs.map((_, i) => i + 1));
  });

  it("re-running the same submit twice from a fresh session is identical", () => {
    const a = P.submit(makePaperSession(), { type: "SUBMIT", at: NOW, runtime: makeRuntime() });
    const b = P.submit(makePaperSession(), { type: "SUBMIT", at: NOW, runtime: makeRuntime() });
    expect(serializeSession(a.session)).toBe(serializeSession(b.session));
    expect(a.events[0]!.eventId).toBe(b.events[0]!.eventId);
  });

  it("no wall-clock leakage — every timestamp equals the injected clock", () => {
    const s = replay(script);
    expect(s.events.every((e) => e.ts === NOW)).toBe(true);
    expect(s.clock).toBe(NOW);
  });
});
