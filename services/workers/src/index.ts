import { prisma } from "@nexus/db";
import {
  createDecisionBus,
  createExecutionStage,
  createPersistenceSubscriber,
  type DecisionEvent,
  type EventBus,
  type ExecutionStageDeps,
  type RiskGateHook,
} from "./execution/index.js";
import {
  DEFAULT_ACCOUNT_CONFIG,
  DbQuoteTransport,
  DeribitOrderTransport,
  FileMarketEventStore,
  PortfolioLedger,
  RealtimeProvider,
  createMarketExecutionAdapter,
  createRealBroker,
  demoMarketDataProvider,
  readDeribitEnvConfig,
  readPortfolioLedgerEnabled,
  readPortfolioLedgerIdentity,
  recoverMarketState,
  resolveBroker,
  type BrokerAdapter,
  type MarketDataProvider,
  type MarketEventStore,
  type MarketExecutionAdapter,
  type RecoveredMarketState,
} from "./market/index.js";
import {
  BUS_CHANNELS,
  createBullMqDecisionBus,
  createRedisDecisionBus,
  readBusBackend,
  type QueueLike,
  type RedisLike,
  type WorkerFactory,
} from "./bus/index.js";
import {
  FileRiskEventStore,
  InMemoryRiskEventStore,
  RiskEngine,
  createRiskExecutionGate,
  recoverRiskState,
  type RiskEventStore,
} from "./risk/index.js";
import {
  ControlPlane,
  createControlExecutionGate,
  getKillSwitch,
} from "./control/index.js";
import { errMsg, log } from "./lib/log.js";
import { runSignalPipelineTick } from "./pipeline/orchestrator.js";

/**
 * Workers service runtime (M1 signal pipeline, Phase 4 layering, Phase 7 durability).
 *
 * An interval-based orchestrator: every tick runs the deterministic pipeline
 * (ensure upstream -> observe -> verify lineage -> decide -> publish). The logical
 * event bus is created ONCE at startup and shared across ticks — production (the
 * tick loop) is decoupled from consumption (the persistence subscriber), so a
 * Redis/BullMQ bridge can attach at the same seam without touching the loop. Runs
 * once immediately on boot so EngineSignal rows exist promptly, then on a fixed
 * interval. Ticks never overlap (a slow tick is skipped, not stacked).
 *
 * Phase 7 adds, all OPT-IN and DEFAULT-OFF so the Phase 1-6 runtime is unchanged:
 *   - distributed bus  (BUS_BACKEND=redis|bullmq + REDIS_URL): the decision bus runs
 *     over Redis/BullMQ instead of in-process; default stays in-process.
 *   - durable journal  (MARKET_JOURNAL_PATH, requires MARKET_BROKER): committed
 *     executions are appended to an append-only store and, on boot, the market /
 *     portfolio state is RECONSTRUCTED from that journal — FAIL-CLOSED: an
 *     unreconstructable or divergent history halts execution (signals still flow).
 */

function readTickMs(): number {
  const raw = Number.parseInt(process.env["SIGNAL_TICK_MS"] ?? "15000", 10);
  if (!Number.isFinite(raw) || raw < 1000) return 15000;
  return raw;
}

const TICK_MS = readTickMs();
// Boot-stable correlation prefix: a restart yields a new BOOT_ID, so tickIds are
// never reused across process lifetimes (crash-restart logs stay disambiguable).
const BOOT_ID = `${process.pid.toString(36)}-${Date.now().toString(36)}`;
let timer: ReturnType<typeof setInterval> | undefined;
let running = false;
let tickCount = 0;

// Long-lived seams, built in main() (recovery is async): the logical decision bus
// the tick loop publishes to, and the opt-in execution stage it drives.
let bus: EventBus;
let execution: ExecutionStageDeps | undefined;

// Phase 9.7 control plane (opt-in via CONTROL_PLANE=on; default-off). When enabled, a
// control evaluator runs each tick and a fail-closed control gate is composed IN FRONT
// of the Phase-8 risk gate. `riskEngineRef` exposes the live risk engine so the control
// plane can report whether risk is armed (a Section B trade condition).
let controlPlane: ControlPlane | undefined;
let riskEngineRef: RiskEngine | undefined;

