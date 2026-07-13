import { describe, expect, it } from "vitest";
import { CONTROL_COMPONENTS, RUNTIME_STATES } from "@nexus/control";
import { ControlDataError, admitControlComponents, assertValidRuntimeState } from "./validate.js";

const rejectsState = (v: unknown): void => {
  try {
    assertValidRuntimeState(v, "TestTable.state", "MALFORMED_RUNTIME_STATE");
    expect.unreachable("expected ControlDataError");
  } catch (err) {
    expect(err).toBeInstanceOf(ControlDataError);
    const e = err as ControlDataError;
    expect(e.code).toBe("MALFORMED_RUNTIME_STATE");
    expect(e.message).toContain("TestTable.state");
  }
};

describe("assertValidRuntimeState — persisted state admission (Stage 3 Batch 2)", () => {
  it("admits every canonical runtime state", () => {
    for (const state of RUNTIME_STATES) {
      expect(() =>
        assertValidRuntimeState(state, "TestTable.state", "MALFORMED_RUNTIME_STATE"),
      ).not.toThrow();
    }
  });

  it("rejects an out-of-domain state string", () => rejectsState("HACKED"));
  it("rejects an empty string", () => rejectsState(""));
  it("rejects a non-string", () => rejectsState(42));
  it("rejects null", () => rejectsState(null));
  it("rejects undefined", () => rejectsState(undefined));

  it("carries the caller's code (per-table attribution)", () => {
    try {
      assertValidRuntimeState("nope", "T.previousState", "MALFORMED_STATE_TRANSITION");
      expect.unreachable("expected ControlDataError");
    } catch (err) {
      expect((err as ControlDataError).code).toBe("MALFORMED_STATE_TRANSITION");
    }
  });
});

const rejectsComponents = (v: unknown): void => {
  try {
    admitControlComponents(v, "TestTable.affectedComponents", "MALFORMED_INCIDENT");
    expect.unreachable("expected ControlDataError");
  } catch (err) {
    expect(err).toBeInstanceOf(ControlDataError);
    const e = err as ControlDataError;
    expect(e.code).toBe("MALFORMED_INCIDENT");
    expect(e.message).toContain("TestTable.affectedComponents");
  }
};

describe("admitControlComponents — affectedComponents Json admission (Stage 3 Batch 2)", () => {
  it("maps null/undefined to [] (absence stays legitimate — the ?? [] contract)", () => {
    expect(admitControlComponents(null, "ctx", "MALFORMED_INCIDENT")).toEqual([]);
    expect(admitControlComponents(undefined, "ctx", "MALFORMED_INCIDENT")).toEqual([]);
  });

  it("returns a valid array as the SAME reference, unmodified (reject-only admission)", () => {
    const empty: unknown[] = [];
    expect(admitControlComponents(empty, "ctx", "MALFORMED_INCIDENT")).toBe(empty);
    const all = [...CONTROL_COMPONENTS];
    const admitted = admitControlComponents(all, "ctx", "MALFORMED_INCIDENT");
    expect(admitted).toBe(all);
    expect(admitted).toEqual(CONTROL_COMPONENTS);
  });

  it("rejects the whole value when ONE element is unknown (no silent filtering)", () =>
    rejectsComponents(["database", "bogus", "redis"]));
  it("rejects a non-array object (the silent-narrowing exploit shape)", () =>
    rejectsComponents({}));
  it("rejects a bare string (would spread into characters)", () =>
    rejectsComponents("database"));
  it("rejects a number", () => rejectsComponents(1));
  it("rejects a non-string element", () => rejectsComponents(["database", 7]));
  it("rejects an empty-string element", () => rejectsComponents([""]));
});
