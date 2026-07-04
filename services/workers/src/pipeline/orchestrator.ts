/**
 * Signal pipeline tick (M1 runtime, Phase 4 layering).
 *
 * One deterministic pass over the latest FeatureSnapshot per symbol, now routed
 * through the three separated layers and the logical event bus:
 *
 *   ensure upstream chain
 *     -> generateSignal           (OBSERVATION — pure signal-generation core)
 *     -> verifySignalLineage      (fail-closed, BEFORE anything downstream)
 *     -> deriveDecisionEvent      (DECISION — pure, versioned strategy)
 *     -> bus.publish(DecisionEvent)  (logical seam; persistence subscriber writes
 *                                     the EngineSignal idempotently)
 *
 * The tick loop no longer calls persistence directly — it publishes to the bus,
 * decoupling production from consumption. Because the in-process bus fans out
 * synchronously, persistence still completes (and any failure still surfaces,
 * fail-closed) before the tick returns: idempotency and the row-count invariant
 * are unchanged. The pure engine primitives are untouched, so replay determinism
 * is preserved. Every observation, decision, refusal, and lineage rejection is
 * logged — no silent execution paths.
 */

import { ensureSignalDemoChain, type PrismaClient } from "@nexus/db";
import { generateSignal } from "../signal/engine.js";
import { verifySignalLineage } from "../signal/lineage.js";
import type {
  PersistedSignal,
  SignalDataQualityReport,
  SignalFeatureSnapshot,
  SignalStrategyVersion,
} from "../signal/types.js";
import {
  createDecisionBus,
  deriveDecisionEvent,
  defaultStrategyRegistry,
  runExecutionStage,
  summarize,
  type DecisionEvent,
  type EventBus,
  type ExecutionStageDeps,
  type ExecutionStageSummary,
  type StrategyRegistry,
} from "../execution/index.js";
import { errMsg } from "../lib/log.js";

export type LogFn = (
  level: "info" | "warn" | "error",
  msg: string,
  extra?: object,
) => void;

export interface PipelineDeps {
  prisma: PrismaClient;
  log: LogFn;
  /** Correlation id for this tick; stamped on every log line below. */
  tickId?: string;
  /**
   * Logical event bus DecisionEvents are published to. Omit for the default
   * wiring (an in-process bus with the persistence subscriber attached) — which
   * reproduces the prior behavior exactly. The worker passes a long-lived bus to
   * keep the seam decoupled from the tick loop.
   */
  bus?: EventBus;
  /** Strategy resolver for the decision layer; defaults to the global registry. */
  strategyRegistry?: StrategyRegistry;
  /**
   * Phase 5 execution layer. OPT-IN: when omitted, the tick behaves EXACTLY as in
   * Phase 4 (observe -> verify -> decide -> persist) — the CI harness and unit
   * tests omit it, so every sealed guarantee is byte-for-byte preserved. The live
   * worker passes a long-lived stage (paper adapter) to become execution-capable.
   * The stage runs strictly downstream of persistence and writes nothing to the
   * DB, so it cannot regress replay determinism, idempotency, or the row invariant.
   */
  execution?: ExecutionStageDeps;
  /**
   * Demo-chain bootstrap (runtime continuity fixtures). OPT-IN and DEFAULT-OFF:
   * only when true does the tick upsert the deterministic demo lineage
   * (Strategy / FeatureSnapshot / DQ fixtures) before generating — a bare
   * production worker must never fabricate upstream data. When off, the tick
   * RESOLVES the persisted lineage instead and skips (fail-closed) if none
   * exists. Unset -> read from the DEMO_MODE env (the platform-wide demo flag).
   */
  demoBootstrap?: boolean;
}

export interface PipelineTickResult {
  snapshotsConsidered: number;
  generated: number;
  refused: number;
  lineageRejected: number;
  /** Execution-stage summary; present only when execution deps are wired in. */
  execution?: ExecutionStageSummary;
}

