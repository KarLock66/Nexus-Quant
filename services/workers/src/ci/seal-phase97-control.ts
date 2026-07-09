/**
 * PHASE 9.7 — PRODUCTION CONTROL PLANE RUNTIME SEAL (real infrastructure only).
 *
 *   pnpm --filter @nexus/workers exec tsx src/ci/seal-phase97-control.ts
 *
 * Proves the control plane CONTROLS, PROTECTS, and RECOVERS under REAL execution —
 * live Postgres + Redis (docker/docker-compose.ci.yml) + a reachable quant service +
 * the REAL worker process + the REAL execution pipeline + the REAL @nexus/control
 * evaluators. No mocks of the decision logic; the enforcement seam (the composed control
 * gate in front of the risk gate) really blocks real pipeline ticks.
 *
 * Step → acceptance criterion (Section L):
 *   A bootstrap        real worker (CONTROL_PLANE=on) boots BOOTING→STARTING→HEALTHY (real probes)
 *   B healthy allows    HEALTHY control plane + gate → real tick FILLS (control-on never blocks a clean trade)
 *   C manual kill        engage kill (real DB) → state STOPPED + real tick BLOCKED; resume → HEALTHY
 *   D quant down         dead-port quant probe → PROTECTED + Incident opened + real tick BLOCKED
 *   E database unreachable gate's DB read throws → real tick BLOCKED (FAIL_CLOSED)
 *   F feature stale      real evaluator over a stale feature input → BLOCKED + real tick BLOCKED
 *   G recovery verified  quant returns healthy → PROTECTED→RECOVERING→HEALTHY (verified) → real tick FILLS
 *   H audit + timeline   audit trail + incident timeline persisted; latest state == what the web reads
 *   I kill survives restart real worker reboot with kill engaged → comes back STOPPED
 *   J no regression      control-OFF real tick still FILLS (sealed path byte-for-byte)
 *   K manual-resume close PROTECTED→kill→resume closes the incident MANUAL_RESUME (no orphan)
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prisma } from "@nexus/db";
import { assertDestructiveDbAllowed } from "./destructive-guard.js";
import { ensureCiFixtureLineage, fixtureQuoteProvider } from "./fixtures.js";
import {
  evaluateTradingPermission,
  FRESHNESS_BANDS,
  type ControlInputs,
} from "@nexus/control";
import {
  assertDbReachable,
  log,
  makeLog,
  msg,
  spawnWorker,
  waitFor,
  type WorkerHandle,
} from "./lib.js";
import {
  createExecutionStage,
  type ProposedAllocation,
  type RiskGateHook,
} from "../execution/index.js";
import { emptyPortfolioState } from "../execution/portfolio.js";
import { runSignalPipelineTick } from "../pipeline/orchestrator.js";
import { createMarketExecutionAdapter } from "../market/index.js";
import {
  DEFAULT_RISK_LIMITS,
  FileRiskEventStore,
  RiskEngine,
  createRiskExecutionGate,
} from "../risk/index.js";
import {
  ControlPlane,
  createControlExecutionGate,
  engageKillSwitch,
  gatherControlInputs,
  getCurrentState,
  getKillSwitch,
  resumeKillSwitch,
} from "../control/index.js";

const DATABASE_URL = process.env["DATABASE_URL"] ?? "";
const REDIS_URL = process.env["REDIS_URL"] ?? "redis://localhost:6379";
const QUANT_URL = process.env["QUANT_SERVICE_URL"] ?? "http://localhost:8000";
const DEAD_QUANT_URL = "http://127.0.0.1:59997"; // closed port → real failing probe
const quiet = makeLog("warn");

let dir = "";
const SAMPLE = { symbol: "BTC-PERP", side: "LONG", targetNotional: "1000.00", contributions: [] } as unknown as ProposedAllocation;
const SAMPLE_STATE = emptyPortfolioState();

// ── Results recorder ───────────────────────────────────────────────────────────
interface StepResult { step: string; pass: boolean; detail: string }
const results: StepResult[] = [];
let firstFailure = "";

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

// ── Real execution helpers ───────────────────────────────────────────────────
function gateFor(engine: RiskEngine, adapter: ReturnType<typeof createMarketExecutionAdapter>): RiskGateHook {
  return createRiskExecutionGate({
    engine,
    getView: () => adapter.getMarketState(),
    getQuote: (s) => adapter.marketData.quote(s),
  });
}
function compose(control: RiskGateHook, risk: RiskGateHook): RiskGateHook {
  return async (p, s) => {
    const d = await control(p, s);
    return d.approved ? risk(p, s) : d;
  };
}

/** Run ONE real pipeline tick; `controlHook` (if given) is composed ahead of the risk gate. */
async function runTick(tag: string, controlHook: RiskGateHook | null) {
  const store = new FileRiskEventStore(join(dir, `risk-${tag}.jsonl`));
  const engine = new RiskEngine({ store, limits: DEFAULT_RISK_LIMITS });
  const adapter = createMarketExecutionAdapter({ marketData: fixtureQuoteProvider() });
  const risk = gateFor(engine, adapter);
  const gate = controlHook ? compose(controlHook, risk) : risk;
  const deps = createExecutionStage({ adapter, riskGate: gate });
  const res = await runSignalPipelineTick({ prisma, log: quiet, tickId: `seal97-${tag}`, execution: deps });
  return res.execution ?? { proposed: 0, intentsEmitted: 0, filled: 0, rejected: 0, blocked: 0 };
}

