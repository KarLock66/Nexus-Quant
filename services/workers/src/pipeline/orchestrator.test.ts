/**
 * Phase 11C Stage 1 — pipeline admission boundary, proven at the orchestrator.
 *
 * The unit tests in validate.test.ts prove each validator in isolation. These
 * prove the boundary is actually INSTALLED in runSignalPipelineTick: malformed
 * persisted input is rejected fail-fast BEFORE the input is fingerprinted or any
 * signal reaches the decision seam (bus.publish), the rejection is deterministic,
 * and well-formed input still flows through untouched.
 *
 * No database: a hand-rolled PrismaClient stub returns the three queries the tick
 * makes; a spy EventBus records whether the decision seam was ever reached.
 */

import { describe, expect, it } from "vitest";
import type { PrismaClient } from "@nexus/db";
import { PipelineDataError, runSignalPipelineTick, type LogFn } from "./orchestrator.js";
import type { DecisionEvent, EventBus } from "../execution/index.js";

/** A feature vector that generates a well-formed FLAT signal (emas not stacked). */
const FEATURES = { ema_20: 100, ema_50: 100, ema_200: 100, rsi_14: 50, realized_vol_30: 0.01 };

const quiet: LogFn = () => {};

interface SnapRow {
  id: string;
  symbol: string;
  ts: Date;
  featureHash: string;
  features: unknown;
  exchange: string;
  dqReport: { id: string; score: number; status: string; datasetHash: string } | null;
}

function makeSnap(overrides: Partial<SnapRow> = {}): SnapRow {
  return {
    id: "fs-1",
    symbol: "BTC-PERP",
    ts: new Date("2026-06-01T00:00:00.000Z"),
    featureHash: "fh-1",
    features: { ...FEATURES },
    exchange: "DERIBIT",
    dqReport: { id: "dq-1", score: 100, status: "PASSED", datasetHash: "ds-1" },
    ...overrides,
  };
}

/** Minimal PrismaClient stub covering exactly the three reads the tick performs. */
function fakePrisma(opts: {
  featureSet?: { id: string } | null;
  strategyVersion?: { id: unknown; parameters: unknown } | null;
  snapshots?: SnapRow[];
}): PrismaClient {
  const featureSet = opts.featureSet === undefined ? { id: "fset-1" } : opts.featureSet;
  const strategyVersion =
    opts.strategyVersion === undefined ? { id: "sv-1", parameters: {} } : opts.strategyVersion;
  const snapshots = opts.snapshots ?? [makeSnap()];
  return {
    featureSetDefinition: { findUnique: async () => featureSet },
    strategyVersion: { findFirst: async () => strategyVersion },
    featureSnapshot: { findMany: async () => snapshots },
  } as unknown as PrismaClient;
}

/** A bus that only records publishes — publishing is the sole downstream effect. */
function spyBus(): { bus: EventBus; published: DecisionEvent[] } {
  const published: DecisionEvent[] = [];
  const bus = {
    publish: async (e: DecisionEvent) => void published.push(e),
    subscribe: () => () => {},
  } as unknown as EventBus;
  return { bus, published };
}

describe("runSignalPipelineTick — admission boundary", () => {
  it("admits well-formed input: generates and reaches the decision seam", async () => {
    const { bus, published } = spyBus();
    const result = await runSignalPipelineTick({
      prisma: fakePrisma({}),
      log: quiet,
      bus,
      tickId: "ok",
    });
    expect(result.generated).toBe(1);
    expect(result.malformedRejected).toBe(0);
    expect(result.lineageRejected).toBe(0);
    expect(published).toHaveLength(1);
  });

  it("rejects a malformed StrategyVersion before anything is published", async () => {
    const { bus, published } = spyBus();
    const prisma = fakePrisma({ strategyVersion: { id: "sv-1", parameters: null } });
    await expect(
      runSignalPipelineTick({ prisma, log: quiet, bus, tickId: "sv" }),
    ).rejects.toMatchObject({ name: "PipelineDataError", code: "MALFORMED_STRATEGY_VERSION" });
    expect(published).toHaveLength(0);
  });

  it("rejects a malformed FeatureSnapshot before the input is fingerprinted or executed", async () => {
    const { bus, published } = spyBus();
    const prisma = fakePrisma({ snapshots: [makeSnap({ features: null })] });
    await expect(
      runSignalPipelineTick({ prisma, log: quiet, bus, tickId: "fs" }),
    ).rejects.toMatchObject({ name: "PipelineDataError", code: "MALFORMED_FEATURE_SNAPSHOT" });
    expect(published).toHaveLength(0);
  });

  it("fail-fast on any malformed row: a valid sibling row is never published", async () => {
    const { bus, published } = spyBus();
    // Ordered ascending by symbol: AAA (valid) is admitted, then ZZZ (empty
    // featureHash) throws — the admission loop runs to completion before ANY
    // generation, so the valid sibling never reaches the seam either.
    const prisma = fakePrisma({
      snapshots: [
        makeSnap({ id: "fs-good", symbol: "AAA" }),
        makeSnap({ id: "fs-bad", symbol: "ZZZ", featureHash: "" }),
      ],
    });
    await expect(
      runSignalPipelineTick({ prisma, log: quiet, bus, tickId: "mixed" }),
    ).rejects.toBeInstanceOf(PipelineDataError);
    expect(published).toHaveLength(0);
  });

  it("produces a deterministic rejection: identical code and message across runs", async () => {
    const build = () => fakePrisma({ snapshots: [makeSnap({ id: "fs-x", featureHash: "" })] });
    const errs: PipelineDataError[] = [];
    for (let i = 0; i < 3; i++) {
      try {
        await runSignalPipelineTick({ prisma: build(), log: quiet, bus: spyBus().bus, tickId: "det" });
      } catch (err) {
        errs.push(err as PipelineDataError);
      }
    }
    expect(errs).toHaveLength(3);
    expect(new Set(errs.map((e) => e.code)).size).toBe(1);
    expect(new Set(errs.map((e) => e.message)).size).toBe(1);
  });

  it("throws the orchestrator's PipelineDataError (unified error identity)", async () => {
    // The validator throws the ./errors.js class; the orchestrator re-exports the
    // same class. This asserts they are one identity — instanceof holds across
    // the seam, so callers' catch/instanceof handling is uniform.
    const prisma = fakePrisma({ strategyVersion: { id: "", parameters: {} } });
    await expect(
      runSignalPipelineTick({ prisma, log: quiet, bus: spyBus().bus, tickId: "id" }),
    ).rejects.toBeInstanceOf(PipelineDataError);
  });
});
