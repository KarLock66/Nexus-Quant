/**
 * STEP 12 — Replay verification suite.
 *
 * Drives the REAL replay engine over authentic + adversarial fixtures and
 * asserts the Phase 2 acceptance matrix:
 *   A clean data        -> decisionMatch = true
 *   B stage-b deductions -> decisionMatch = true  (score >= 90 still PASSED)
 *   C failed DQ          -> decision refused
 *   D tampered featureHash -> featureHashMatch = false, replay aborts
 *   E tampered datasetHash -> datasetHashMatch = false, replay aborts
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { replaySignal, evaluateCoreTechnical } from "./index.js";
import {
  AUTH_FEATURES,
  EXPECTED_STATE,
  scenarioCleanData,
  scenarioStageBDeductions,
  scenarioFailedDq,
  scenarioTamperedFeatureHash,
  scenarioTamperedDatasetHash,
  scenarioCorruptFeatureVector,
} from "./fixtures.js";

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("strategy v1 over the authentic vector", () => {
  it("reconstructs STRONG_BUY from the real bull snapshot", () => {
    expect(evaluateCoreTechnical(AUTH_FEATURES)).toBe(EXPECTED_STATE);
  });
});

describe("Scenario A — clean data", () => {
  it("decisionMatch = true (full reproduction)", () => {
    const out = replaySignal(scenarioCleanData());
    expect(out.replayResult).toBe("MATCH");
    expect(out.decisionMatch).toBe(true);
    expect(out.featureHashMatch).toBe(true);
    expect(out.datasetHashMatch).toBe(true);
    expect(out.recomputedDecision).toBe(EXPECTED_STATE);
  });
});

describe("Scenario B — Stage-B deductions (score 92, PASSED)", () => {
  it("decisionMatch = true (deductions above the floor don't change the decision)", () => {
    const out = replaySignal(scenarioStageBDeductions());
    expect(out.replayResult).toBe("MATCH");
    expect(out.decisionMatch).toBe(true);
    expect(out.featureHashMatch).toBe(true);
    expect(out.datasetHashMatch).toBe(true);
  });
});

describe("Scenario C — failed DQ (score 80, FAILED)", () => {
  it("decision is refused (no decision reproduced)", () => {
    const out = replaySignal(scenarioFailedDq());
    expect(out.replayResult).toBe("REFUSED_DQ");
    expect(out.decisionMatch).toBe(false);
    expect(out.recomputedDecision).toBe("REFUSED");
  });
});

describe("Scenario D — tampered featureHash", () => {
  it("featureHashMatch = false and replay aborts (no decision)", () => {
    const out = replaySignal(scenarioTamperedFeatureHash());
    expect(out.featureHashMatch).toBe(false);
    expect(out.replayResult).toBe("ABORTED_FEATURE_HASH");
    expect(out.decisionMatch).toBe(false);
    expect(out.recomputedDecision).toBeNull();
  });
});

describe("Scenario E — tampered datasetHash", () => {
  it("datasetHashMatch = false and replay aborts (no decision)", () => {
    const out = replaySignal(scenarioTamperedDatasetHash());
    expect(out.datasetHashMatch).toBe(false);
    expect(out.replayResult).toBe("ABORTED_DATASET_HASH");
    expect(out.decisionMatch).toBe(false);
    expect(out.recomputedDecision).toBeNull();
  });
});

// STEP 13 hardening — persistence-corruption defense (adversarial finding).
describe("Scenario F — corrupt feature vector (persistence corruption)", () => {
  it("fails closed to a clean aborted result (no throw, no decision)", () => {
    const out = replaySignal(scenarioCorruptFeatureVector());
    expect(out.replayResult).toBe("ABORTED_FEATURE_VECTOR");
    expect(out.decisionMatch).toBe(false);
    expect(out.recomputedDecision).toBeNull();
  });
});
