/**
 * Phase 4 — Execution Decision Layer verification (pure, no IO).
 *
 * Proves the new layer upholds the platform's standing principles:
 *   - determinism / replay-compatibility: same observation -> same intent (100x)
 *   - versioning: V1 and V2 derive different intents from the SAME observation,
 *     each reproducibly (the abstraction is real, not a constant rename)
 *   - auditability: every DecisionEvent carries complete, lossless lineage
 *   - decoupling + fail-closed: the bus fans out to subscribers and a throwing
 *     subscriber aborts the publish (no partial silent success)
 */

import { describe, expect, it } from "vitest";
// Import the PURE submodules directly (not the barrel ./index.js, which also
// wires the persistence subscriber and would pull in @nexus/db) — this suite is
// IO-free by construction.
import { InProcessEventBus } from "./bus.js";
import { deriveDecisionEvent } from "./decide.js";
import {
  StrategyRegistry,
  StrategyV1,
  StrategyV2,
  defaultStrategyRegistry,
  strategyKey,
} from "./strategies/index.js";
import { STRATEGY_V1_CONFIDENCE_FLOOR } from "./strategies/strategy-v1.js";
import { STRATEGY_V2_CONFIDENCE_FLOOR } from "./strategies/strategy-v2.js";
import type { DecisionEvent, SignalObservation } from "./types.js";

const PARAMS = { rsiLongMin: 55, rsiShortMax: 45, maxRealizedVol: 0.02 };

function observation(over: Partial<SignalObservation> = {}): SignalObservation {
  return {
    symbol: "BTC-PERP",
    side: "LONG",
    decision: "LONG",
    confidence: "0.3000",
    strategyVersionId: "sv-test-1",
    strategyParams: PARAMS,
    featureSnapshotId: "fs-test-1",
    dqReportId: "dq-test-1",
    datasetHash: "dataset-hash-1",
    featureHash: "feature-hash-1",
    ...over,
  };
}

const N = 100;
function distinct<T>(fn: () => T): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i < N; i += 1) out.add(JSON.stringify(fn()));
  return out;
}

describe("StrategyV1 — confirmed-edge mapping, deterministic", () => {
  it("FLAT observation -> STAND_ASIDE (no edge), identical 100x", () => {
    const flat = observation({ side: "FLAT", decision: "FLAT", confidence: "0.0000" });
    expect(distinct(() => StrategyV1.decide(flat, {})).size).toBe(1);
    expect(StrategyV1.decide(flat, {}).action).toBe("STAND_ASIDE");
  });

  it("directional edge >= floor -> ENTER, side/confidence carried verbatim", () => {
    const obs = observation({ confidence: "0.3000" });
    const intent = StrategyV1.decide(obs, {});
    expect(intent.action).toBe("ENTER");
    expect(intent.side).toBe("LONG");
    expect(intent.confidence).toBe("0.3000");
    expect(distinct(() => StrategyV1.decide(obs, {})).size).toBe(1);
  });

  it("directional edge below floor -> HOLD", () => {
    const weak = observation({ confidence: "0.0500" });
    expect(STRATEGY_V1_CONFIDENCE_FLOOR).toBeGreaterThan(0.05);
    expect(StrategyV1.decide(weak, {}).action).toBe("HOLD");
  });
});

describe("Versioning — V1 and V2 differ on the SAME observation", () => {
  it("conviction between the two floors: V1 ENTERs, V2 HOLDs", () => {
    const mid = observation({ confidence: "0.1500" });
    expect(STRATEGY_V1_CONFIDENCE_FLOOR).toBeLessThanOrEqual(0.15);
    expect(STRATEGY_V2_CONFIDENCE_FLOOR).toBeGreaterThan(0.15);
    expect(StrategyV1.decide(mid, {}).action).toBe("ENTER");
    expect(StrategyV2.decide(mid, {}).action).toBe("HOLD");
  });

  it("both versions are independently deterministic", () => {
    const mid = observation({ confidence: "0.1500" });
    expect(distinct(() => StrategyV1.decide(mid, {})).size).toBe(1);
    expect(distinct(() => StrategyV2.decide(mid, {})).size).toBe(1);
  });
});

