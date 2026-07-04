import { describe, expect, it } from "vitest";
import { createAdapter, createEmptySession, createSession } from "./factory.js";
import { NullExecutionAdapter } from "./null.js";
import { PaperExecutionAdapter } from "./paper.js";
import { makeCoreState, NOW } from "./test-fixtures.js";

describe("createAdapter — opt-in / default-off selection", () => {
  it("returns NULL by default (no config)", () => {
    expect(createAdapter().kind).toBe("NULL");
  });

  it("returns NULL when config is empty", () => {
    expect(createAdapter({}).kind).toBe("NULL");
  });

  it("returns PAPER only when kind=PAPER AND enabled=true", () => {
    expect(createAdapter({ kind: "PAPER", enabled: true }).kind).toBe("PAPER");
  });

  it("returns NULL when PAPER is selected but not enabled (default-off)", () => {
    expect(createAdapter({ kind: "PAPER" }).kind).toBe("NULL");
    expect(createAdapter({ kind: "PAPER", enabled: false }).kind).toBe("NULL");
  });

  it("returns NULL when enabled=true but no kind (must explicitly opt into PAPER)", () => {
    expect(createAdapter({ enabled: true }).kind).toBe("NULL");
  });

  it("falls back to NULL for LIVE (no broker adapter exists in the foundation)", () => {
    expect(createAdapter({ kind: "LIVE", enabled: true }).kind).toBe("NULL");
  });

  it("falls back to NULL for NULL kind explicitly", () => {
    expect(createAdapter({ kind: "NULL", enabled: true }).kind).toBe("NULL");
  });
});

describe("createSession — binding a core execution", () => {
  it("binds the paper adapter to a green core state, un-submitted, empty log", () => {
    const s = createSession(PaperExecutionAdapter, makeCoreState(), { now: NOW });
    expect(s.adapter).toBe("PAPER");
    expect(s.status).toBe("READY");
    expect(s.submitted).toBe(false);
    expect(s.events).toEqual([]);
    expect(s.seq).toBe(0);
    expect(s.intentId).toBe(s.core?.intentId ?? null);
    expect(s.core?.status).toBe("PLANNED");
  });

  it("null adapter session is UNAVAILABLE health", () => {
    const s = createSession(NullExecutionAdapter, makeCoreState(), { now: NOW });
    expect(s.adapter).toBe("NULL");
    expect(s.status).toBe("UNAVAILABLE");
  });

  it("reads mode/venue from the core state unless overridden", () => {
    const core = makeCoreState();
    const s = createSession(PaperExecutionAdapter, core, { now: NOW });
    expect(s.mode).toBe(core.mode);
    expect(s.venue).toBe(core.venue);
    const s2 = createSession(PaperExecutionAdapter, core, { now: NOW, mode: "SIMULATION", venue: "UNSET" });
    expect(s2.mode).toBe("SIMULATION");
    expect(s2.venue).toBe("UNSET");
  });

  it("defaults the clock to the core state createdAt when now is omitted", () => {
    const core = makeCoreState();
    const s = createSession(PaperExecutionAdapter, core);
    expect(s.createdAt).toBe(core.createdAt);
    expect(s.clock).toBe(core.createdAt);
  });
});

describe("createEmptySession — unbound session", () => {
  it("has no core, no intent, and paper health READY", () => {
    const s = createEmptySession(PaperExecutionAdapter, NOW);
    expect(s.core).toBeNull();
    expect(s.intentId).toBeNull();
    expect(s.status).toBe("READY");
    expect(s.mode).toBe("SIMULATION");
    expect(s.venue).toBe("UNSET");
  });
});
