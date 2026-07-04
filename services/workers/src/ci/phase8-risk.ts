/**
 * PHASE 8 — Risk & Capital Control runtime verification.
 *
 * Drives the REAL signal pipeline tick with the risk engine wired in front of the
 * (paper-broker) market adapter over the deterministic demo lineage, then proves the
 * Phase 8 guarantees end-to-end under runtime conditions:
 *
 *   1. every order routes through the risk engine: with generous limits the demo
 *      orders FILL and the journal holds one RISK_CHECK_PASSED per fill
 *   2. the risk engine can BLOCK execution: a tight notional limit blocks every order
 *      (no fill, no RISK_CHECK_PASSED) — fail-closed
 *   3. kill switch + persistence: an engaged halt is reconstructed from the journal
 *      after a "restart" (a fresh store over the same file) and stays HALTED
 *   4. halted trading executes nothing; only an explicit reset resumes (no auto recovery)
 *
 * Like Phase 6/7 this needs only the idempotent demo upstream chain (no schema, no
 * migration) plus a temp file for the risk journal. Fail-closed: the first failing
 * assertion aborts the run.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureSignalDemoChain, prisma } from "@nexus/db";
import { createExecutionStage } from "../execution/index.js";
import { runSignalPipelineTick } from "../pipeline/orchestrator.js";
import { createMarketExecutionAdapter, demoMarketDataProvider } from "../market/index.js";
import {
  DEFAULT_RISK_LIMITS,
  FileRiskEventStore,
  InMemoryRiskEventStore,
  RiskEngine,
  createRiskExecutionGate,
  recoverRiskState,
} from "../risk/index.js";
import { assert, log, makeLog } from "./lib.js";

export async function runPhase8(): Promise<void> {
  log("info", "PHASE 8 — risk & capital control (pre-trade gate, kill switch, journaled + recoverable)");
  const quiet = makeLog("warn");
  await ensureSignalDemoChain(prisma);

  const dir = await mkdtemp(join(tmpdir(), "nexus-ci-risk-"));
  const file = join(dir, "risk-journal.jsonl");
  try {
    // ── 1) APPROVE path: every order routes through the risk engine and fills ─────
    const store = new FileRiskEventStore(file);
    const engine = new RiskEngine({ store, limits: DEFAULT_RISK_LIMITS });
    const adapter = createMarketExecutionAdapter({ marketData: demoMarketDataProvider() });
    const riskGate = createRiskExecutionGate({
      engine,
      getView: () => adapter.getMarketState(),
      getQuote: (s) => adapter.marketData.quote(s),
    });
    const deps = createExecutionStage({ adapter, riskGate });
    // demoBootstrap explicit — self-owning, env-independent (see phase1 note / F1).
    const res = await runSignalPipelineTick({ prisma, log: quiet, tickId: "phase8-a", execution: deps, demoBootstrap: true });
    const filled = res.execution?.filled ?? 0;
    assert(filled >= 1, "expected the demo lineage to fill at least one risk-approved order");
    const passed = (await store.readAll()).filter((r) => r.type === "RISK_CHECK_PASSED").length;
    assert(passed === filled, `every filled order must pass the risk engine (passed ${passed} != filled ${filled})`);

    // ── 2) BLOCK path: a tight notional limit blocks every order (fail-closed) ─────
    const tightStore = new InMemoryRiskEventStore();
    const tightEngine = new RiskEngine({
      store: tightStore,
      limits: { ...DEFAULT_RISK_LIMITS, maxPositionNotional: 1_000 },
    });
    const tightAdapter = createMarketExecutionAdapter({ marketData: demoMarketDataProvider() });
    const tightDeps = createExecutionStage({
      adapter: tightAdapter,
      riskGate: createRiskExecutionGate({
        engine: tightEngine,
        getView: () => tightAdapter.getMarketState(),
        getQuote: (s) => tightAdapter.marketData.quote(s),
      }),
    });
    const blockRes = await runSignalPipelineTick({ prisma, log: quiet, tickId: "phase8-b", execution: tightDeps, demoBootstrap: true });
    assert((blockRes.execution?.filled ?? -1) === 0, "tight risk limit must block all orders (no fills)");
    assert((blockRes.execution?.blocked ?? 0) >= 1, "tight risk limit must record blocked orders");
    assert(
      (await tightStore.readAll()).every((r) => r.type !== "RISK_CHECK_PASSED"),
      "a blocked run must journal NO RISK_CHECK_PASSED events",
    );

    // ── 3) Kill switch + persistence: engage a halt, reconstruct it after restart ──
    await engine.halt("phase8 kill-switch drill", "EXCHANGE_CONNECTIVITY_FAILURE");
    const recovered = await recoverRiskState(new FileRiskEventStore(file));
    assert(recovered.state.halted, "engaged halt did NOT survive restart (kill-switch persistence broken)");
    assert(recovered.state.trigger === "EXCHANGE_CONNECTIVITY_FAILURE", "recovered halt trigger mismatch");

    // ── 4) Halted trading executes nothing; only an explicit reset resumes ─────────
    const haltedAdapter = createMarketExecutionAdapter({ marketData: demoMarketDataProvider() });
    const haltedDeps = createExecutionStage({
      adapter: haltedAdapter,
      riskGate: createRiskExecutionGate({
        engine, // already halted in-memory
        getView: () => haltedAdapter.getMarketState(),
        getQuote: (s) => haltedAdapter.marketData.quote(s),
      }),
    });
    const haltedRes = await runSignalPipelineTick({ prisma, log: quiet, tickId: "phase8-c", execution: haltedDeps, demoBootstrap: true });
    assert((haltedRes.execution?.filled ?? -1) === 0, "a halted engine must execute NO orders");

    await engine.reset("phase8 reset");
    const resumed = await recoverRiskState(new FileRiskEventStore(file));
    assert(!resumed.state.halted, "explicit reset must clear the halt (no auto recovery before, resume after)");

    log("info", "PHASE 8 PASS", {
      note: "pre-trade gate routes every order, blocks fail-closed, kill switch persists + recovers",
      filled,
      riskChecksPassed: passed,
      recordsReplayed: recovered.recordsReplayed,
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
