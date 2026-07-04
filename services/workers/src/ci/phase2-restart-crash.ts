/**
 * PHASE 2 — Restart / crash simulation (SIGKILL) with idempotency preserved.
 *
 * Boot the real worker, wait (condition-based) until it has persisted the two
 * fixture rows, then SIGKILL it mid-run. Restart it, wait until it completes at
 * least one fresh tick, SIGKILL again. The unique constraint + upsert/P2002 path
 * must leave EXACTLY the same two rows with the SAME ids — a restart re-processes
 * the same snapshots and updates in place rather than inserting duplicates.
 */

import { prisma } from "@nexus/db";
import { ensureCiFixtureLineage } from "./fixtures.js";
import {
  assert,
  countFixtureRows,
  fixtureRows,
  log,
  resetFixtureEngineSignals,
  spawnWorker,
  waitFor,
} from "./lib.js";

export async function runPhase2(): Promise<void> {
  log("info", "PHASE 2 — restart/crash (SIGKILL) idempotency");

  // Start from a clean EngineSignal slate; upstream lineage present.
  await ensureCiFixtureLineage(prisma);
  await resetFixtureEngineSignals();
  assert((await countFixtureRows()) === 0, "expected 0 EngineSignal rows before worker boot");

  // ── Run #1: boot, let it persist the two rows, then crash it (SIGKILL). ──────
  const w1 = spawnWorker({ SIGNAL_TICK_MS: "1000" });
  try {
    await waitFor(
      "worker#1 persists the 2 fixture rows",
      async () => (await countFixtureRows()) === 2,
      { timeoutMs: 30_000 },
    );
  } finally {
    await w1.kill("SIGKILL"); // abrupt crash mid-run
  }
  await w1.waitExit();

  const before = await fixtureRows();
  assert(before.length === 2, `after crash expected 2 rows, found ${before.length}`);
  const idsBefore = before.map((r) => r.id).sort();

  // ── Run #2: restart, let it complete >= 1 tick over the same snapshots. ──────
  const w2 = spawnWorker({ SIGNAL_TICK_MS: "1000" });
  try {
    await waitFor(
      "worker#2 completes a post-restart tick",
      () => w2.tickCompleteCount() >= 1,
      { timeoutMs: 30_000 },
    );
  } finally {
    await w2.kill("SIGKILL");
  }
  await w2.waitExit();

  // ── Assertions: no duplicates, ids unchanged (idempotent in-place upsert). ───
  const after = await fixtureRows();
  assert(
    after.length === 2,
    `DUPLICATE WRITE after restart: expected 2 rows, found ${after.length}`,
  );
  const idsAfter = after.map((r) => r.id).sort();
  assert(
    idsBefore.length === idsAfter.length && idsBefore.every((id, i) => id === idsAfter[i]),
    `row ids changed across restart (not idempotent): ${idsBefore.join(",")} -> ${idsAfter.join(",")}`,
  );

  log("info", "PHASE 2 PASS", {
    idsBefore,
    idsAfter,
    note: "crash + restart re-processed the same snapshots with zero duplicate rows",
  });
}