// Persistent portfolio & equity ledger (opt-in via PORTFOLIO_LEDGER=on): each tick
// snapshots the live market account into PortfolioSnapshot (durable equity series).
let portfolioLedger: PortfolioLedger | undefined;
let marketAdapterRef: MarketExecutionAdapter | undefined;

function readControlPlaneEnabled(): boolean {
  return process.env["CONTROL_PLANE"] === "on";
}
const controlPlaneEnabled = readControlPlaneEnabled();

/**
 * Demo-chain bootstrap is OPT-IN via DEMO_MODE (the platform-wide demo flag) and
 * DEFAULT-OFF: a bare production worker never upserts the synthetic demo lineage —
 * it resolves persisted rows and skips ticks (fail-closed) until a real lineage
 * exists. CI spawners set DEMO_MODE=true explicitly (their invariants are keyed
 * on the demo lineage).
 */
function readDemoMode(): boolean {
  const raw = process.env["DEMO_MODE"];
  return raw !== undefined && ["true", "1", "yes"].includes(raw.trim().toLowerCase());
}
const demoMode = readDemoMode();

/** Risk is "active" for the control plane iff opted in, built, and not halted. */
function isRiskActive(): boolean {
  return readRiskEngineEnabled() && riskEngineRef !== undefined && !riskEngineRef.isHalted();
}

/**
 * Compose pre-trade gates into the single execution-stage hook slot: each runs in order
 * and the FIRST block wins (fail-closed). The control gate is placed ahead of the risk
 * gate so a STOPPED/BLOCKED control verdict short-circuits before risk evaluation.
 */
function composeGates(...gates: (RiskGateHook | undefined)[]): RiskGateHook | undefined {
  const list = gates.filter((g): g is RiskGateHook => g !== undefined);
  if (list.length === 0) return undefined;
  if (list.length === 1) return list[0];
  return async (proposal, state) => {
    for (const g of list) {
      const decision = await g(proposal, state);
      if (!decision.approved) return decision;
    }
    return { approved: true };
  };
}

// Phase 6 market integration is OPT-IN and DEFAULT-OFF: only when MARKET_BROKER is
// explicitly set does the execution stage run through the broker-backed market
// adapter. Unset (the default, and what CI phases 1-4 spawn) preserves the Phase 5
// paper-adapter behavior byte-for-byte. `real` routes to the LIVE venue via the
// Deribit private-API transport — gated by buildBroker()'s fail-closed checks.
function readMarketBroker(): "paper" | "simulated" | "real" | undefined {
  const raw = process.env["MARKET_BROKER"];
  return raw === "paper" || raw === "simulated" || raw === "real" ? raw : undefined;
}
const marketBroker = readMarketBroker();

/**
 * Resolve the broker for the execution stage. paper/simulated stay the
 * deterministic Phase 6 brokers. `real` is the LIVE venue path and is armed
 * ONLY when every production prerequisite holds — otherwise undefined is
 * returned and execution stays UNARMED (fail-closed; signals still flow):
 *   - DEMO_MODE must be OFF (real orders must never mark against demo quotes)
 *   - MARKET_DATA_SOURCE=realtime (real marks are required to size real orders)
 *   - MARKET_JOURNAL_PATH set (a live venue position without a durable local
 *     journal could not be reconstructed after a restart)
 *   - Deribit credentials present + valid (DERIBIT_CLIENT_ID/SECRET; DERIBIT_ENV
 *     defaults to the TEST venue — live trading requires the explicit "live")
 */