/** How many recent snapshots to scan when picking the latest per symbol. */
const SNAPSHOT_SCAN_LIMIT = 200;

/** Tolerant boolean env parse (matches the ingestion service's convention). */
const envFlag = (raw: string | undefined): boolean =>
  raw !== undefined && ["true", "1", "yes"].includes(raw.trim().toLowerCase());

/**
 * Resolve the persisted signal lineage WITHOUT creating anything: the
 * core-technical v1 feature set + the newest ACTIVE StrategyVersion (stable
 * (createdAt, id) order). Returns null when either is missing — the tick then
 * skips fail-closed instead of fabricating fixtures.
 */
async function resolvePersistedLineage(prisma: PrismaClient): Promise<{
  featureSetId: string;
  strategyVersion: SignalStrategyVersion;
} | null> {
  const [def, version] = await Promise.all([
    prisma.featureSetDefinition.findUnique({
      where: { name_version: { name: "core-technical", version: 1 } },
      select: { id: true },
    }),
    prisma.strategyVersion.findFirst({
      where: { status: "ACTIVE" },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: { id: true, parameters: true },
    }),
  ]);
  if (def === null || version === null) return null;
  return {
    featureSetId: def.id,
    strategyVersion: {
      id: version.id,
      parameters: version.parameters as Record<string, unknown>,
    },
  };
}

