/**
 * PHASE 1 — Pipeline execution under concurrency (no duplicate writes).
 *
 * Drives N (>= 50) real pipeline ticks through the worker's own
 * runSignalPipelineTick. The upstream lineage is seeded ONCE up front, then the
 * EngineSignal rows are cleared, so the burst of ticks races first-INSERTs on the
 * same two unique keys — exercising the unique constraint + P2002 idempotency
 * path directly. Fail-closed: despite N*2 generations, exactly two rows persist.
 */

import { prisma } from "@nexus/db";
import { ensureCiFixtureLineage } from "./fixtures.js";
import { runSignalPipelineTick } from "../pipeline/orchestrator.js";
import {
  assert,
  countFixtureRows,
  fixtureRows,
  FIXTURE_SNAPSHOT_IDS,
  log,
  makeLog,
  promisePool,
  range,
  resetFixtureEngineSignals,
} from "./lib.js";

const N_TICKS = 60; // >= 50 required
const CONCURRENCY = 16; // real in-flight contention on the same keys

export async function runPhase1(): Promise<void> {
  log("info", "PHASE 1 — pipeline execution", { nTicks: N_TICKS, concurrency: CONCURRENCY });
  const quiet = makeLog("warn");

  // Seed upstream lineage once so the concurrent ticks don't race-insert it
  // (the contention we want to test is on EngineSignal itself).
  await ensureCiFixtureLineage(prisma);
  await resetFixtureEngineSignals();
  assert((await countFixtureRows()) === 0, "expected 0 EngineSignal rows after reset");

  // Fire N ticks with real concurrency.
  const results = await promisePool(range(N_TICKS), CONCURRENCY, (i) =>
    // The fixture lineage is seeded explicitly above — the tick itself only
    // resolves persisted rows (no bootstrap parameter exists anymore).
    runSignalPipelineTick({ prisma, log: quiet, tickId: `phase1-${i}` }),
  );

  // Every tick saw the two fixture snapshots, refused nothing, persisted both.
  let totalGenerated = 0;
  for (const [i, r] of results.entries()) {
    assert(r.snapshotsConsidered === 2, `tick ${i}: considered ${r.snapshotsConsidered} (expected 2)`);
    assert(r.refused === 0, `tick ${i}: refused ${r.refused} (expected 0)`);
    assert(r.lineageRejected === 0, `tick ${i}: lineageRejected ${r.lineageRejected} (expected 0)`);
    assert(r.generated === 2, `tick ${i}: generated ${r.generated} (expected 2)`);
    totalGenerated += r.generated;
  }
  assert(
    totalGenerated === N_TICKS * 2,
    `expected ${N_TICKS * 2} generations, got ${totalGenerated}`,
  );

  // FAIL-CLOSED duplicate check: exactly two rows, one per (snapshot, strategy).
  const rows = await fixtureRows();
  assert(
    rows.length === 2,
    `DUPLICATE WRITE: expected 2 EngineSignal rows, found ${rows.length}`,
  );
  const perSnapshot = new Map<string, number>();
  for (const r of rows) {
    perSnapshot.set(r.featureSnapshotId, (perSnapshot.get(r.featureSnapshotId) ?? 0) + 1);
  }
  for (const id of FIXTURE_SNAPSHOT_IDS) {
    assert(perSnapshot.get(id) === 1, `snapshot ${id}: ${perSnapshot.get(id) ?? 0} rows (expected 1)`);
  }

  // Deterministic decisions (BTC -> LONG, ETH -> SHORT).
  const bySnapshot = new Map(rows.map((r) => [r.featureSnapshotId, r]));
  assert(bySnapshot.get("ci-fs-btc-perp-h1")?.decision === "LONG", "BTC-PERP decision != LONG");
  assert(bySnapshot.get("ci-fs-eth-perp-h1")?.decision === "SHORT", "ETH-PERP decision != SHORT");

  log("info", "PHASE 1 PASS", {
    generations: totalGenerated,
    persistedRows: rows.length,
    note: `${totalGenerated} concurrent generations collapsed to ${rows.length} rows — no duplicates`,
  });
}
