/**
 * STEP 20 — Signal Replay Equivalence.
 *
 * Proves Replay(signal) == original decision for every directional/flat
 * scenario, reconstructing from PERSISTED artifacts only:
 *   - zero recomputation of featureHash (opaque string equality)
 *   - zero recomputation of features (reads the snapshot's persisted values)
 *   - decision + confidence reproduced by the same pure rule the engine used
 * 100% decision/confidence/lineage match required, across 100 repetitions.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { replayEngineSignal } from "./index.js";
import {
  featureSnapshot,
  dqReport,
  strategyVersion,
  persistedSignal,
  tamperHex,
  DATASET_HASH,
} from "./fixtures.js";
import type { VectorName } from "./fixtures.js";

const N = 100;

function replayFor(name: VectorName) {
  return replayEngineSignal({
    signal: persistedSignal(name),
    featureSnapshot: featureSnapshot(name),
    dqReport: dqReport(),
    strategyVersion: strategyVersion(),
  });
}

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => vi.restoreAllMocks());

describe("replay equivalence — 100% match for every authentic scenario", () => {
  for (const name of ["clean", "bull", "bear", "highvol"] as const) {
    it(`${name}: decisionMatch + confidenceMatch + lineageMatch, 100/100`, () => {
      let matches = 0;
      for (let i = 0; i < N; i += 1) {
        const r = replayFor(name);
        if (
          r.replayResult === "MATCH" &&
          r.decisionMatch &&
          r.confidenceMatch &&
          r.lineageMatch
        ) {
          matches += 1;
        }
      }
      expect(matches).toBe(N);
    });
  }

  it("reconstructs the recorded decision for bull (LONG) from persisted features", () => {
    const r = replayFor("bull");
    expect(r.recomputedDecision).toBe("LONG");
    expect(r.recordedDecision).toBe("LONG");
    expect(r.featureHashMatch).toBe(true);
    expect(r.datasetHashMatch).toBe(true);
    expect(r.strategyVersionMatch).toBe(true);
    expect(r.sideMatch).toBe(true);
  });
});

// STEP 19 hardening — adversarial findings (side tamper, symbol, strategy drift).
describe("replay equivalence — fail-closed on the adversarial findings", () => {
  it("tampered side (highvol, side LONG->SHORT) -> sideMatch false, not MATCH", () => {
    const r = replayEngineSignal({
      signal: persistedSignal("highvol", { side: "SHORT" }),
      featureSnapshot: featureSnapshot("highvol"),
      dqReport: dqReport(),
      strategyVersion: strategyVersion(),
    });
    expect(r.sideMatch).toBe(false);
    expect(r.replayResult).not.toBe("MATCH");
  });

  it("tampered symbol -> ABORTED_LINEAGE (mislabeled instrument cannot verify)", () => {
    const r = replayEngineSignal({
      signal: persistedSignal("bull", { symbol: "ETH-USDT" }),
      featureSnapshot: featureSnapshot("bull"),
      dqReport: dqReport(),
      strategyVersion: strategyVersion(),
    });
    expect(r.replayResult).toBe("ABORTED_LINEAGE");
  });

  it("strategy parameter drift -> ABORTED_LINEAGE (not a silent re-derive)", () => {
    const r = replayEngineSignal({
      signal: persistedSignal("bull"),
      featureSnapshot: featureSnapshot("bull"),
      dqReport: dqReport(),
      strategyVersion: strategyVersion({ parameters: { rsiLongMin: 90 } }),
    });
    expect(r.replayResult).toBe("ABORTED_LINEAGE");
    expect(r.strategyVersionMatch).toBe(false);
  });
});

describe("replay equivalence — fail-closed on tamper (no false MATCH)", () => {
  it("tampered featureHash -> ABORTED_LINEAGE, no decision", () => {
    const r = replayEngineSignal({
      signal: persistedSignal("bull", {
        featureHash: tamperHex(featureSnapshot("bull").featureHash),
      }),
      featureSnapshot: featureSnapshot("bull"),
      dqReport: dqReport(),
      strategyVersion: strategyVersion(),
    });
    expect(r.replayResult).toBe("ABORTED_LINEAGE");
    expect(r.featureHashMatch).toBe(false);
    expect(r.decisionMatch).toBe(false);
    expect(r.recomputedDecision).toBeNull();
  });

  it("tampered datasetHash -> ABORTED_LINEAGE", () => {
    const r = replayEngineSignal({
      signal: persistedSignal("bull", { datasetHash: tamperHex(DATASET_HASH) }),
      featureSnapshot: featureSnapshot("bull"),
      dqReport: dqReport(),
      strategyVersion: strategyVersion(),
    });
    expect(r.replayResult).toBe("ABORTED_LINEAGE");
    expect(r.datasetHashMatch).toBe(false);
  });

  it("DQ failure -> REFUSED_DQ (no decision reproduced)", () => {
    const r = replayEngineSignal({
      signal: persistedSignal("bull"),
      featureSnapshot: featureSnapshot("bull"),
      dqReport: dqReport({ score: 80, status: "FAILED" }),
      strategyVersion: strategyVersion(),
    });
    expect(r.replayResult).toBe("REFUSED_DQ");
    expect(r.decisionMatch).toBe(false);
    expect(r.recomputedDecision).toBe("REFUSED");
  });
});
