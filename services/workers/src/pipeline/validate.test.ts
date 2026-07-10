/**
 * Phase 11C Stage 1 — pipeline runtime-safety validation.
 *
 * Structural admission over persisted inputs (fail-fast throws) and the
 * generated-signal contract check (fail-closed rejection reason). Well-formed
 * fixtures MUST pass untouched — these checks change nothing on clean data.
 */

import { describe, expect, it } from "vitest";
import { PipelineDataError } from "./errors.js";
import {
  assertValidSnapshotRow,
  assertValidStrategyVersionRow,
  malformedSignalReason,
  type CandidateSnapshotRow,
} from "./validate.js";
import type { GeneratedSignal } from "../signal/types.js";

const goodRow = (): CandidateSnapshotRow => ({
  id: "fs-1",
  symbol: "BTC-PERP",
  ts: new Date("2026-06-01T00:00:00.000Z"),
  featureHash: "fh-1",
  features: { ema_20: 1, ema_50: 2, ema_200: 3, rsi_14: 50, realized_vol_30: 0.01 },
  dqReport: { id: "dq-1", score: 100, status: "PASSED", datasetHash: "ds-1" },
});

const ctx = {
  featureSnapshot: {
    id: "fs-1",
    symbol: "BTC-PERP",
    featureHash: "fh-1",
    features: { ema_20: 1 },
  },
  dqReport: { id: "dq-1", score: 100, status: "PASSED" as const, datasetHash: "ds-1" },
  strategyVersion: { id: "sv-1", parameters: {} },
};

const goodSignal = (): GeneratedSignal => ({
  symbol: "BTC-PERP",
  side: "LONG",
  decision: "LONG",
  confidence: "0.7321",
  strategyVersionId: "sv-1",
  strategyParams: { rsiLongMin: 55, rsiShortMax: 45, maxRealizedVol: 0.02 },
  featureSnapshotId: "fs-1",
  dqReportId: "dq-1",
  datasetHash: "ds-1",
  featureHash: "fh-1",
});

describe("assertValidStrategyVersionRow", () => {
  it("accepts a well-formed row", () => {
    expect(() =>
      assertValidStrategyVersionRow({ id: "sv-1", parameters: { rsiLongMin: 55 } }),
    ).not.toThrow();
  });

  it.each([
    ["missing id", { id: "", parameters: {} }],
    ["null parameters", { id: "sv-1", parameters: null }],
    ["array parameters", { id: "sv-1", parameters: [1, 2] }],
    ["string parameters", { id: "sv-1", parameters: "{}" }],
  ])("throws PipelineDataError on %s", (_name, row) => {
    expect(() => assertValidStrategyVersionRow(row)).toThrowError(PipelineDataError);
    try {
      assertValidStrategyVersionRow(row);
    } catch (err) {
      expect((err as PipelineDataError).code).toBe("MALFORMED_STRATEGY_VERSION");
    }
  });
});

describe("assertValidSnapshotRow", () => {
  it("accepts a well-formed row", () => {
    expect(() => assertValidSnapshotRow(goodRow())).not.toThrow();
  });

  it.each([
    ["empty id", (r: CandidateSnapshotRow) => void (r.id = "")],
    ["empty symbol", (r: CandidateSnapshotRow) => void (r.symbol = "")],
    ["non-Date ts", (r: CandidateSnapshotRow) => void (r.ts = "2026-06-01")],
    ["invalid Date ts", (r: CandidateSnapshotRow) => void (r.ts = new Date(Number.NaN))],
    ["empty featureHash", (r: CandidateSnapshotRow) => void (r.featureHash = "")],
    ["null features", (r: CandidateSnapshotRow) => void (r.features = null)],
    ["array features", (r: CandidateSnapshotRow) => void (r.features = [1])],
    ["missing dqReport", (r: CandidateSnapshotRow) => void (r.dqReport = null)],
    [
      "non-finite dq score",
      (r: CandidateSnapshotRow) => void (r.dqReport = { ...r.dqReport!, score: Number.NaN }),
    ],
    [
      "unknown dq status",
      (r: CandidateSnapshotRow) => void (r.dqReport = { ...r.dqReport!, status: "MAYBE" }),
    ],
    [
      "empty datasetHash",
      (r: CandidateSnapshotRow) => void (r.dqReport = { ...r.dqReport!, datasetHash: "" }),
    ],
  ])("throws PipelineDataError on %s", (_name, corrupt) => {
    const row = goodRow();
    corrupt(row);
    expect(() => assertValidSnapshotRow(row)).toThrowError(PipelineDataError);
    try {
      assertValidSnapshotRow(row);
    } catch (err) {
      expect((err as PipelineDataError).code).toBe("MALFORMED_FEATURE_SNAPSHOT");
    }
  });
});

describe("malformedSignalReason", () => {
  it("returns null for a contract-conforming signal", () => {
    expect(malformedSignalReason(goodSignal(), ctx)).toBeNull();
  });

  it("returns null for FLAT with zero confidence (the quiet-market shape)", () => {
    const s = { ...goodSignal(), side: "FLAT" as const, decision: "FLAT" as const, confidence: "0.0000" };
    expect(malformedSignalReason(s, ctx)).toBeNull();
  });

  it.each([
    ["bad side", { side: "UP" }],
    ["bad decision", { decision: "HOLD" }],
    ["unquantized confidence", { confidence: "0.5" }],
    ["out-of-range confidence", { confidence: "1.5000" }],
    ["symbol mismatch", { symbol: "ETH-PERP" }],
    ["snapshot id mismatch", { featureSnapshotId: "fs-2" }],
    ["dq id mismatch", { dqReportId: "dq-2" }],
    ["strategy version mismatch", { strategyVersionId: "sv-2" }],
    ["featureHash not verbatim", { featureHash: "fh-2" }],
    ["datasetHash not verbatim", { datasetHash: "ds-2" }],
  ])("rejects %s", (_name, patch) => {
    const s = { ...goodSignal(), ...patch } as GeneratedSignal;
    expect(malformedSignalReason(s, ctx)).toBeTypeOf("string");
  });
});