function buildBroker(kind: "paper" | "simulated" | "real"): BrokerAdapter | undefined {
  if (kind !== "real") return resolveBroker(kind);

  const refuse = (detail: string): undefined => {
    log("error", "MARKET_BROKER=real refused — execution unarmed (fail-closed)", {
      component: "market.broker",
      category: "CONFIG",
      severity: "CRITICAL",
      detail,
    });
    return undefined;
  };
  if (demoMode) {
    return refuse("DEMO_MODE is enabled; a real venue must never run with synthetic demo marks");
  }
  if (process.env["MARKET_DATA_SOURCE"] !== "realtime") {
    return refuse("MARKET_DATA_SOURCE=realtime is required to size/mark real orders");
  }
  if (readJournalPath() === undefined) {
    return refuse("MARKET_JOURNAL_PATH is required for a real venue (restart reconstruction)");
  }
  const cfg = readDeribitEnvConfig();
  if (!cfg.ok) {
    return refuse(`Deribit venue config invalid/missing: ${cfg.missing.join(", ")}`);
  }
  const transport = new DeribitOrderTransport({
    clientId: cfg.config.clientId,
    clientSecret: cfg.config.clientSecret,
    env: cfg.config.env,
    ...(cfg.config.instrumentMap ? { instrumentMap: cfg.config.instrumentMap } : {}),
    logger: log,
  });
  log(cfg.config.env === "live" ? "warn" : "info", "REAL venue order routing armed (Deribit)", {
    component: "market.broker",
    venueEnv: cfg.config.env,
    live: cfg.config.env === "live",
  });
  return createRealBroker(transport);
}

/** Phase 7 durability is opt-in via an explicit journal path (default-off). */
function readJournalPath(): string | undefined {
  const raw = process.env["MARKET_JOURNAL_PATH"];
  return raw !== undefined && raw.trim() !== "" ? raw : undefined;
}

/** Phase 8 risk engine is opt-in via RISK_ENGINE=on (requires MARKET_BROKER; default-off). */
function readRiskEngineEnabled(): boolean {
  return process.env["RISK_ENGINE"] === "on";
}

/**
 * Phase 9 market-data source (zero-demo discipline).
 *
 *   MARKET_DATA_SOURCE=realtime  -> the REAL exchange feed (the marks the ingestion
 *                                   daemon persists), served through the Phase 7
 *                                   RealtimeProvider over a DB-backed transport.
 *                                   DEMO-venue rows are excluded unless DEMO_MODE.
 *   unset + DEMO_MODE=true       -> deterministic demo quotes (explicit opt-in only;
 *                                   CI harnesses and the local demo stack).
 *   unset + no DEMO_MODE         -> returns undefined — FAIL-CLOSED. A production
 *                                   broker must never silently mark real orders
 *                                   against synthetic demo quotes; the caller leaves
 *                                   execution UNARMED (signals still flow).
 */
function buildMarketDataProvider(): MarketDataProvider | undefined {
  if (process.env["MARKET_DATA_SOURCE"] === "realtime") {
    const transport = new DbQuoteTransport(prisma, { allowDemoVenue: demoMode });
    transport.start();
    log("info", "Phase 9 realtime market-data provider enabled (DB-backed real marks)", {
      demoVenueAdmitted: demoMode,
    });
    return new RealtimeProvider(transport);
  }
  if (demoMode) {
    log("warn", "DEMO_MODE: execution will mark orders against synthetic demo quotes");
    return demoMarketDataProvider();
  }
  return undefined;
}

/** Phase 8 durable risk journal path (default: in-memory, lost on restart). */
function readRiskJournalPath(): string | undefined {
  const raw = process.env["RISK_JOURNAL_PATH"];
  return raw !== undefined && raw.trim() !== "" ? raw : undefined;
}

/**
 * Build the Phase 8 risk-engine hook over the market adapter. OPT-IN (RISK_ENGINE=on)
 * and default-off: returns undefined otherwise, leaving the execution stage byte-for-
 * byte Phase 5/6/7. On boot the risk state is RECOVERED from the risk journal; a
 * corrupt/unreadable journal is FAIL-CLOSED — the engine starts HALTED (the kill
 * switch engages JOURNAL_INTEGRITY_FAILURE) so no order executes until an explicit
 * reset, while signals keep flowing.
 */