/**
 * Make feature + signal freshness deterministically FRESH: a control-off tick seeds an
 * EngineSignal, then we stamp the newest feature + signal createdAt to now. This isolates
 * each step's injected condition (so a long-running seal does not drift into feature.stale).
 */
async function refreshFreshness(): Promise<void> {
  await runTick("seed", null).catch(() => undefined);
  const fs = await prisma.featureSnapshot.findFirst({ orderBy: { createdAt: "desc" }, select: { id: true } });
  if (fs) await prisma.featureSnapshot.update({ where: { id: fs.id }, data: { createdAt: new Date() } });
  const sig = await prisma.engineSignal.findFirst({ orderBy: { createdAt: "desc" }, select: { id: true } });
  if (sig) await prisma.engineSignal.update({ where: { id: sig.id }, data: { createdAt: new Date() } });
}

function controlGateFor(cp: ControlPlane): RiskGateHook {
  return createControlExecutionGate({
    readKillSwitch: () => getKillSwitch(),
    currentPermission: () => cp.currentPermission(),
    log: quiet,
  });
}

async function clearControlTables(): Promise<void> {
  assertDestructiveDbAllowed();
  await prisma.controlAuditLog.deleteMany({});
  await prisma.protectionEvent.deleteMany({});
  await prisma.incident.deleteMany({});
  await prisma.runtimeStateTransition.deleteMany({});
  await prisma.controlKillSwitch.deleteMany({});
}

