import { describe, expect, it } from "vitest";
import { adapterEventId, makeAdapterEvent, mapCoreEventType } from "./events.js";
import type { ExecutionEventType } from "@nexus/execution-core";
import type { AdapterEventType } from "./types.js";

describe("adapterEventId — deterministic, replay-stable, core-distinct", () => {
  it("is a pure function of (intentId, seq)", () => {
    expect(adapterEventId("exec:sig-1", 3)).toBe("adapter:exec:sig-1:evt:3");
    expect(adapterEventId("exec:sig-1", 3)).toBe(adapterEventId("exec:sig-1", 3));
  });
  it("is namespaced apart from core event ids (adapter: prefix)", () => {
    expect(adapterEventId("exec:sig-1", 1).startsWith("adapter:")).toBe(true);
  });
});

describe("makeAdapterEvent", () => {
  it("stamps the deterministic id and copies the injected clock", () => {
    const e = makeAdapterEvent({
      intentId: "exec:sig-1",
      seq: 2,
      adapter: "PAPER",
      orderId: "exec:sig-1:plan:ord:entry:0",
      type: "FILLED",
      mode: "PAPER",
      venue: "SIMULATED",
      reason: "entry filled",
      provenance: "DERIVED",
      ts: 1234,
    });
    expect(e.eventId).toBe("adapter:exec:sig-1:evt:2");
    expect(e.ts).toBe(1234);
    expect(e.orderId).toBe("exec:sig-1:plan:ord:entry:0");
  });
});

describe("mapCoreEventType — core → venue projection", () => {
  const cases: Array<[ExecutionEventType, AdapterEventType | null]> = [
    ["SUBMITTED", "SUBMITTED"],
    ["ACKNOWLEDGED", "ACKNOWLEDGED"],
    ["PARTIALLY_FILLED", "PARTIAL_FILL"],
    ["FILLED", "FILLED"],
    ["REDUCED", "PARTIAL_FILL"],
    ["CLOSED", "FILLED"],
    ["CANCELLED", "CANCELLED"],
    ["KILLED", "CANCELLED"],
    ["REJECTED", "REJECTED"],
    ["REJECTED_TRANSITION", "REJECTED"],
    ["EXPIRED", "EXPIRED"],
    ["FAILED", "FAILED"],
    ["PLANNED", null],
    ["ARMED", null],
    ["OPENED", null],
  ];
  it.each(cases)("maps %s → %s", (core, expected) => {
    expect(mapCoreEventType(core)).toBe(expected);
  });

  it("internal transitions (PLANNED/ARMED/OPENED) emit no adapter event", () => {
    expect(mapCoreEventType("PLANNED")).toBeNull();
    expect(mapCoreEventType("ARMED")).toBeNull();
    expect(mapCoreEventType("OPENED")).toBeNull();
  });
});
