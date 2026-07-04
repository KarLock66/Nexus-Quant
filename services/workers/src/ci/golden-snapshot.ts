/**
 * PHASE G — Golden Snapshot determinism gate (Phase 11B).
 *
 * Proves the WHOLE pipeline tick is deterministic against a real database:
 *
 *   repeat 10x:
 *     reset   — delete every EngineSignal row of the fixture lineage
 *     tick    — runSignalPipelineTick() over the identical persisted input
 *     capture — canonical snapshot of the output: tick counters, inputHash,
 *               and the persisted rows projected WITHOUT volatile columns
 *               (row id / createdAt are storage artifacts, not pipeline output)
 *
 *   enforce:
 *     - all 10 snapshot hashes are BYTE-IDENTICAL
 *     - all 10 inputHashes are identical (same input each round, proven)
 *     - all 10 signal counts are identical
 *     - all 10 featureHash sets are identical
 *
 * ANY deviation fails the harness (and CI) hard. There is no tolerance band:
 * the pipeline contract is identical input -> identical output.
 */

import { createHash } from "node:crypto";
import { prisma } from "@nexus/db";
import { runSignalPipelineTick, type PipelineTickResult } from "../pipeline/orchestrator.js";
import { ensureCiFixtureLineage } from "./fixtures.js";
import {
  assert,
  fixtureRows,
  log,
  makeLog,
  resetFixtureEngineSignals,
} from "./lib.js";

const ROUNDS = 10;

interface GoldenSnapshot {
  inputHash: string;
  counters: {
    snapshotsConsidered: number;
    generated: number;
    refused: number;
    lineageRejected: number;
  };
  /** Persisted rows, volatile columns removed, in stable featureSnapshotId order. */
  rows: Array<{
    featureSnapshotId: string;
    strategyVersionId: string;
    symbol?: string;
    decision: string;
    side: string;
    confidence: string;
    dqReportId: string;
    datasetHash: string;
    featureHash: string;
  }>;
}

function snapshotHash(s: GoldenSnapshot): string {
  return createHash("sha256").update(JSON.stringify(s), "utf8").digest("hex");
}

async function captureRound(round: number): Promise<{ snap: GoldenSnapshot; hash: string }> {
  await resetFixtureEngineSignals();
  const quiet = makeLog("warn");
  const result: PipelineTickResult = await runSignalPipelineTick({
    prisma,
    log: quiet,
    tickId: `golden-${round}`,
  });

  const rows = await fixtureRows();
  const snap: GoldenSnapshot = {
    inputHash: result.inputHash,
    counters: {
      snapshotsConsidered: result.snapshotsConsidered,
      generated: result.generated,
      refused: result.refused,
      lineageRejected: result.lineageRejected,
    },
    rows: rows.map((r) => ({
      featureSnapshotId: r.featureSnapshotId,
      strategyVersionId: r.strategyVersionId,
      decision: r.decision,
      side: r.side,
      confidence: r.confidence,
      dqReportId: r.dqReportId,
      datasetHash: r.datasetHash,
      featureHash: r.featureHash,
    })),
  };
  return { snap, hash: snapshotHash(snap) };
}

export async function runGoldenSnapshot(): Promise<void> {
  log("info", "PHASE G — golden snapshot determinism gate", { rounds: ROUNDS });

  await ensureCiFixtureLineage(prisma);

  const rounds: Array<{ snap: GoldenSnapshot; hash: string }> = [];
  for (let i = 0; i < ROUNDS; i++) {
    rounds.push(await captureRound(i));
  }

  const first = rounds[0]!;
  assert(first.snap.rows.length > 0, "golden snapshot produced zero signals — nothing was proven");

  const hashes = new Set(rounds.map((r) => r.hash));
  assert(
    hashes.size === 1,
    `NON-DETERMINISTIC pipeline output: ${hashes.size} distinct snapshot hashes over ${ROUNDS} runs: ${[...hashes].join(", ")}`,
  );

  const inputHashes = new Set(rounds.map((r) => r.snap.inputHash));
  assert(
    inputHashes.size === 1,
    `input drifted between rounds (${inputHashes.size} distinct inputHashes) — the gate requires a frozen input`,
  );

  const counts = new Set(rounds.map((r) => r.snap.rows.length));
  assert(counts.size === 1, `signal COUNT diverged across runs: ${[...counts].join(", ")}`);

  const featureHashSets = new Set(
    rounds.map((r) => r.snap.rows.map((x) => x.featureHash).join("|")),
  );
  assert(
    featureHashSets.size === 1,
    "featureHash set diverged across runs (feature provenance is not stable)",
  );

  log("info", "PHASE G PASS", {
    rounds: ROUNDS,
    snapshotHash: first.hash,
    inputHash: first.snap.inputHash,
    signalsPerRun: first.snap.rows.length,
    note: "10/10 byte-identical snapshots (counters + rows + provenance)",
  });
}
