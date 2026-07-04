/**
 * STEP 18 — Deterministic Signal Verification Suite.
 *
 * Drives the REAL engine + lineage utility over authentic + adversarial
 * fixtures and asserts the Phase 3 acceptance matrix, each scenario repeated
 * 100x with an IDENTICAL outcome:
 *   A clean   -> deterministic (FLAT)
 *   B bull    -> LONG
 *   C bear    -> SHORT
 *   D highvol -> FLAT (volatility filter; side stays LONG)
 *   E dq fail -> refused
 *   F tampered featureHash -> abort (lineage invalid)
 *   G tampered datasetHash -> abort (lineage invalid)
 *   H wrong strategyVersion -> abort (lineage invalid)
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateSignal, verifySignalLineage } from "./index.js";
import {
  engineInput,
  featureSnapshot,
  dqReport,
  strategyVersion,
  persistedSignal,
  tamperHex,
} from "./fixtures.js";
import { DATASET_HASH } from "./fixtures.js";

const N = 100;

/** Run `fn` N times and return the set of distinct JSON serializations. */
function distinct<T>(fn: () => T): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i < N; i += 1) out.add(JSON.stringify(fn()));
  return out;
}

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => vi.restoreAllMocks());

describe("Scenario A — clean market (deterministic)", () => {
  it("produces one identical decision across 100 runs (FLAT, no edge)", () => {
    const variants = distinct(() => generateSignal(engineInput("clean")));
    expect(variants.size).toBe(1);
    const gen = generateSignal(engineInput("clean"));
    expect(gen.status).toBe("GENERATED");
    if (gen.status !== "GENERATED") return;
    expect(gen.signal.decision).toBe("FLAT");
    expect(gen.signal.side).toBe("FLAT");
  });
});

describe("Scenario B — bull trend", () => {
  it("LONG, identical across 100 runs", () => {
    const variants = distinct(() => generateSignal(engineInput("bull")));
    expect(variants.size).toBe(1);
    const gen = generateSignal(engineInput("bull"));
    if (gen.status !== "GENERATED") throw new Error("refused");
    expect(gen.signal.decision).toBe("LONG");
    expect(gen.signal.side).toBe("LONG");
  });
});

describe("Scenario C — bear trend", () => {
  it("SHORT, identical across 100 runs", () => {
    const variants = distinct(() => generateSignal(engineInput("bear")));
    expect(variants.size).toBe(1);
    const gen = generateSignal(engineInput("bear"));
    if (gen.status !== "GENERATED") throw new Error("refused");
    expect(gen.signal.decision).toBe("SHORT");
    expect(gen.signal.side).toBe("SHORT");
  });
});

describe("Scenario D — high volatility", () => {
  it("FLAT via volatility filter (bias still LONG), identical across 100 runs", () => {
    const variants = distinct(() => generateSignal(engineInput("highvol")));
    expect(variants.size).toBe(1);
    const gen = generateSignal(engineInput("highvol"));
    if (gen.status !== "GENERATED") throw new Error("refused");
    expect(gen.signal.decision).toBe("FLAT");
    expect(gen.signal.side).toBe("LONG"); // trend bias preserved; filter overrode
  });
});

describe("Scenario E — DQ failure", () => {
  it("refused, identical across 100 runs (no signal)", () => {
    const input = () => engineInput("bull", { dqReport: { score: 80, status: "FAILED" } });
    const variants = distinct(() => generateSignal(input()));
    expect(variants.size).toBe(1);
    expect(generateSignal(input()).status).toBe("REFUSED");
  });
});

describe("Scenario F — tampered featureHash", () => {
  it("lineage invalid (abort), identical across 100 runs", () => {
    const verify = () =>
      verifySignalLineage({
        signal: persistedSignal("bull", { featureHash: tamperHex(featureSnapshot("bull").featureHash) }),
        featureSnapshot: featureSnapshot("bull"),
        dqReport: dqReport(),
        strategyVersion: strategyVersion(),
      });
    expect(distinct(verify).size).toBe(1);
    const r = verify();
    expect(r.lineageValid).toBe(false);
    expect(r.featureHashMatch).toBe(false);
  });
});

describe("Scenario G — tampered datasetHash", () => {
  it("lineage invalid (abort), identical across 100 runs", () => {
    const verify = () =>
      verifySignalLineage({
        signal: persistedSignal("bull", { datasetHash: tamperHex(DATASET_HASH) }),
        featureSnapshot: featureSnapshot("bull"),
        dqReport: dqReport(),
        strategyVersion: strategyVersion(),
      });
    expect(distinct(verify).size).toBe(1);
    const r = verify();
    expect(r.lineageValid).toBe(false);
    expect(r.datasetHashMatch).toBe(false);
  });
});

describe("Scenario H — wrong strategy version", () => {
  it("lineage invalid (abort), identical across 100 runs", () => {
    const verify = () =>
      verifySignalLineage({
        signal: persistedSignal("bull", { strategyVersionId: "sv_impostor" }),
        featureSnapshot: featureSnapshot("bull"),
        dqReport: dqReport(),
        strategyVersion: strategyVersion(),
      });
    expect(distinct(verify).size).toBe(1);
    const r = verify();
    expect(r.lineageValid).toBe(false);
    expect(r.strategyVersionMatch).toBe(false);
  });
});

// STEP 19 hardening — adversarial findings (symbol re-binding; strategy drift).
describe("Scenario I — tampered symbol (mislabeled instrument)", () => {
  it("lineage invalid: symbol re-bound to the snapshot, identical across 100 runs", () => {
    const verify = () =>
      verifySignalLineage({
        signal: persistedSignal("bull", { symbol: "ETH-USDT" }),
        featureSnapshot: featureSnapshot("bull"), // authoritative symbol BTC-USDT
        dqReport: dqReport(),
        strategyVersion: strategyVersion(),
      });
    expect(distinct(verify).size).toBe(1);
    const r = verify();
    expect(r.lineageValid).toBe(false);
    expect(r.detail).toContain("symbol mismatch");
  });
});

describe("Scenario J — strategy parameter drift", () => {
  it("lineage invalid: live params drift from the persisted snapshot, identical across 100 runs", () => {
    const verify = () =>
      verifySignalLineage({
        signal: persistedSignal("bull"), // snapshot params = defaults (rsiLongMin 55)
        featureSnapshot: featureSnapshot("bull"),
        dqReport: dqReport(),
        strategyVersion: strategyVersion({ parameters: { rsiLongMin: 90 } }),
      });
    expect(distinct(verify).size).toBe(1);
    const r = verify();
    expect(r.lineageValid).toBe(false);
    expect(r.strategyVersionMatch).toBe(false);
    expect(r.detail).toContain("strategy parameter drift");
  });
});
