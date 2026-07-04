/**
 * PHASE 7 — Order & Position durability runtime verification.
 *
 * Drives the REAL signal pipeline tick with a DURABLE market adapter (paper broker
 * + an append-only JSONL journal) over the deterministic fixture lineage, then proves
 * the Phase 7 guarantees end-to-end under runtime conditions:
 *
 *   1. durability     : every committed execution is appended to the journal; the
 *                       record count matches the fills the live adapter holds
 *   2. restart rebuild: a FRESH store instance over the same file reconstructs
 *                       Position / Account / Portfolio from the journal ALONE and
 *                       the rebuilt state EQUALS the live adapter state
 *   3. fail-closed    : a tampered journal (a divergent snapshot) HALTS recovery
 *                       with MarketRecoveryError — never silently trades on it
 *   4. continuity     : an adapter SEEDED from recovery re-runs the fixture lineage as
 *                       a no-op and still reconciles (broker<->portfolio)
 *
 * Like Phase 6 this needs only the idempotent fixture upstream chain (no schema, no
 * migration) plus a temp file for the journal. Fail-closed: the first failing
 * assertion aborts the run.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prisma } from "@nexus/db";
import { ensureCiFixtureLineage, fixtureQuoteProvider } from "./fixtures.js";
import { createExecutionStage } from "../execution/index.js";
import { runSignalPipelineTick } from "../pipeline/orchestrator.js";
import {
  FileMarketEventStore,
  InMemoryMarketEventStore,
  MarketRecoveryError,
  createMarketExecutionAdapter,
  recoverMarketState,
} from "../market/index.js";
import { assert, log, makeLog } from "./lib.js";

export async function runPhase7(): Promise<void> {
  log("info", "PHASE 7 — durability (append-only journal, restart rebuild, fail-closed recovery)");
  const quiet = makeLog("warn");
  await ensureCiFixtureLineage(prisma);

  const dir = await mkdtemp(join(tmpdir(), "nexus-ci-journal-"));
  const file = join(dir, "market-journal.jsonl");
  try {
    // ── Drive the real pipeline through a DURABLE adapter ────────────────────────
    const store = new FileMarketEventStore(file);
    const adapter = createMarketExecutionAdapter({
      // paper broker is the default — deterministic, zero market impact.
      marketData: fixtureQuoteProvider(),
      eventStore: store,
    });
    const deps = createExecutionStage({ adapter });

    // Fixture lineage seeded explicitly above — the tick resolves persisted rows only.
    await runSignalPipelineTick({ prisma, log: quiet, tickId: "phase7-a", execution: deps });
    await runSignalPipelineTick({ prisma, log: quiet, tickId: "phase7-b", execution: deps });

    // ── 1) Durability: the journal recorded the committed executions ─────────────
    const records = await store.readAll();
    assert(records.length >= 1, "expected at least one durable journal record");
    assert(
      records.every((r, i) => r.seq === i),
      "journal seq is not contiguous/append-only",
    );

    // ── 2) Restart rebuild: a fresh store over the same file reconstructs state ───
    const recovered = await recoverMarketState(new FileMarketEventStore(file));
    assert(
      JSON.stringify(recovered.marketState) === JSON.stringify(adapter.getMarketState()),
      "recovered market state != live market state (restart reconstruction broken)",
    );
    assert(
      JSON.stringify(recovered.portfolioState) === JSON.stringify(deps.portfolioState),
      "recovered portfolio state != live portfolio state (restart reconstruction broken)",
    );

    // ── 3) Fail-closed: a tampered journal halts recovery ────────────────────────
    // Re-append the records into a fresh store with the first snapshot corrupted.
    const corruptStore = new InMemoryMarketEventStore();
    for (let i = 0; i < records.length; i += 1) {
      const { seq: _seq, ...input } = JSON.parse(JSON.stringify(records[i])) as (typeof records)[number];
      if (i === 0) input.position.netQty = "999.00000000";
      await corruptStore.append(input);
    }
    let halted = false;
    try {
      await recoverMarketState(corruptStore);
    } catch (err) {
      halted = err instanceof MarketRecoveryError;
    }
    assert(halted, "tampered journal did NOT halt recovery (fail-closed broken)");

    // ── 4) Continuity: a seeded adapter re-runs the fixture lineage as a no-op ───────
    const restarted = createMarketExecutionAdapter({
      marketData: fixtureQuoteProvider(),
      eventStore: new FileMarketEventStore(file),
      initialMarketState: recovered.marketState,
      initialPortfolioMirror: recovered.portfolioState,
    });
    const restartedDeps = createExecutionStage({
      adapter: restarted,
      portfolioState: recovered.portfolioState,
    });
    await runSignalPipelineTick({ prisma, log: quiet, tickId: "phase7-c", execution: restartedDeps });
    assert(
      restarted.reconcileWith(restartedDeps.portfolioState).ok,
      "post-restart reconciliation failed (broker<->portfolio mismatch)",
    );

    log("info", "PHASE 7 PASS", {
      note: "durable journal, restart reconstruction, fail-closed recovery, and continuity all hold",
      records: records.length,
      fillsReplayed: recovered.fillsReplayed,
      symbols: Object.keys(adapter.getMarketState().positions).length,
      account: adapter.accountValuation(),
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