async function buildRiskGate(
  adapter: MarketExecutionAdapter,
): Promise<RiskGateHook | undefined> {
  if (!readRiskEngineEnabled()) return undefined;

  const journalPath = readRiskJournalPath();
  let store: RiskEventStore = journalPath
    ? new FileRiskEventStore(journalPath)
    : new InMemoryRiskEventStore();

  let engine: RiskEngine;
  try {
    const recovered = await recoverRiskState(store);
    engine = new RiskEngine({ store, state: recovered.state });
    log("info", "Phase 8 risk engine enabled", {
      durable: journalPath !== undefined,
      riskRecordsReplayed: recovered.recordsReplayed,
      halted: recovered.state.halted,
      trigger: recovered.state.trigger,
    });
  } catch (err) {
    // FAIL-CLOSED: an unreadable risk journal halts trading. Use a fresh in-memory
    // store so the halt is recordable without touching the corrupt file.
    log("error", "Phase 8 risk recovery FAILED — starting HALTED (fail-closed)", {
      component: "risk.recovery",
      category: "INFRA",
      severity: "CRITICAL",
      detail: errMsg(err),
    });
    store = new InMemoryRiskEventStore();
    engine = new RiskEngine({ store });
    await engine
      .halt(`risk journal unreadable: ${errMsg(err)}`, "JOURNAL_INTEGRITY_FAILURE")
      .catch(() => undefined);
  }

  // Expose the engine so the Phase 9.7 control plane can report risk-armed state.
  riskEngineRef = engine;
  return createRiskExecutionGate({
    engine,
    getView: () => adapter.getMarketState(),
    getQuote: (symbol) => adapter.marketData.quote(symbol),
  });
}

/**
 * Build the decision bus for the selected backend. In-process is the default and
 * is byte-identical to prior behavior; redis/bullmq wire the Phase 7 bridge (the
 * persistence subscriber attaches to the same seam regardless). Any misconfig
 * (backend set without REDIS_URL) falls back to in-process — the bus is infra, not
 * the fail-closed execution path.
 */
async function buildDecisionBus(): Promise<EventBus> {
  const backend = readBusBackend(process.env["BUS_BACKEND"]);
  if (backend === "inprocess") return createDecisionBus({ prisma, log });

  const redisUrl = process.env["REDIS_URL"];
  if (redisUrl === undefined || redisUrl === "") {
    log("warn", "BUS_BACKEND set but REDIS_URL missing — using in-process bus", { backend });
    return createDecisionBus({ prisma, log });
  }

  const persist = createPersistenceSubscriber({ prisma, log });
  if (backend === "redis") {
    const { Redis } = await import("ioredis");
    const publisher = new Redis(redisUrl) as unknown as RedisLike;
    const distributed = createRedisDecisionBus(publisher);
    distributed.subscribe(persist);
    log("info", "Phase 7 distributed bus enabled", { backend: "redis (pub/sub)" });
    return distributed;
  }

  // bullmq — durable at-least-once delivery. BullMQ takes an ioredis connection;
  // the options are cast to each constructor's own parameter type to bypass a
  // cross-version ioredis type mismatch (bullmq bundles its own ioredis copy). The
  // runtime values are exactly what BullMQ expects — this path is opt-in infra.
  const { Queue, Worker } = await import("bullmq");
  const { Redis } = await import("ioredis");
  const connection = new Redis(redisUrl, { maxRetriesPerRequest: null });
  const queue = new Queue(
    BUS_CHANNELS.decision,
    { connection } as unknown as ConstructorParameters<typeof Queue>[1],
  ) as unknown as QueueLike<DecisionEvent>;
  const workerFactory: WorkerFactory<DecisionEvent> = (process) =>
    new Worker(
      BUS_CHANNELS.decision,
      async (job) => {
        await process(job.data as DecisionEvent);
      },
      { connection } as unknown as ConstructorParameters<typeof Worker>[2],
    );
  const distributed = createBullMqDecisionBus(queue, workerFactory);
  distributed.subscribe(persist);
  log("info", "Phase 7 distributed bus enabled", { backend: "bullmq (durable)" });
  return distributed;
}

/**
 * Build the execution stage. Phase 5 default (paper adapter, empty state) when no
 * market broker is opted in. With a broker AND a journal path, Phase 7 RECOVERY
 * runs first: the market + portfolio state is reconstructed from the journal and
 * the adapter is SEEDED with it (restart continuity). FAIL-CLOSED: if recovery
 * cannot prove a consistent state, execution is left UNARMED (returns undefined) —
 * the pipeline keeps observing/deciding but executes no orders.
 */
