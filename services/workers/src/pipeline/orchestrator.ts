/**
 * Signal pipeline tick (M1 runtime, Phase 4 layering, Phase 11B determinism lock).
 *
 * One deterministic pass over the latest FeatureSnapshot per symbol, routed
 * through the three separated layers and the logical event bus:
 *
 *   resolve persisted lineage (fail-fast: missing -> THROW, never fabricated)
 *     -> generateSignal           (OBSERVATION — pure signal-generation core)
 *     -> verifySignalLineage      (fail-closed, BEFORE anything downstream)
 *     -> deriveDecisionEvent      (DECISION — pure, versioned strategy)
 *     -> bus.publish(DecisionEvent)  (logical seam; persistence subscriber writes
 *                                     the EngineSignal idempotently)
 *
 * Determinism contract (Phase 11B):
 *   - identical persisted input -> identical output, byte for byte;
 *   - NO randomness, NO env-dependent branching, NO clock reads on the decision
 *     path (the only Date used anywhere is row data persisted upstream);
 *   - dataset iteration is totally ordered: snapshots are fetched with a stable
 *     (ts desc, id desc) order and symbols are processed in ascending symbol
 *     order — async completion order can never reorder work;
 *   - the exact input set is fingerprinted: `inputHash` is a sha256 over the
 *     canonical JSON of the resolved lineage + the per-symbol snapshot set, so
 *     two runs that report the same inputHash consumed identical inputs.
 *
 * FAIL FAST: a missing upstream (no core-technical feature set, no ACTIVE
 * strategy version, or zero admissible feature snapshots) THROWS
 * PipelineDataError. There is no bootstrap, no fixture fallback, and no silent
 * empty tick — the caller decides how to surface the failure.
 */

import { createHash } from "node:crypto";
import type { PrismaClient } from "@nexus/db";
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

/** Missing upstream data — the tick refuses to run rather than fabricate input. */
export class PipelineDataError extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = "PipelineDataError";
    this.code = code;
  }
}

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
   * Phase 4 (observe -> verify -> decide -> persist). The live worker passes a
   * long-lived stage to become execution-capable. The stage runs strictly
   * downstream of persistence and writes nothing to the DB, so it cannot regress
   * replay determinism, idempotency, or the row invariant.
   */
  execution?: ExecutionStageDeps;
}

export interface PipelineTickResult {
  snapshotsConsidered: number;
  generated: number;
  refused: number;
  lineageRejected: number;
  /**
   * sha256 fingerprint of the exact resolved input (lineage + snapshot set).
   * Identical inputHash across runs proves the ticks consumed identical inputs;
   * determinism then requires their outputs to be identical too.
   */
  inputHash: string;
  /** Execution-stage summary; present only when execution deps are wired in. */
  execution?: ExecutionStageSummary;
}

/** How many recent snapshots to scan when picking the latest per symbol. */
const SNAPSHOT_SCAN_LIMIT = 200;

/**
 * Resolve the persisted signal lineage WITHOUT creating anything: the
 * core-technical v1 feature set + the newest ACTIVE StrategyVersion (stable
 * (createdAt, id) order). THROWS when either is missing — the pipeline never
 * fabricates upstream data.
 */
async function resolvePersistedLineage(prisma: PrismaClient): Promise<{
  featureSetId: string;
  strategyVersion: SignalStrategyVersion;
}> {
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
  if (def === null) {
    throw new PipelineDataError(
      "no FeatureSetDefinition core-technical v1 — the feature catalog has not been seeded (fail-fast, nothing fabricated)",
      "MISSING_FEATURE_SET",
    );
  }
  if (version === null) {
    throw new PipelineDataError(
      "no ACTIVE StrategyVersion — register and approve a strategy before running the pipeline (fail-fast, nothing fabricated)",
      "MISSING_ACTIVE_STRATEGY",
    );
  }
  return {
    featureSetId: def.id,
    strategyVersion: {
      id: version.id,
      parameters: version.parameters as Record<string, unknown>,
    },
  };
}

/**
 * Canonical sha256 over the resolved tick input. Snapshot entries are ordered
 * by symbol (the iteration order below), every field is a persisted value, and
 * serialization is plain JSON.stringify over an explicitly-ordered structure —
 * no clock, no env, no float re-derivation.
 */
function computeInputHash(input: {
  featureSetId: string;
  strategyVersionId: string;
  snapshots: Array<{
    id: string;
    symbol: string;
    ts: string;
    featureHash: string;
    dqReportId: string;
    datasetHash: string;
  }>;
}): string {
  return createHash("sha256").update(JSON.stringify(input), "utf8").digest("hex");
}

export async function runSignalPipelineTick(
  deps: PipelineDeps,
): Promise<PipelineTickResult> {
  const { prisma, log, tickId } = deps;
  // Default wiring preserves prior behavior with zero configuration: an
  // in-process bus whose persistence subscriber writes the EngineSignal.
  const bus = deps.bus ?? createDecisionBus({ prisma, log });
  const registry = deps.strategyRegistry ?? defaultStrategyRegistry;

  // 1) Resolve the persisted upstream lineage. FAIL-FAST: missing lineage
  //    throws — the production pipeline never invents upstream data.
  const { featureSetId, strategyVersion: sv } = await resolvePersistedLineage(prisma);

  // 2) Latest FeatureSnapshot per symbol, in a TOTAL order: (ts desc, id desc)
  //    makes same-millisecond rows deterministic. Legacy synthetic DEMO-venue
  //    rows are excluded unconditionally (defense-in-depth: nothing writes them
  //    anymore, but a pre-existing database must never feed them to the engine).
  const rows = await prisma.featureSnapshot.findMany({
    where: {
      featureSetId,
      exchange: { not: "DEMO" },
    },
    orderBy: [{ ts: "desc" }, { id: "desc" }],
    take: SNAPSHOT_SCAN_LIMIT,
    include: { dqReport: true },
  });
  const latest = new Map<string, (typeof rows)[number]>();
  for (const r of rows) {
    if (!latest.has(r.symbol)) latest.set(r.symbol, r);
  }
  if (latest.size === 0) {
    throw new PipelineDataError(
      "no admissible FeatureSnapshot exists for the core-technical v1 feature set — run ingestion before the pipeline (fail-fast, nothing fabricated)",
      "MISSING_FEATURE_SNAPSHOTS",
    );
  }

  // Deterministic iteration order: ascending symbol, independent of row
  // arrival order, Map insertion order, or async scheduling.
  const ordered = [...latest.values()].sort((a, b) =>
    a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0,
  );

  // Explicit input fingerprint (Phase 11B): the exact dataset this tick runs on.
  const inputHash = computeInputHash({
    featureSetId,
    strategyVersionId: sv.id,
    snapshots: ordered.map((s) => ({
      id: s.id,
      symbol: s.symbol,
      ts: s.ts.toISOString(),
      featureHash: s.featureHash,
      dqReportId: s.dqReport.id,
      datasetHash: s.dqReport.datasetHash,
    })),
  });
  log("info", "pipeline input resolved", {
    tickId,
    inputHash,
    strategyVersionId: sv.id,
    symbols: ordered.map((s) => s.symbol),
  });

  let generated = 0;
  let refused = 0;
  let lineageRejected = 0;
  // DecisionEvents produced this tick, collected for the downstream (opt-in)
  // execution stage. Collected regardless so the decision path is unchanged.
  const decisions: DecisionEvent[] = [];

  for (const snap of ordered) {
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
    inputHash,
    ...(execution !== undefined ? { execution } : {}),
  };
}
