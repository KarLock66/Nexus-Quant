/**
 * Phase 11C Stage 3 — decision-bus admission validator tests.
 *
 * One happy-path fixture builder, one rejection per failure family (the Stage 1
 * validate.test.ts convention). Every rejection asserts the typed
 * BusAdmissionError, its stable code, and a message fragment naming the
 * offending field — and the happy path asserts the event is returned as the
 * SAME reference (admission never transforms, only rejects).
 */

import { describe, expect, it } from "vitest";
import type { DecisionEvent } from "../execution/types.js";
import { BusAdmissionError, admitDecisionEvent } from "./admission.js";

function validEvent(): DecisionEvent {
  return {
    signal: {
      symbol: "BTC-PERP",
      side: "LONG",
      decision: "LONG",
      confidence: "0.9500",
      strategyVersionId: "sv-1",
      strategyParams: { rsiLongMin: 55, rsiShortMax: 45, maxRealizedVol: 0.02 },
      featureSnapshotId: "fs-1",
      dqReportId: "dq-1",
      datasetHash: "dataset-hash-1",
      featureHash: "feature-hash-1",
    },
    decision: {
      action: "ENTER",
      side: "LONG",
      confidence: "0.9500",
      rationale: "confirmed directional edge",
    },
    execution: { status: "PENDING", detail: "execution hook reserved" },
    lineage: {
      tickId: "tick-1",
      strategyVersionId: "sv-1",
      featureSnapshotId: "fs-1",
      dqReportId: "dq-1",
      datasetHash: "dataset-hash-1",
      featureHash: "feature-hash-1",
      executionStrategyId: "core-technical",
      executionStrategyVersion: 1,
    },
  };
}

/** Deep-clone through JSON so mutations model exactly what the wire carries. */
function wire(mutate: (e: Record<string, any>) => void): unknown {
  const e = JSON.parse(JSON.stringify(validEvent())) as Record<string, any>;
  mutate(e);
  return e;
}

function expectRejected(payload: unknown, fragment: string): void {
  try {
    admitDecisionEvent(payload);
  } catch (err) {
    expect(err).toBeInstanceOf(BusAdmissionError);
    expect((err as BusAdmissionError).code).toBe("MALFORMED_BUS_EVENT");
    expect((err as Error).message).toContain(fragment);
    return;
  }
  throw new Error(`expected BusAdmissionError (${fragment}), but the event was admitted`);
}

describe("admitDecisionEvent — happy path (admission never transforms)", () => {
  it("returns a well-formed event as the SAME reference, unmodified", () => {
    const event = validEvent();
    const before = JSON.stringify(event);
    const admitted = admitDecisionEvent(event);
    expect(admitted).toBe(event);
    expect(JSON.stringify(admitted)).toBe(before);
  });

  it("admits a JSON wire round-trip of a valid event", () => {
    const roundTripped: unknown = JSON.parse(JSON.stringify(validEvent()));
    expect(admitDecisionEvent(roundTripped)).toEqual(validEvent());
  });

  it("admits an event with tickId omitted (in-flight back-compat)", () => {
    const payload = wire((e) => {
      delete e["lineage"].tickId;
    });
    expect(() => admitDecisionEvent(payload)).not.toThrow();
  });

  it("admits execution: null (declined intent with no plan)", () => {
    const payload = wire((e) => {
      e["execution"] = null;
    });
    expect(() => admitDecisionEvent(payload)).not.toThrow();
  });
});

describe("admitDecisionEvent — top-level shape rejections", () => {
  it("rejects non-objects", () => {
    expectRejected(null, "not a JSON object");
    expectRejected("a string", "not a JSON object");
    expectRejected(42, "not a JSON object");
    expectRejected([validEvent()], "not a JSON object");
  });

  it("rejects a missing signal / decision / lineage", () => {
    expectRejected(wire((e) => delete e["signal"]), "signal");
    expectRejected(wire((e) => delete e["decision"]), "decision");
    expectRejected(wire((e) => delete e["lineage"]), "lineage");
  });
});