describe("Registry — deterministic resolution with a safe default", () => {
  it("unmapped key resolves to the default (V1); pinned keys resolve exactly", () => {
    expect(defaultStrategyRegistry.resolve("some-unknown-sv").version).toBe(1);
    expect(defaultStrategyRegistry.resolve(strategyKey(StrategyV2))).toBe(StrategyV2);
    expect(defaultStrategyRegistry.resolve(strategyKey(StrategyV1))).toBe(StrategyV1);
  });

  it("a custom registry honors explicit registrations", () => {
    const reg = new StrategyRegistry(StrategyV1).register(StrategyV2, ["pin-v2"]);
    expect(reg.resolve("pin-v2")).toBe(StrategyV2);
    expect(reg.resolve(undefined).version).toBe(1);
  });
});

describe("deriveDecisionEvent — lineage is complete and lossless", () => {
  it("threads every observation artifact + the deciding strategy version", () => {
    const obs = observation();
    const event = deriveDecisionEvent(obs, StrategyV1, { tickId: "tick-7" });
    expect(event.lineage).toEqual({
      tickId: "tick-7",
      strategyVersionId: obs.strategyVersionId,
      featureSnapshotId: obs.featureSnapshotId,
      dqReportId: obs.dqReportId,
      datasetHash: obs.datasetHash,
      featureHash: obs.featureHash,
      executionStrategyId: StrategyV1.id,
      executionStrategyVersion: StrategyV1.version,
    });
    // The observation is carried verbatim (audit source of truth).
    expect(event.signal).toBe(obs);
  });

  it("execution hook is PENDING on ENTER, SKIPPED otherwise; never executed", () => {
    const enter = deriveDecisionEvent(observation({ confidence: "0.3000" }), StrategyV1);
    expect(enter.decision.action).toBe("ENTER");
    expect(enter.execution).toEqual({ status: "PENDING", detail: expect.any(String) });

    const aside = deriveDecisionEvent(
      observation({ side: "FLAT", decision: "FLAT", confidence: "0.0000" }),
      StrategyV1,
    );
    expect(aside.execution?.status).toBe("SKIPPED");
  });

  it("omits tickId from lineage when no tick context is supplied", () => {
    const event = deriveDecisionEvent(observation(), StrategyV1);
    expect("tickId" in event.lineage).toBe(false);
  });

  it("is fully deterministic end to end", () => {
    expect(distinct(() => deriveDecisionEvent(observation(), StrategyV1, { tickId: "t" })).size).toBe(1);
  });
});

describe("InProcessEventBus — decoupled fan-out, fail-closed", () => {
  it("delivers to all subscribers in registration order, awaiting each", async () => {
    const bus = new InProcessEventBus();
    const seen: string[] = [];
    bus.subscribe(async (e: DecisionEvent) => {
      await Promise.resolve();
      seen.push(`a:${e.signal.symbol}`);
    });
    bus.subscribe((e: DecisionEvent) => {
      seen.push(`b:${e.signal.symbol}`);
    });
    await bus.publish(deriveDecisionEvent(observation(), StrategyV1));
    expect(seen).toEqual(["a:BTC-PERP", "b:BTC-PERP"]);
  });

  it("rejects (fail-closed) when a subscriber throws — no silent success", async () => {
    const bus = new InProcessEventBus();
    let reached = false;
    bus.subscribe(() => {
      throw new Error("persistence boom");
    });
    bus.subscribe(() => {
      reached = true; // must NOT run: the prior throw aborts the publish
    });
    await expect(bus.publish(deriveDecisionEvent(observation(), StrategyV1))).rejects.toThrow(
      "persistence boom",
    );
    expect(reached).toBe(false);
  });

  it("unsubscribe removes the handler", async () => {
    const bus = new InProcessEventBus();
    let count = 0;
    const off = bus.subscribe(() => {
      count += 1;
    });
    await bus.publish(deriveDecisionEvent(observation(), StrategyV1));
    off();
    await bus.publish(deriveDecisionEvent(observation(), StrategyV1));
    expect(count).toBe(1);
  });
});