export async function runSignalPipelineTick(
  deps: PipelineDeps,
): Promise<PipelineTickResult> {
  const { prisma, log, tickId } = deps;
  // Default wiring preserves prior behavior with zero configuration: an
  // in-process bus whose persistence subscriber writes the EngineSignal.
  const bus = deps.bus ?? createDecisionBus({ prisma, log });
  const registry = deps.strategyRegistry ?? defaultStrategyRegistry;
  const demoBootstrap = deps.demoBootstrap ?? envFlag(process.env["DEMO_MODE"]);

  // 1) Resolve the upstream lineage. DEMO_MODE (opt-in) upserts the idempotent
  //    demo chain exactly as before; production resolves persisted rows only and
  //    SKIPS the tick (fail-closed) when no lineage exists — the worker never
  //    invents upstream data by default.
  let featureSetId: string;
  let sv: SignalStrategyVersion;
  if (demoBootstrap) {
    const chain = await ensureSignalDemoChain(prisma, log);
    featureSetId = chain.featureSetId;
    sv = { id: chain.strategyVersion.id, parameters: chain.strategyVersion.parameters };
  } else {
    const resolved = await resolvePersistedLineage(prisma);
    if (resolved === null) {
      log("warn", "no persisted signal lineage (core-technical feature set + ACTIVE strategy version) — tick skipped (fail-closed). Register a strategy, or opt into the demo chain with DEMO_MODE=true.", { tickId });
      return { snapshotsConsidered: 0, generated: 0, refused: 0, lineageRejected: 0 };
    }
    featureSetId = resolved.featureSetId;
    sv = resolved.strategyVersion;
  }

  // 2) Latest FeatureSnapshot per symbol. Zero-demo discipline: synthetic
  //    DEMO-venue snapshots are admitted ONLY under the demo opt-in — a
  //    production tick must never generate signals from synthetic features
  //    (with no fresh real snapshot it generates nothing, fail-closed).
  const rows = await prisma.featureSnapshot.findMany({
    where: {
      featureSetId,
      ...(demoBootstrap ? {} : { exchange: { not: "DEMO" } }),
    },
    orderBy: { ts: "desc" },
    take: SNAPSHOT_SCAN_LIMIT,
    include: { dqReport: true },
  });
  const latest = new Map<string, (typeof rows)[number]>();
  for (const r of rows) {
    if (!latest.has(r.symbol)) latest.set(r.symbol, r);
  }

  let generated = 0;
  let refused = 0;
  let lineageRejected = 0;
  // DecisionEvents produced this tick, collected for the downstream (opt-in)
  // execution stage. Collected regardless so the decision path is unchanged.
  const decisions: DecisionEvent[] = [];

  for (const snap of latest.values()) {
    const featureSnapshot: SignalFeatureSnapshot = {
      id: snap.id,
      symbol: snap.symbol,
      featureHash: snap.featureHash,
      features: snap.features as unknown as Record<string, number>,
    };
    const dqReport: SignalDataQualityReport = {
      id: snap.dqReport.id,
      score: snap.dqReport.score,
      status: snap.dqReport.status,
      datasetHash: snap.dqReport.datasetHash,
    };

    // generate (pure, deterministic) — the market OBSERVATION.
    const gen = generateSignal({ featureSnapshot, dqReport, strategyVersion: sv });
    if (gen.status === "REFUSED") {
      refused += 1;
      log("warn", "signal refused", {
        tickId,
        symbol: snap.symbol,
        strategyVersionId: sv.id,
        featureSnapshotId: snap.id,
        reason: gen.reason,
      });
      continue;
    }

    log("info", "signal generated", {
      tickId,
      symbol: snap.symbol,
      strategyVersionId: sv.id,
      featureSnapshotId: snap.id,
      side: gen.signal.side,
      decision: gen.signal.decision,
      confidence: gen.signal.confidence,
    });

    // verify lineage BEFORE anything downstream (fail-closed). The candidate
    // carries the same lineage the engine just stamped; a projection bug fails
    // closed here, before a decision is derived or anything is published.
    const candidate: PersistedSignal = { id: "pre-persist", ...gen.signal };
    const lineage = verifySignalLineage({
      signal: candidate,
      featureSnapshot,
      dqReport,
      strategyVersion: sv,
    });
    if (!lineage.lineageValid) {
      lineageRejected += 1;
      log("error", "lineage invalid — refusing to persist", {
        tickId,
        symbol: snap.symbol,
        strategyVersionId: sv.id,
        featureSnapshotId: snap.id,
        detail: lineage.detail,
      });
      continue;
    }

    // DECISION layer (pure): a versioned strategy maps the observation to an
    // action intent, assembled into a fully-lineaged DecisionEvent.
    const strategy = registry.resolve(gen.signal.strategyVersionId);
    const event = deriveDecisionEvent(
      gen.signal,
      strategy,
      tickId !== undefined ? { tickId } : {},
    );
    log("info", "decision derived", {
      tickId,
      symbol: snap.symbol,
      featureSnapshotId: snap.id,
      executionStrategy: `${strategy.id}@v${strategy.version}`,
      action: event.decision.action,
      side: event.decision.side,
      confidence: event.decision.confidence,
    });

    // Publish to the logical bus. The synchronous in-process fan-out means the
    // persistence subscriber writes (idempotently) before publish resolves, and
    // a persistence failure rejects here (fail-closed), exactly as before.
    await bus.publish(event);
    decisions.push(event);
    generated += 1;
  }

  // EXECUTION layer (Phase 5, opt-in): downstream of persistence and decoupled
  // from it. Wrapped so any execution failure is logged WITHOUT masking the
  // decision-layer result — Phase 4 behavior is reported truthfully regardless.
  let execution: ExecutionStageSummary | undefined;
  if (deps.execution) {
    try {
      const stage = await runExecutionStage(decisions, deps.execution, {
        log,
        ...(tickId !== undefined ? { tickId } : {}),
      });
      // Carry the event-sourced portfolio state forward to the next tick.
      deps.execution.portfolioState = stage.portfolioState;
      execution = summarize(stage);
    } catch (err) {
      log("error", "execution stage failed — decision layer unaffected", {
        tickId,
        error: errMsg(err),
      });
    }
  }

  return {
    snapshotsConsidered: latest.size,
    generated,
    refused,
    lineageRejected,
    ...(execution !== undefined ? { execution } : {}),
  };
}
