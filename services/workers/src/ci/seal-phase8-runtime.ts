/**
 * PHASE 8 — RUNTIME SEAL VALIDATION (real infrastructure only).
 *
 *   pnpm --filter @nexus/workers exec tsx src/ci/seal-phase8-runtime.ts
 *
 * Proves the COMPLETED Phase 8 Risk & Capital Control System behaves correctly under
 * REAL runtime execution — live Postgres + live Redis (docker/docker-compose.ci.yml),
 * the REAL worker process, the REAL execution pipeline, and REAL on-disk event/risk
 * journals. No mocks, no stubs, no fake recovery. Each of STEP A–J runs and reports
 * PASS/FAIL; the run is SEALED only if every step passes.
 *
 * Step → mechanism:
 *   A bootstrap      live worker process boot (RISK_ENGINE=on) + DB/Redis reachable + Redis bus round-trip
 *   B normal flow    real pipeline tick → fills + RISK_CHECK_PASSED + signals persisted (Postgres)
 *   C position limit  real pipeline tick, tight maxPositionSize → blocked, POSITION_LIMIT_BREACHED + RISK_CHECK_FAILED
 *   D leverage        real pipeline tick, tight maxLeverage → blocked, LEVERAGE_LIMIT_BREACHED
 *   E loss/drawdown   forced declining equity → DRAWDOWN_LIMIT_BREACHED + halt + no execution
 *   F kill switch     health-signal trigger → KILL_SWITCH_TRIGGERED + TRADING_HALTED; pipeline keeps running, execution disabled
 *   G halt survives   REAL worker restart over a pre-halted risk journal → recovers halted twice
 *   H tamper          corrupt the risk journal → recovery fails closed (RiskRecoveryError); no fallback
 *   I replay equiv.   recovered risk state + capital + exposure + halt == live before shutdown
 *   J integrity       cross-cutting invariants (no bypass, every order gated, every event journaled, fail-closed)
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureSignalDemoChain, prisma } from "@nexus/db";
import {
  assertDbReachable,
  log,
  makeLog,
  msg,
  sleep,
  spawnWorker,
  waitFor,
  type WorkerHandle,
} from "./lib.js";
import { createRedisDecisionBus, type RedisLike } from "../bus/index.js";
import { createExecutionStage, type DecisionEvent } from "../execution/index.js";
import { runSignalPipelineTick } from "../pipeline/orchestrator.js";
import {
  FileMarketEventStore,
  createMarketExecutionAdapter,
  demoMarketDataProvider,
  recoverMarketState,
} from "../market/index.js";
import { emptyAccount } from "../market/account.js";
import { applyFill, flatPosition } from "../market/position.js";
import type { Account, ExecutionLineage, Fill, Position } from "../market/types.js";
import {
  DEFAULT_RISK_LIMITS,
  FileRiskEventStore,
  RiskEngine,
  RiskRecoveryError,
  buildCapitalSnapshot,
  computeExposure,
  createRiskExecutionGate,
  recoverRiskState,
  type MarketView,
  type RiskLimits,
} from "../risk/index.js";

const DATABASE_URL = process.env["DATABASE_URL"] ?? "";
const REDIS_URL = process.env["REDIS_URL"] ?? "redis://localhost:6379";
const quiet = makeLog("warn");
const eq = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

// ── Fixtures (mirror the unit suite) ────────────────────────────────────────────
const LINEAGE: ExecutionLineage = {
  strategyVersionId: "sv-1",
  featureSnapshotId: "fs-1",
  dqReportId: "dq-1",
  datasetHash: "dataset-hash-1",
  featureHash: "feature-hash-1",
  executionStrategyId: "core-technical",
  executionStrategyVersion: 1,
  intentId: "intent-1",
  netScore: "0.00",
  contributions: [],
};
function mkPosition(symbol: string, side: "LONG" | "SHORT", qty: number, price: number): Position {
  const fill: Fill = {
    orderId: "o-1", intentId: "intent-1", symbol,
    side: side === "LONG" ? "BUY" : "SELL",
    qty: qty.toFixed(8), price: price.toFixed(8), lineage: LINEAGE,
  };
  return applyFill(flatPosition(symbol), fill);
}
function account(cash: number): Account {
  return emptyAccount({ initialCash: cash, leverage: 1 });
}
function view(cash: number, positions: Position[] = []): MarketView {
  const map: Record<string, Position> = {};
  for (const p of positions) map[p.symbol] = p;
  return { account: account(cash), positions: map };
}
function mkOrder(symbol: string, side: "LONG" | "SHORT", qty: number, price: number) {
  return {
    symbol, side, targetQuantity: qty.toFixed(8),
    targetNotional: (qty * price).toFixed(2), price: price.toFixed(8), strategyId: "core-technical",
  };
}
function limits(over: Partial<RiskLimits> = {}): RiskLimits {
  return {
    maxPositionSize: 1_000_000, maxPositionNotional: 100_000_000, maxLeverage: 100,
    dailyLossLimit: 100_000_000, maxAssetAllocation: 1, maxDrawdown: 1, ...over,
  };
}
function gateFor(engine: RiskEngine, adapter: ReturnType<typeof createMarketExecutionAdapter>) {
  return createRiskExecutionGate({
    engine,
    getView: () => adapter.getMarketState(),
    getQuote: (s) => adapter.marketData.quote(s),
  });
}

// ── Results recorder ─────────────────────────────────────────────────────────
interface StepResult { step: string; pass: boolean; detail: string }
const results: StepResult[] = [];
let firstFailure = "";
let replayMismatch = "NONE";
let riskDivergence = "NONE";

async function step(name: string, fn: () => Promise<string>): Promise<void> {
  try {
    const detail = await fn();
    results.push({ step: name, pass: true, detail });
    log("info", `STEP ${name}: PASS`, { detail });
  } catch (err) {
    const detail = msg(err);
    results.push({ step: name, pass: false, detail });
    if (firstFailure === "") firstFailure = `STEP ${name}: ${detail}`;
    log("error", `STEP ${name}: FAIL`, { detail });
  }
}
function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(message);
}

async function main(): Promise<void> {
  log("info", "PHASE 8 RUNTIME SEAL — start", { db: DATABASE_URL.replace(/:[^:@]*@/, ":***@"), redis: REDIS_URL });
  const dir = await mkdtemp(join(tmpdir(), "nexus-seal8-"));
  const workers: WorkerHandle[] = [];
  let aGood = false, bGood = false, cGood = false, dGood = false;

  try {
    await assertDbReachable();
    await ensureSignalDemoChain(prisma);

    // ── STEP A — BOOTSTRAP (real worker, real DB, real Redis) ──────────────────
    await step("A", async () => {
      // Redis reachable + decision bus round-trips over the wire (no mock).
      const { Redis } = await import("ioredis");
      const pub = new Redis(REDIS_URL) as unknown as RedisLike & { ping: () => Promise<string>; disconnect: () => void };
      const pong = await pub.ping();
      assert(pong === "PONG", `redis ping returned ${pong}`);
      const rbus = createRedisDecisionBus(pub);
      let delivered = false;
      rbus.subscribe(() => { delivered = true; });
      await sleep(300);
      await rbus.publish({ signal: {}, decision: {}, execution: null, lineage: {} } as unknown as DecisionEvent);
      await waitFor("redis bus delivery", async () => delivered, { timeoutMs: 4000, intervalMs: 100 });
      pub.disconnect();
      assert(delivered, "redis decision-bus round-trip did not deliver");

      // Real worker process boots with the risk engine initialized + pipeline active.
      const journalA = join(dir, "risk-A.jsonl");
      const w = spawnWorker({
        DATABASE_URL, REDIS_URL,
        RISK_ENGINE: "on", MARKET_BROKER: "paper",
        RISK_JOURNAL_PATH: journalA, SIGNAL_TICK_MS: "1000",
      });
      workers.push(w);
      await waitFor(
        "worker healthy: risk engine initialized + >=1 pipeline tick",
        async () =>
          w.lines().some((l) => l.includes('"msg":"Phase 8 risk engine enabled"')) &&
          w.lines().some((l) => l.includes('"msg":"Phase 6 market integration enabled"')) &&
          w.tickCompleteCount() >= 1,
        { timeoutMs: 40_000, intervalMs: 500 },
      );
      await w.kill("SIGTERM");
      aGood = true;
      return `redis PONG + bus round-trip; worker booted (risk engine + market integration), ticks=${w.tickCompleteCount()}`;
    });

    // ── STEP B — NORMAL TRADE FLOW (real pipeline → fills, journal, persistence) ─
    await step("B", async () => {
      const store = new FileRiskEventStore(join(dir, "risk-B.jsonl"));
      const engine = new RiskEngine({ store, limits: DEFAULT_RISK_LIMITS });
      const adapter = createMarketExecutionAdapter({ marketData: demoMarketDataProvider() });
      const deps = createExecutionStage({ adapter, riskGate: gateFor(engine, adapter) });
      const before = await prisma.engineSignal.count();
      const res = await runSignalPipelineTick({ prisma, log: quiet, tickId: "seal8-B", execution: deps });
      const filled = res.execution?.filled ?? 0;
      assert(filled >= 1, `expected >=1 fill, got ${filled}`);
      const recs = await store.readAll();
      const passed = recs.filter((r) => r.type === "RISK_CHECK_PASSED").length;
      assert(passed === filled, `RISK_CHECK_PASSED ${passed} != filled ${filled}`);
      const positions = Object.keys(adapter.getMarketState().positions).length;
      assert(positions >= 1, "no position created");
      const val = adapter.accountValuation();
      assert(val.grossExposure !== "0.00", "account not updated (gross exposure still zero)");
      const after = await prisma.engineSignal.count();
      assert(after >= before && after > 0, "signals not persisted to Postgres");
      assert(engine.state.baselineEquity !== null, "risk state not updated (no baseline)");
      bGood = true;
      return `filled=${filled}, RISK_CHECK_PASSED=${passed}, positions=${positions}, gross=${val.grossExposure}, signals(db)=${after}`;
    });

    // ── STEP C — POSITION LIMIT REJECTION ──────────────────────────────────────
    await step("C", async () => {
      const store = new FileRiskEventStore(join(dir, "risk-C.jsonl"));
      const engine = new RiskEngine({ store, limits: limits({ maxPositionSize: 0.00001 }) });
      const adapter = createMarketExecutionAdapter({ marketData: demoMarketDataProvider() });
      const deps = createExecutionStage({ adapter, riskGate: gateFor(engine, adapter) });
      const res = await runSignalPipelineTick({ prisma, log: quiet, tickId: "seal8-C", execution: deps });
      assert((res.execution?.filled ?? -1) === 0, "expected 0 fills");
      assert((res.execution?.intentsEmitted ?? -1) === 0, "expected NO ExecutionIntent (no order submitted)");
      assert((res.execution?.blocked ?? 0) >= 1, "expected blocked orders");
      const types = (await store.readAll()).map((r) => r.type);
      assert(types.includes("POSITION_LIMIT_BREACHED"), "POSITION_LIMIT_BREACHED not emitted");
      assert(types.includes("RISK_CHECK_FAILED"), "RISK_CHECK_FAILED not emitted");
      assert(!types.includes("RISK_CHECK_PASSED"), "RISK_CHECK_PASSED wrongly emitted on a rejection");
      cGood = true;
      return `filled=0, intents=0, blocked=${res.execution?.blocked}, events=[${[...new Set(types)].join(",")}]`;
    });

    // ── STEP D — LEVERAGE BREACH ────────────────────────────────────────────────
    await step("D", async () => {
      const store = new FileRiskEventStore(join(dir, "risk-D.jsonl"));
      // maxLeverage below the smallest single-order leverage (demo ~0.16) so the
      // leverage check binds on EVERY order individually (not just the cumulative).
      const engine = new RiskEngine({ store, limits: limits({ maxLeverage: 0.1 }) });
      const adapter = createMarketExecutionAdapter({ marketData: demoMarketDataProvider() });
      const deps = createExecutionStage({ adapter, riskGate: gateFor(engine, adapter) });
      const res = await runSignalPipelineTick({ prisma, log: quiet, tickId: "seal8-D", execution: deps });
      assert((res.execution?.filled ?? -1) === 0, "expected 0 fills");
      assert((res.execution?.intentsEmitted ?? -1) === 0, "expected no order submitted");
      const types = (await store.readAll()).map((r) => r.type);
      assert(types.includes("LEVERAGE_LIMIT_BREACHED"), "LEVERAGE_LIMIT_BREACHED not emitted");
      assert((await store.readAll()).length >= 1, "risk event not persisted");
      dGood = true;
      return `filled=0, blocked=${res.execution?.blocked}, events=[${[...new Set(types)].join(",")}]`;
    });

    // ── STEP E — DAILY LOSS / DRAWDOWN (forced account loss → drawdown halt) ─────
    await step("E", async () => {
      const store = new FileRiskEventStore(join(dir, "risk-E.jsonl"));
      const engine = new RiskEngine({ store, limits: limits({ maxDrawdown: 0.2, dailyLossLimit: 100_000_000 }) });
      const o = mkOrder("BTC-PERP", "LONG", 1, 100);
      const d1 = await engine.evaluate(o, view(1_000_000), {}); // baseline + peak = 1,000,000
      assert(d1.approved, "baseline evaluation should pass");
      const d2 = await engine.evaluate(o, view(700_000), {}); // -30% equity -> drawdown 0.30 > 0.20
      assert(!d2.approved, "drawdown evaluation must be blocked");
      assert(engine.isHalted(), "engine must be halted after drawdown breach");
      const types = (await store.readAll()).map((r) => r.type);
      assert(types.includes("DRAWDOWN_LIMIT_BREACHED"), "DRAWDOWN_LIMIT_BREACHED not emitted");
      assert(engine.state.trigger === "DRAWDOWN_BREACH", `trigger ${engine.state.trigger} != DRAWDOWN_BREACH`);
      return `halted via DRAWDOWN_BREACH; events include DRAWDOWN_LIMIT_BREACHED; order blocked`;
    });

    // ── STEP F — KILL SWITCH ACTIVATION (health trigger; pipeline keeps running) ─
    await step("F", async () => {
      const store = new FileRiskEventStore(join(dir, "risk-F.jsonl"));
      const engine = new RiskEngine({ store, limits: DEFAULT_RISK_LIMITS });
      const d = await engine.evaluate(mkOrder("BTC-PERP", "LONG", 1, 100), view(1_000_000), {
        health: { exchangeConnectivityFailure: true },
      });
      assert(!d.approved, "kill-switch trigger must block the order");
      assert(engine.isHalted(), "engine must be halted");
      const types = (await store.readAll()).map((r) => r.type);
      assert(types.includes("KILL_SWITCH_TRIGGERED"), "KILL_SWITCH_TRIGGERED not emitted");
      assert(types.includes("TRADING_HALTED"), "TRADING_HALTED not emitted");
      // Worker continues running + execution disabled: a real pipeline tick over the
      // halted engine completes (no throw) and fills nothing.
      const adapter = createMarketExecutionAdapter({ marketData: demoMarketDataProvider() });
      const deps = createExecutionStage({ adapter, riskGate: gateFor(engine, adapter) });
      const res = await runSignalPipelineTick({ prisma, log: quiet, tickId: "seal8-F", execution: deps });
      assert((res.execution?.filled ?? -1) === 0, "halted engine must execute nothing");
      assert((res.execution?.blocked ?? 0) >= 1, "halted engine must block orders");
      return `KILL_SWITCH_TRIGGERED + TRADING_HALTED persisted; halted tick filled=0 blocked=${res.execution?.blocked} (pipeline still running)`;
    });

    // ── STEP G — HALT SURVIVES RESTART (real worker process, twice) ─────────────
    await step("G", async () => {
      const journalG = join(dir, "risk-G.jsonl");
      const marketG = join(dir, "market-G.jsonl");
      // Engage a halt durably (a real engage writing to the real journal file).
      const pre = new RiskEngine({ store: new FileRiskEventStore(journalG), limits: DEFAULT_RISK_LIMITS });
      await pre.halt("seal8 pre-shutdown kill-switch drill", "RECOVERY_FAILURE", null);
      const before = (await recoverRiskState(new FileRiskEventStore(journalG))).state;
      assert(before.halted, "pre-shutdown state must be halted");

      const bootHalted = async (tag: string): Promise<WorkerHandle> => {
        const w = spawnWorker({
          DATABASE_URL, REDIS_URL,
          RISK_ENGINE: "on", MARKET_BROKER: "paper",
          RISK_JOURNAL_PATH: journalG, MARKET_JOURNAL_PATH: marketG, SIGNAL_TICK_MS: "1000",
        });
        workers.push(w);
        await waitFor(
          `worker (${tag}) recovers HALTED from the risk journal`,
          async () =>
            w.lines().some(
              (l) => l.includes('"msg":"Phase 8 risk engine enabled"') && l.includes('"halted":true'),
            ),
          { timeoutMs: 40_000, intervalMs: 500 },
        );
        return w;
      };

      const w1 = await bootHalted("boot-1");
      await w1.kill("SIGTERM"); // "stop worker"
      const w2 = await bootHalted("restart"); // "restart worker"
      await w2.kill("SIGTERM");

      const after = (await recoverRiskState(new FileRiskEventStore(journalG))).state;
      if (!eq(after, before)) riskDivergence = `G: recovered ${JSON.stringify(after)} != pre-shutdown ${JSON.stringify(before)}`;
      assert(after.halted, "still halted after restart");
      assert(eq(after, before), "recovered state != pre-shutdown state");
      assert(after.trigger === "RECOVERY_FAILURE", "halt trigger not preserved");
      return `worker recovered HALTED on boot AND after restart; no manual reset; recovered == pre-shutdown`;
    });

    // ── STEP H — RISK JOURNAL TAMPER (fail closed) ──────────────────────────────
    await step("H", async () => {
      const journalH = join(dir, "risk-H.jsonl");
      const engine = new RiskEngine({ store: new FileRiskEventStore(journalH), limits: DEFAULT_RISK_LIMITS });
      await engine.evaluate(mkOrder("BTC-PERP", "LONG", 1, 100_000), view(1_000_000), {}); // valid records
      const recs = await new FileRiskEventStore(journalH).readAll();
      assert(recs.length >= 1, "expected baseline records to tamper");
      // Inject mid-file corruption: line0 valid, line1 garbage (NOT last), line2 valid.
      const line0 = JSON.stringify({ ...recs[0], seq: 0 });
      const line2 = JSON.stringify({ ...recs[0], seq: 1 });
      await writeFile(journalH, `${line0}\n{ broken json mid-file\n${line2}\n`);
      let failedClosed = false;
      try {
        await recoverRiskState(new FileRiskEventStore(journalH));
      } catch (err) {
        failedClosed = err instanceof RiskRecoveryError;
      }
      assert(failedClosed, "tampered journal did NOT fail closed (no RiskRecoveryError)");
      return `mid-file corruption -> recovery aborted with RiskRecoveryError (no fallback, no auto-repair)`;
    });

    // ── STEP I — REPLAY EQUIVALENCE (risk state + capital + exposure + halt) ─────
    await step("I", async () => {
      const riskJournalI = join(dir, "risk-I.jsonl");
      const marketJournalI = join(dir, "market-I.jsonl");
      const store = new FileRiskEventStore(riskJournalI);
      const engine = new RiskEngine({ store, limits: DEFAULT_RISK_LIMITS });
      const adapter = createMarketExecutionAdapter({
        marketData: demoMarketDataProvider(),
        eventStore: new FileMarketEventStore(marketJournalI),
      });
      const deps = createExecutionStage({ adapter, riskGate: gateFor(engine, adapter) });
      await runSignalPipelineTick({ prisma, log: quiet, tickId: "seal8-I", execution: deps });
      // Engage a halt so the equivalence covers a non-trivial halt state too.
      const liveCapital = buildCapitalSnapshot(adapter.getMarketState().account, adapter.getMarketState().positions);
      await engine.halt("seal8 replay-equivalence halt", "DRAWDOWN_BREACH", liveCapital);

      const liveRisk = engine.state;
      const liveExposure = computeExposure(adapter.getMarketState().account, adapter.getMarketState().positions);

      // "Shutdown + recovery" — fresh stores over the same files (real restart path).
      const recRisk = (await recoverRiskState(new FileRiskEventStore(riskJournalI))).state;
      const recMarket = (await recoverMarketState(new FileMarketEventStore(marketJournalI))).marketState;
      const recCapital = buildCapitalSnapshot(recMarket.account, recMarket.positions);
      const recExposure = computeExposure(recMarket.account, recMarket.positions);

      if (!eq(recRisk, liveRisk)) riskDivergence = `I: risk recovered ${JSON.stringify(recRisk)} != live ${JSON.stringify(liveRisk)}`;
      if (!eq(recCapital, liveCapital)) replayMismatch = `I: capital recovered ${JSON.stringify(recCapital)} != live ${JSON.stringify(liveCapital)}`;
      if (!eq(recExposure, liveExposure)) replayMismatch = `I: exposure recovered ${JSON.stringify(recExposure)} != live ${JSON.stringify(liveExposure)}`;

      assert(eq(recRisk, liveRisk), "recovered risk state != live");
      assert(eq(recCapital, liveCapital), "recovered capital snapshot != live");
      assert(eq(recExposure, liveExposure), "recovered exposure != live");
      assert(recRisk.halted && liveRisk.halted, "halt state not identical (both must be halted)");
      return `recovered risk/capital/exposure/halt ALL identical to live before shutdown`;
    });

    // ── STEP J — SYSTEM INTEGRITY (cross-cutting invariants) ────────────────────
    await step("J", async () => {
      // Re-validate from the persisted journals, not in-memory claims.
      const passedB = (await new FileRiskEventStore(join(dir, "risk-B.jsonl")).readAll()).filter((r) => r.type === "RISK_CHECK_PASSED").length;
      const recsC = await new FileRiskEventStore(join(dir, "risk-C.jsonl")).readAll();
      assert(aGood && bGood && cGood && dGood, "a prerequisite runtime step did not pass");
      // every order traversed the risk engine: in B every fill has a journaled PASS.
      assert(passedB >= 1, "no RISK_CHECK_PASSED journaled for the normal flow");
      // no bypass: a rejection journals a failure and NEVER a PASS.
      assert(recsC.length >= 1 && recsC.every((r) => r.type !== "RISK_CHECK_PASSED"), "a blocked run leaked a RISK_CHECK_PASSED");
      assert(recsC.some((r) => r.type === "RISK_CHECK_FAILED"), "no RISK_CHECK_FAILED on a rejection");
      // every risk event journaled + replayable (G/I recovered halts; reconstructable folds).
      assert(riskDivergence === "NONE", `risk state diverged on recovery: ${riskDivergence}`);
      assert(replayMismatch === "NONE", `replay mismatch: ${replayMismatch}`);
      return `no bypass, every order gated, every event journaled + replayable, fail-closed preserved`;
    });
  } finally {
    for (const w of workers) await w.kill("SIGKILL").catch(() => undefined);
    await prisma.$disconnect().catch(() => undefined);
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }

  // ── Report (exact mission format) ───────────────────────────────────────────
  const order = ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J"];
  const byStep = new Map(results.map((r) => [r.step, r]));
  const lines = order.map((s) => `STEP ${s}: ${byStep.get(s)?.pass ? "PASS" : "FAIL"}`);
  const allPass = order.every((s) => byStep.get(s)?.pass === true);
  const out = [
    "",
    "════════════════════════ PHASE 8 RUNTIME SEAL — RESULT ════════════════════════",
    ...lines,
    "",
    `First failure point: ${allPass ? "NONE" : firstFailure || "unknown"}`,
    `Replay mismatch: ${replayMismatch}`,
    `Risk divergence: ${riskDivergence}`,
    "",
    `Final Result:`,
    "",
    allPass ? "PHASE 8 RUNTIME SEAL: SEALED" : "PHASE 8 RUNTIME SEAL: UNSEALED",
    "════════════════════════════════════════════════════════════════════════════",
  ].join("\n");
  // eslint-disable-next-line no-console
  console.log(out);
  process.exit(allPass ? 0 : 1);
}

main().catch((err) => {
  log("error", "PHASE 8 RUNTIME SEAL — fatal", { error: msg(err) });
  if (err instanceof Error && err.stack) console.error(err.stack);
  process.exit(1);
});