describe("admitDecisionEvent — signal rejections (context-free structural check)", () => {
  it("rejects an out-of-domain side / decision", () => {
    expectRejected(wire((e) => (e["signal"].side = "UP")), 'side "UP"');
    expectRejected(wire((e) => (e["signal"].decision = "MAYBE")), 'decision "MAYBE"');
  });

  it("rejects a non-quantized confidence", () => {
    expectRejected(wire((e) => (e["signal"].confidence = "0.95")), "confidence");
  });

  it("rejects an out-of-regex confidence", () => {
    expectRejected(wire((e) => (e["signal"].confidence = "2.0000")), "confidence");
  });

  it("rejects an in-format but out-of-range confidence", () => {
    expectRejected(wire((e) => (e["signal"].confidence = "1.5000")), "outside [0, 1]");
  });

  it("rejects a numeric (non-string) confidence", () => {
    expectRejected(wire((e) => (e["signal"].confidence = 0.95)), "confidence");
  });

  it('rejects the exploit fixture: confidence "garbage"', () => {
    expectRejected(wire((e) => (e["signal"].confidence = "garbage")), "confidence");
  });

  it("rejects a missing lineage id on the signal", () => {
    expectRejected(wire((e) => (e["signal"].dqReportId = "")), "dqReportId");
  });

  it("rejects strategyParams that is not a plain object", () => {
    expectRejected(wire((e) => (e["signal"].strategyParams = [])), "strategyParams");
    expectRejected(wire((e) => (e["signal"].strategyParams = null)), "strategyParams");
    expectRejected(wire((e) => (e["signal"].strategyParams = "p")), "strategyParams");
  });
});

describe("admitDecisionEvent — decision intent rejections", () => {
  it("rejects an out-of-domain action", () => {
    expectRejected(wire((e) => (e["decision"].action = "YOLO")), 'action "YOLO"');
  });

  it("rejects an out-of-domain side", () => {
    expectRejected(wire((e) => (e["decision"].side = "UP")), 'decision.side "UP"');
  });

  it("rejects a malformed confidence", () => {
    expectRejected(wire((e) => (e["decision"].confidence = "0.95")), "decision.confidence");
  });

  it("rejects a non-string rationale", () => {
    expectRejected(wire((e) => (e["decision"].rationale = 42)), "rationale");
  });
});

describe("admitDecisionEvent — execution plan rejections", () => {
  it("rejects an unknown status", () => {
    expectRejected(wire((e) => (e["execution"].status = "DONE")), 'status "DONE"');
  });

  it("rejects a non-null non-object execution", () => {
    expectRejected(wire((e) => (e["execution"] = "yes")), "execution");
  });

  it("rejects an absent execution slot (undefined is not null)", () => {
    expectRejected(wire((e) => delete e["execution"]), "execution");
  });

  it("rejects a non-string detail", () => {
    expectRejected(wire((e) => (e["execution"].detail = 7)), "detail");
  });
});

describe("admitDecisionEvent — lineage rejections", () => {
  it("rejects a missing or empty lineage id", () => {
    expectRejected(wire((e) => (e["lineage"].strategyVersionId = "")), "strategyVersionId");
    expectRejected(wire((e) => delete e["lineage"].dqReportId), "dqReportId");
    expectRejected(
      wire((e) => (e["lineage"].executionStrategyId = "")),
      "executionStrategyId",
    );
  });

  it("rejects a non-integer executionStrategyVersion", () => {
    expectRejected(
      wire((e) => (e["lineage"].executionStrategyVersion = "1")),
      "executionStrategyVersion",
    );
    expectRejected(
      wire((e) => (e["lineage"].executionStrategyVersion = 1.5)),
      "executionStrategyVersion",
    );
  });

  it("rejects a present-but-empty tickId (optional means absent, not blank)", () => {
    expectRejected(wire((e) => (e["lineage"].tickId = "")), "tickId");
  });
});

describe("admitDecisionEvent — lineage <-> signal verbatim cross-checks", () => {
  it.each([
    "strategyVersionId",
    "featureSnapshotId",
    "dqReportId",
    "datasetHash",
    "featureHash",
  ] as const)("rejects a lineage.%s that differs from the signal", (field) => {
    expectRejected(
      wire((e) => (e["lineage"][field] = "forged")),
      `lineage.${field} does not match`,
    );
  });
});