/**
 * Build the Phase 9.7 control gate (opt-in). Reads the LIVE kill switch + the latest
 * control-plane permission snapshot; fail-closed. Returns undefined when control is off.
 */
function buildControlGate(): RiskGateHook | undefined {
  if (!controlPlane) return undefined;
  const cp = controlPlane;
  return createControlExecutionGate({
    readKillSwitch: () => getKillSwitch(),
    currentPermission: () => cp.currentPermission(),
    // A snapshot older than several ticks means the evaluator has stopped advancing →
    // fail closed rather than trade on a stale ALLOWED. Floor at 60s so a slow tick
    // does not false-trip.
    maxPermissionAgeMs: Math.max(TICK_MS * 4, 60_000),
    log,
  });
}

async function buildExecution(): Promise<ExecutionStageDeps | undefined> {
  if (!marketBroker) {
    // Phase 5 paper default. Even here, when the control plane is on, every execution
    // path must consult the control gate (Section B) — so compose it in.
    const controlGate = buildControlGate();
    return createExecutionStage(controlGate ? { riskGate: controlGate } : {});
  }

  const journalPath = readJournalPath();
  const eventStore: MarketEventStore | undefined = journalPath
    ? new FileMarketEventStore(journalPath)
    : undefined;

  let recovered: RecoveredMarketState | undefined;
  if (eventStore) {
    try {
      recovered = await recoverMarketState(eventStore);
      log("info", "Phase 7 recovery: state reconstructed from journal", {
        journalPath,
        records: recovered.recordsReplayed,
        fills: recovered.fillsReplayed,
      });
    } catch (err) {
      // FAIL-CLOSED: an unreconstructable / divergent history HALTS execution.
      log("error", "Phase 7 recovery FAILED — execution halted (fail-closed)", {
        component: "market.recovery",
        category: "INFRA",
        severity: "CRITICAL",
        journalPath,
        detail: errMsg(err),
      });
      return undefined; // signals still flow; NO orders execute until resolved
    }
  }

  // FAIL-CLOSED (zero-demo): a broker with no explicit market-data source and no
  // DEMO_MODE opt-in has no legitimate price to size/mark against — execution
  // stays UNARMED (signals still flow; NO orders execute).
  const marketData = buildMarketDataProvider();
  if (marketData === undefined) {
    log("error", "MARKET_BROKER is set but no market-data source is configured — execution unarmed (fail-closed)", {
      component: "market.config",
      category: "CONFIG",
      severity: "CRITICAL",
      detail:
        "set MARKET_DATA_SOURCE=realtime (real marks from the ingestion daemon) or opt into DEMO_MODE=true (synthetic demo quotes)",
    });
    return undefined;
  }

  // Broker resolution (real venue prerequisites are fail-closed inside).
  const broker = buildBroker(marketBroker);
  if (broker === undefined) return undefined;

  const adapter = createMarketExecutionAdapter({
    broker,
    marketData,
    ...(eventStore ? { eventStore } : {}),
    ...(recovered
      ? {
          initialMarketState: recovered.marketState,
          initialPortfolioMirror: recovered.portfolioState,
        }
      : {}),
  });
  log("info", "Phase 6 market integration enabled", {
    broker: marketBroker,
    durable: eventStore !== undefined,
    recovered: recovered !== undefined,
  });

  // Persistent portfolio & equity ledger (opt-in via PORTFOLIO_LEDGER=on). If it
  // is REQUESTED but cannot initialize, execution stays UNARMED — a production
  // stack that demands persistence must not trade without it (fail-closed).
  if (readPortfolioLedgerEnabled()) {
    const identity = readPortfolioLedgerIdentity();
    const ledger = new PortfolioLedger({
      prisma,
      log,
      name: identity.name,
      baseCurrency: identity.baseCurrency,
      initialValue: DEFAULT_ACCOUNT_CONFIG.initialCash,
    });
    try {
      await ledger.init();
    } catch (err) {
      log("error", "portfolio ledger init FAILED — execution unarmed (fail-closed)", {
        component: "market.ledger",
        category: "INFRA",
        severity: "CRITICAL",
        detail: errMsg(err),
      });
      return undefined;
    }
    portfolioLedger = ledger;
  }
  marketAdapterRef = adapter;
  // Phase 8 risk engine (opt-in): a default-off pre-trade gate in front of the stage.
  const riskGate = await buildRiskGate(adapter);
  // Phase 9.7 control gate (opt-in) is composed AHEAD of the risk gate (fail-closed,
  // both must pass). Absent => byte-for-byte Phase 8.
  const controlGate = buildControlGate();
  const gate = composeGates(controlGate, riskGate);
  return createExecutionStage({
    adapter,
    ...(recovered ? { portfolioState: recovered.portfolioState } : {}),
    ...(gate ? { riskGate: gate } : {}),
  });
}