async function main(): Promise<void> {
  log("info", "PHASE 9.7 CONTROL PLANE SEAL — start", {
    db: DATABASE_URL.replace(/:[^:@]*@/, ":***@"),
    redis: REDIS_URL,
    quant: QUANT_URL,
  });
  dir = await mkdtemp(join(tmpdir(), "nexus-seal97-"));
  const workers: WorkerHandle[] = [];

  try {
    await assertDbReachable();
    await ensureCiFixtureLineage(prisma);
    await clearControlTables();

    // ── STEP A — BOOTSTRAP (real worker, real probes, BOOTING→STARTING→HEALTHY) ──
    await step("A", async () => {
      await refreshFreshness();
      const w = spawnWorker({
        DATABASE_URL, REDIS_URL, QUANT_SERVICE_URL: QUANT_URL,
        CONTROL_PLANE: "on", RISK_ENGINE: "on", MARKET_BROKER: "paper", SIGNAL_TICK_MS: "1500",
      });
      workers.push(w);
      await waitFor(
        "worker control plane validated + runtime HEALTHY",
        async () => {
          const validated = w.lines().some((l) => l.includes("control plane: startup validated"));
          const healthy = (await getCurrentState()) === "HEALTHY";
          return validated && healthy;
        },
        { timeoutMs: 60_000, intervalMs: 700 },
      );
      const states = (await prisma.runtimeStateTransition.findMany({ orderBy: { enteredAt: "asc" }, select: { state: true } })).map((r) => r.state);
      await w.kill("SIGTERM");
      assert(states.includes("BOOTING") && states.includes("STARTING") && states.includes("HEALTHY"), `boot sequence incomplete: ${states.join("→")}`);
      return `real worker booted ${states.join("→")}; startup validated against live db/redis/quant`;
    });

    // Shared in-process control plane for the B→D→G lifecycle (real evaluators + DB).
    const cp = new ControlPlane({ log: quiet, getRiskActive: () => true, redisUrl: REDIS_URL, quantUrl: QUANT_URL });
    await cp.boot();

    // ── STEP B — HEALTHY ALLOWS TRADING ────────────────────────────────────────
    await step("B", async () => {
      await refreshFreshness();
      const r = await cp.evaluate();
      assert(r.state === "HEALTHY", `expected HEALTHY, got ${r.state}: ${JSON.stringify(r.permission.blockedBy)}`);
      assert(r.permission.permission === "ALLOWED", `permission should be ALLOWED: ${JSON.stringify(r.permission.blockedBy)}`);
      const res = await runTick("B", controlGateFor(cp));
      assert(res.filled >= 1, `HEALTHY control plane must not block a clean trade (filled=${res.filled})`);
      return `state HEALTHY, permission ALLOWED, control-gated tick filled=${res.filled}`;
    });

    // ── STEP C — MANUAL KILL SWITCH → BLOCKED (then resume) ─────────────────────
    await step("C", async () => {
      await engageKillSwitch("seal-operator", "9.7 kill drill");
      const ev = await cp.evaluate();
      assert(ev.state === "STOPPED", `expected STOPPED, got ${ev.state}`);
      const decision = await controlGateFor(cp)(SAMPLE, SAMPLE_STATE);
      assert(!decision.approved && decision.reason === "TRADING_STOPPED", `kill block reason: ${JSON.stringify(decision)}`);
      const res = await runTick("C", controlGateFor(cp));
      assert(res.filled === 0 && res.blocked >= 1, `kill must block all execution (filled=${res.filled}, blocked=${res.blocked})`);
      // Resume → re-evaluate back to HEALTHY.
      await resumeKillSwitch("seal-operator", "drill complete");
      await refreshFreshness();
      const back = await cp.evaluate();
      assert(back.state === "HEALTHY", `resume should return HEALTHY, got ${back.state}`);
      return `kill → STOPPED + tick filled=0 blocked=${res.blocked}; resume → ${back.state}`;
    });

    // ── STEP D — QUANT DOWN → PROTECTED + INCIDENT + BLOCKED ─────────────────────
    await step("D", async () => {
      await refreshFreshness();
      cp.quantUrl = DEAD_QUANT_URL; // real probe against a closed port → failing
      const ev = await cp.evaluate();
      assert(ev.state === "PROTECTED", `expected PROTECTED, got ${ev.state}`);
      const active = await prisma.protectionEvent.findMany({ where: { status: "ACTIVE" }, select: { ruleId: true } });
      assert(active.some((a) => a.ruleId === "quant.unavailable"), `quant.unavailable not active: ${active.map((a) => a.ruleId)}`);
      const open = await prisma.incident.count({ where: { status: "OPEN" } });
      assert(open >= 1, "no OPEN incident opened on protection");
      const decision = await controlGateFor(cp)(SAMPLE, SAMPLE_STATE);
      assert(!decision.approved, `quant-down must block: ${JSON.stringify(decision)}`);
      const res = await runTick("D", controlGateFor(cp));
      assert(res.filled === 0 && res.blocked >= 1, `quant down must block execution (filled=${res.filled})`);
      return `quant dead-port → PROTECTED, incident opened, tick filled=0 blocked=${res.blocked}`;
    });

    // ── STEP E — DATABASE UNREACHABLE → FAIL-CLOSED BLOCK ───────────────────────
    await step("E", async () => {
      const dbDownGate = createControlExecutionGate({
        readKillSwitch: async () => { throw new Error("database unreachable"); },
        currentPermission: () => ({ permission: "ALLOWED", generatedAt: Date.now(), reasons: [], blockedBy: [] }),
        log: quiet,
      });
      const decision = await dbDownGate(SAMPLE, SAMPLE_STATE);
      assert(!decision.approved && decision.reason === "FAIL_CLOSED", `db-down must fail closed: ${JSON.stringify(decision)}`);
      const res = await runTick("E", dbDownGate);
      assert(res.filled === 0 && res.blocked >= 1, `db unreachable must block execution (filled=${res.filled})`);
      return `control-state read failure → FAIL_CLOSED block, tick filled=0 blocked=${res.blocked}`;
    });

    // ── STEP F — FEATURE STALE → BLOCKED ────────────────────────────────────────
    await step("F", async () => {
      const realInputs = await gatherControlInputs({
        redisUrl: REDIS_URL, quantUrl: QUANT_URL, getRiskActive: () => true,
        lastExecutionAt: null, startupValidated: true,
      });
      const stale: ControlInputs = {
        ...realInputs,
        features: { lagSeconds: FRESHNESS_BANDS.features.staleSeconds + 120, warningSeconds: FRESHNESS_BANDS.features.warningSeconds, staleSeconds: FRESHNESS_BANDS.features.staleSeconds },
      };
      const perm = evaluateTradingPermission(stale, "HEALTHY");
      assert(perm.permission === "BLOCKED" && perm.blockedBy.some((b) => b.check === "feature_freshness"), `stale feature must block: ${JSON.stringify(perm.blockedBy)}`);
      const staleGate = createControlExecutionGate({
        readKillSwitch: () => getKillSwitch(),
        currentPermission: () => perm,
        log: quiet,
      });
      const res = await runTick("F", staleGate);
      assert(res.filled === 0 && res.blocked >= 1, `stale features must block execution (filled=${res.filled})`);
      return `feature lag > ${FRESHNESS_BANDS.features.staleSeconds}s → BLOCKED, tick filled=0 blocked=${res.blocked}`;
    });

    // ── STEP G — RECOVERY VERIFIED → RESUMED ────────────────────────────────────
    await step("G", async () => {
      cp.quantUrl = QUANT_URL; // quant returns healthy
      await refreshFreshness();
      const ev = await cp.evaluate(); // PROTECTED → RECOVERING → (verify) → HEALTHY
      assert(ev.state === "HEALTHY", `recovery should reach HEALTHY, got ${ev.state}: ${JSON.stringify(ev.permission.blockedBy)}`);
      const transitions = (await prisma.runtimeStateTransition.findMany({ orderBy: { enteredAt: "asc" }, select: { previousState: true, state: true } }))
        .map((t) => `${t.previousState ?? "∅"}→${t.state}`);
      assert(transitions.includes("PROTECTED→RECOVERING"), `missing PROTECTED→RECOVERING: ${transitions.slice(-6)}`);
      assert(transitions.includes("RECOVERING→HEALTHY"), `missing RECOVERING→HEALTHY: ${transitions.slice(-6)}`);
      const resolved = await prisma.incident.findFirst({ where: { status: "RESOLVED" }, orderBy: { endedAt: "desc" } });
      assert(resolved?.recoveryOutcome === "VERIFIED", `incident not resolved VERIFIED: ${JSON.stringify(resolved)}`);
      assert(resolved?.durationSec !== null && resolved?.durationSec !== undefined, "resolved incident missing durationSec");
      const res = await runTick("G", controlGateFor(cp));
      assert(res.filled >= 1, `trading must resume after verified recovery (filled=${res.filled})`);
      return `PROTECTED→RECOVERING→HEALTHY (verified); incident RESOLVED (${resolved?.durationSec}s); resumed tick filled=${res.filled}`;
    });

    // ── STEP H — AUDIT + INCIDENT TIMELINE PERSISTED + STATE REFLECTS LIVE ───────
    await step("H", async () => {
      const audit = await prisma.controlAuditLog.findMany({ select: { action: true } });
      const actions = new Set(audit.map((a) => a.action));
      for (const need of ["KILL", "RESUME", "STATE_CHANGE", "PROTECTION_ENGAGED", "RECOVERY_VERIFIED", "INCIDENT_RESOLVED"]) {
        assert(actions.has(need), `audit missing action ${need}; present: ${[...actions].join(",")}`);
      }
      const incidents = await prisma.incident.count();
      const resolvedCount = await prisma.incident.count({ where: { status: "RESOLVED" } });
      assert(incidents >= 1 && resolvedCount >= 1, "incident timeline not recorded");
      const current = await getCurrentState();
      assert(current === "HEALTHY", `web-visible state should be HEALTHY, got ${current}`);
      return `audit actions={${[...actions].join(",")}}; incidents=${incidents} (resolved=${resolvedCount}); latest state=${current}`;
    });

    // ── STEP I — KILL SURVIVES RESTART (real worker reboot) ─────────────────────
    await step("I", async () => {
      await engageKillSwitch("seal-operator", "restart-survival drill");
      const w = spawnWorker({
        DATABASE_URL, REDIS_URL, QUANT_SERVICE_URL: QUANT_URL,
        CONTROL_PLANE: "on", RISK_ENGINE: "on", MARKET_BROKER: "paper", SIGNAL_TICK_MS: "1500",
      });
      workers.push(w);
      await waitFor(
        "rebooted worker comes back STOPPED (kill survived restart)",
        async () => (await getCurrentState()) === "STOPPED",
        { timeoutMs: 60_000, intervalMs: 700 },
      );
      await w.kill("SIGTERM");
      await resumeKillSwitch("seal-operator", "restart drill complete");
      return `worker reboot with kill engaged → runtime STOPPED (DB-backed kill survives restart)`;
    });

    // ── STEP J — NO REGRESSION (control OFF path still fills) ────────────────────
    await step("J", async () => {
      await refreshFreshness();
      const res = await runTick("J", null); // no control gate → sealed Phase-8 path
      assert(res.filled >= 1, `control-off path must be unchanged (filled=${res.filled})`);
      return `control-off real tick filled=${res.filled} (sealed path byte-for-byte)`;
    });

    // ── STEP K — INCIDENT CLOSED ON MANUAL RESUME (PROTECTED→KILL→RESUME) ─────────
    // Regression guard for the orphaned-incident defect: an incident opened on PROTECTED
    // must not be left perpetually OPEN when the operator kills then resumes (which skips
    // the RECOVERING path). It must close as MANUAL_RESUME with a real duration.
    await step("K", async () => {
      // (1) Break quant → PROTECTED opens a fresh incident.
      await refreshFreshness();
      cp.quantUrl = DEAD_QUANT_URL;
      const prot = await cp.evaluate();
      assert(prot.state === "PROTECTED", `expected PROTECTED, got ${prot.state}`);
      const openId = (await prisma.incident.findFirst({ where: { status: "OPEN" }, orderBy: { startedAt: "desc" }, select: { id: true } }))?.id;
      assert(openId, "no OPEN incident after PROTECTED");
      // (2) Operator kills WHILE protected → STOPPED; the incident must stay OPEN.
      await engageKillSwitch("seal-operator", "kill during open incident");
      const stopped = await cp.evaluate();
      assert(stopped.state === "STOPPED", `expected STOPPED, got ${stopped.state}`);
      const underKill = await prisma.incident.findUnique({ where: { id: openId }, select: { status: true } });
      assert(underKill?.status === "OPEN", `incident must stay OPEN under kill, got ${underKill?.status}`);
      // (3) Restore quant + resume → STOPPED→HEALTHY; the open incident closes MANUAL_RESUME.
      cp.quantUrl = QUANT_URL;
      await resumeKillSwitch("seal-operator", "manual resume after incident");
      await refreshFreshness();
      const back = await cp.evaluate();
      assert(back.state === "HEALTHY", `manual resume should reach HEALTHY, got ${back.state}: ${JSON.stringify(back.permission.blockedBy)}`);
      const closed = await prisma.incident.findUnique({ where: { id: openId } });
      assert(closed?.status === "RESOLVED", `incident not resolved after manual resume: ${closed?.status}`);
      assert(closed?.recoveryOutcome === "MANUAL_RESUME", `expected MANUAL_RESUME outcome, got ${closed?.recoveryOutcome}`);
      assert(closed?.durationSec !== null && closed?.durationSec !== undefined, "manually-resumed incident missing durationSec");
      return `PROTECTED→KILL(STOPPED, incident OPEN)→RESUME→HEALTHY; incident RESOLVED MANUAL_RESUME (${closed?.durationSec}s)`;
    });
  } finally {
    for (const w of workers) await w.kill("SIGKILL").catch(() => undefined);
    await prisma.$disconnect().catch(() => undefined);
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }

  // ── Report ──────────────────────────────────────────────────────────────────
  const order = ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "K"];
  const byStep = new Map(results.map((r) => [r.step, r]));
  const lines = order.map((s) => `STEP ${s}: ${byStep.get(s)?.pass ? "PASS" : "FAIL"}`);
  const allPass = order.every((s) => byStep.get(s)?.pass === true);
  const out = [
    "",
    "════════════════════ PHASE 9.7 CONTROL PLANE SEAL — RESULT ════════════════════",
    ...lines,
    "",
    `First failure point: ${allPass ? "NONE" : firstFailure || "unknown"}`,
    "",
    allPass ? "PHASE 9.7 CONTROL PLANE SEAL: SEALED" : "PHASE 9.7 CONTROL PLANE SEAL: UNSEALED",
    "════════════════════════════════════════════════════════════════════════════",
  ].join("\n");
  // eslint-disable-next-line no-console
  console.log(out);
  process.exit(allPass ? 0 : 1);
}

main().catch((err) => {
  log("error", "PHASE 9.7 CONTROL PLANE SEAL — fatal", { error: msg(err) });
  if (err instanceof Error && err.stack) console.error(err.stack);
  process.exit(1);
});