async function tick(): Promise<void> {
  if (running) {
    log("warn", "pipeline tick skipped: previous tick still running");
    return;
  }
  running = true;
  const n = (tickCount += 1);
  const tickId = `${BOOT_ID}-${n}`;
  const t0 = Date.now();
  log("info", "pipeline tick start", { tickId, tick: n });
  try {
    // Phase 9.7: refresh control state + permission BEFORE execution so the control gate
    // (inside the stage) reads this tick's snapshot. Never throws into the tick.
    if (controlPlane && controlPlane.started) {
      await controlPlane
        .evaluate()
        .catch((err) => log("error", "control plane evaluate failed", { tickId, error: errMsg(err) }));
    }
    const result = await runSignalPipelineTick({
      prisma,
      log,
      tickId,
      bus,
      demoBootstrap: demoMode,
      ...(execution ? { execution } : {}),
    });
    if (controlPlane && (result.execution?.filled ?? 0) > 0) controlPlane.noteExecution();
    // Persistent equity ledger: snapshot the live account AFTER the tick's
    // executions committed. A write failure never aborts the pipeline (the
    // in-memory + journal state stays authoritative); it is logged CRITICAL and
    // the series resumes on the next successful write.
    if (portfolioLedger && marketAdapterRef) {
      try {
        await portfolioLedger.record(
          marketAdapterRef.accountValuation(),
          marketAdapterRef.getMarketState().positions,
          new Date(),
        );
      } catch (err) {
        log("error", "portfolio ledger write FAILED (series gap; will retry next tick)", {
          component: "market.ledger",
          category: "INFRA",
          severity: "CRITICAL",
          tickId,
          detail: errMsg(err),
        });
      }
    }
    log("info", "pipeline tick complete", { tickId, tick: n, ms: Date.now() - t0, ...result });
  } catch (err) {
    log("error", "pipeline tick failed", {
      tickId,
      tick: n,
      ms: Date.now() - t0,
      error: errMsg(err),
    });
  } finally {
    running = false;
  }
}

async function main(): Promise<void> {
  log("info", "workers service starting (signal pipeline runtime)", {
    tickMs: TICK_MS,
    controlPlane: controlPlaneEnabled,
    demoBootstrap: demoMode,
  });

  // Build the long-lived seams before the first tick (recovery is async + fail-closed).
  bus = await buildDecisionBus();

  if (controlPlaneEnabled) {
    // Phase 9.7: BOOTING → STARTING → startup validation. On failure execution is left
    // UNARMED (fail-closed); signals still flow. On success arm execution (which makes
    // the risk engine live) THEN run the first control evaluation.
    controlPlane = new ControlPlane({
      log,
      getRiskActive: isRiskActive,
      redisUrl: process.env["REDIS_URL"],
      quantUrl: process.env["QUANT_SERVICE_URL"],
    });
    const boot = await controlPlane.boot();
    if (boot.started) {
      execution = await buildExecution();
      await controlPlane.evaluate();
    } else {
      log("error", "control plane startup FAILED — execution unarmed (signals only)");
    }
  } else {
    execution = await buildExecution();
  }

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    log("info", `received ${signal}, shutting down`);
    if (timer) clearInterval(timer);
    await prisma.$disconnect().catch(() => undefined);
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  await tick(); // run once immediately so data exists without waiting a full interval
  timer = setInterval(() => void tick(), TICK_MS);
}

main().catch((err) => {
  log("error", "fatal", { error: errMsg(err) });
  process.exit(1);
});
