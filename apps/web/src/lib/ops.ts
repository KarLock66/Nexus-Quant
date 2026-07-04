import { prisma } from "@nexus/db";
import {
  STREAM_THRESHOLDS,
  deriveStageState,
  freshnessFromLag,
  worstFreshness,
  worstStageState,
} from "./ops-freshness";
import { getSystemHealth } from "./system-health";
import type {
  ActionsCatalog,
  DataFlowMonitor,
  DataFlowStream,
  OperatorAction,
  OperatorActionId,
  OperatorActionResult,
  PipelineStage,
  PipelineStatus,
  RuntimeMetrics,
  StreamCount,
  StreamKey,
} from "./ops-types";

/**
 * Phase 9.6 — Operations data layer (Sections B, C, D, F).
 *
 * Every value here is READ from real persisted state (Prisma) or process
 * runtime. Nothing is mocked. Where a signal is not observable in this
 * deployment (execution is event-sourced, not DB-persisted), the absence is
 * reported honestly with a `note` — never fabricated.
 *
 * This module never imports ops-alerts.ts (the alert engine imports FROM here),
 * keeping the dependency graph acyclic.
 */

const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** JobRun job-name patterns that indicate execution / order activity. */
const EXECUTION_JOB_RE = /execut|order|fill|broker|intent/i;

function lagSecondsFrom(ts: Date | null, now: number): number | null {
  return ts === null ? null : Math.max(0, Math.round((now - ts.getTime()) / 1000));
}

// ─────────────────── B. Live Data Flow Monitor ───────────────────

interface StreamObservation {
  lastUpdateAt: Date | null;
  rowsLastHour: number;
  note: string | null;
}

/** Most-recent execution evidence from JobRun (execution is not a DB table). */
async function observeExecution(hourAgo: Date): Promise<StreamObservation> {
  try {
    const [latest, recent] = await Promise.all([
      prisma.jobRun.findFirst({
        where: { job: { contains: "exec" } },
        orderBy: { startedAt: "desc" },
        select: { startedAt: true, job: true },
      }),
      prisma.jobRun.findMany({
        where: { startedAt: { gte: hourAgo } },
        select: { job: true, startedAt: true },
      }),
    ]);
    const execJobs = recent.filter((j) => EXECUTION_JOB_RE.test(j.job));
    const latestExec =
      latest && EXECUTION_JOB_RE.test(latest.job) ? latest.startedAt : null;
    return {
      lastUpdateAt: latestExec,
      rowsLastHour: execJobs.length,
      note:
        latestExec === null
          ? "execution is event-sourced (in-process bus / file journal) and not persisted to the database in this deployment — opt-in via MARKET_BROKER"
          : null,
    };
  } catch {
    return {
      lastUpdateAt: null,
      rowsLastHour: 0,
      note: "execution activity not observable from the database",
    };
  }
}

async function observeStream(key: StreamKey, hourAgo: Date): Promise<StreamObservation> {
  switch (key) {
    case "marketTick": {
      const [latest, count] = await Promise.all([
        prisma.marketTick.findFirst({ orderBy: { ts: "desc" }, select: { ts: true } }),
        prisma.marketTick.count({ where: { ts: { gte: hourAgo } } }),
      ]);
      return { lastUpdateAt: latest?.ts ?? null, rowsLastHour: count, note: null };
    }
    case "orderbookSnapshot": {
      const [latest, count] = await Promise.all([
        prisma.orderbookSnapshot.findFirst({ orderBy: { ts: "desc" }, select: { ts: true } }),
        prisma.orderbookSnapshot.count({ where: { ts: { gte: hourAgo } } }),
      ]);
      return { lastUpdateAt: latest?.ts ?? null, rowsLastHour: count, note: null };
    }
    case "marketCandle": {
      const [latest, count] = await Promise.all([
        prisma.marketCandle.findFirst({ orderBy: { ts: "desc" }, select: { ts: true } }),
        prisma.marketCandle.count({ where: { ts: { gte: hourAgo } } }),
      ]);
      return { lastUpdateAt: latest?.ts ?? null, rowsLastHour: count, note: null };
    }
    case "featureSnapshot": {
      const [latest, count] = await Promise.all([
        prisma.featureSnapshot.findFirst({ orderBy: { createdAt: "desc" }, select: { createdAt: true } }),
        prisma.featureSnapshot.count({ where: { createdAt: { gte: hourAgo } } }),
      ]);
      return { lastUpdateAt: latest?.createdAt ?? null, rowsLastHour: count, note: null };
    }
    case "engineSignal": {
      const [latest, count] = await Promise.all([
        prisma.engineSignal.findFirst({ orderBy: { createdAt: "desc" }, select: { createdAt: true } }),
        prisma.engineSignal.count({ where: { createdAt: { gte: hourAgo } } }),
      ]);
      return { lastUpdateAt: latest?.createdAt ?? null, rowsLastHour: count, note: null };
    }
    case "execution":
      return observeExecution(hourAgo);
  }
}

export async function getDataFlowMonitor(): Promise<DataFlowMonitor> {
  const now = Date.now();
  const hourAgo = new Date(now - HOUR);

  const streams: DataFlowStream[] = await Promise.all(
    STREAM_THRESHOLDS.map(async (def) => {
      const obs = await observeStream(def.key, hourAgo);
      const lagSeconds = lagSecondsFrom(obs.lastUpdateAt, now);
      // An unobservable stream (execution opt-in) reads as `unknown`, never stale.
      const freshness =
        obs.lastUpdateAt === null && obs.note !== null && def.key === "execution"
          ? "unknown"
          : freshnessFromLag(lagSeconds, def.warningSec, def.staleSec);
      return {
        key: def.key,
        label: def.label,
        lastUpdateAt: obs.lastUpdateAt ? obs.lastUpdateAt.toISOString() : null,
        lagSeconds,
        rowsPerMinute:
          obs.rowsLastHour > 0 ? Number((obs.rowsLastHour / 60).toFixed(2)) : 0,
        rowsLastHour: obs.rowsLastHour,
        freshness,
        thresholdsSeconds: { warning: def.warningSec, stale: def.staleSec },
        note: obs.note,
      } satisfies DataFlowStream;
    }),
  );

  return {
    overall: worstFreshness(streams.map((s) => s.freshness)),
    streams,
  };
}

// ─────────────────── C. Pipeline Visualization (8 stages) ───────────────────

interface JobRow {
  job: string;
  status: string;
  startedAt: Date;
  endedAt: Date | null;
}

function maxDate(...ds: (Date | null | undefined)[]): Date | null {
  let m: Date | null = null;
  for (const d of ds) if (d && (m === null || d > m)) m = d;
  return m;
}

function perMin(count: number): number | null {
  return count > 0 ? Number((count / (24 * 60)).toFixed(3)) : 0;
}

export async function getOpsPipeline(): Promise<PipelineStatus> {
  const now = Date.now();
  const dayAgo = new Date(now - DAY);

  const [
    candleLast,
    candle24h,
    tickLast,
    tick24h,
    bookLast,
    dqLast,
    dq24h,
    dqFailed24h,
    featLast,
    feat24h,
    sigLast,
    sig24h,
    jobs,
    riskEventLast,
    riskOpen,
    riskState,
    dbHealthy,
  ] = await Promise.all([
    prisma.marketCandle.findFirst({ orderBy: { ts: "desc" }, select: { ts: true } }),
    prisma.marketCandle.count({ where: { ts: { gte: dayAgo } } }),
    prisma.marketTick.findFirst({ orderBy: { ts: "desc" }, select: { ts: true } }),
    prisma.marketTick.count({ where: { ts: { gte: dayAgo } } }),
    prisma.orderbookSnapshot.findFirst({ orderBy: { ts: "desc" }, select: { ts: true } }),
    prisma.dataQualityReport.findFirst({ orderBy: { createdAt: "desc" }, select: { createdAt: true } }),
    prisma.dataQualityReport.count({ where: { createdAt: { gte: dayAgo } } }),
    prisma.dataQualityReport.count({ where: { createdAt: { gte: dayAgo }, status: "FAILED" } }),
    prisma.featureSnapshot.findFirst({ orderBy: { createdAt: "desc" }, select: { createdAt: true } }),
    prisma.featureSnapshot.count({ where: { createdAt: { gte: dayAgo } } }),
    prisma.engineSignal.findFirst({ orderBy: { createdAt: "desc" }, select: { createdAt: true } }),
    prisma.engineSignal.count({ where: { createdAt: { gte: dayAgo } } }),
    prisma.jobRun.findMany({
      where: { startedAt: { gte: dayAgo } },
      orderBy: { startedAt: "desc" },
      take: 500,
      select: { job: true, status: true, startedAt: true, endedAt: true },
    }),
    prisma.riskEvent.findFirst({ orderBy: { createdAt: "desc" }, select: { createdAt: true } }),
    prisma.riskEvent.count({ where: { resolvedAt: null } }),
    prisma.systemRiskState.findFirst({ orderBy: { ts: "desc" }, select: { mode: true, ts: true } }),
    // Persistence-stage liveness reuses the canonical DB probe.
    prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false),
  ]);

  const failedJobs = (jobs as JobRow[]).filter((j) => j.status === "FAILED");
  const countFailed = (re: RegExp) => failedJobs.filter((j) => re.test(j.job)).length;
  const execJobs = (jobs as JobRow[]).filter((j) => EXECUTION_JOB_RE.test(j.job));
  const marketDataLast = maxDate(candleLast?.ts, tickLast?.ts, bookLast?.ts);
  const anyWriteLast = maxDate(
    marketDataLast,
    featLast?.createdAt,
    sigLast?.createdAt,
    dqLast?.createdAt,
    jobs[0]?.startedAt,
  );

  const stages: PipelineStage[] = [];

  // 1. Exchange (upstream venue) — observed via the freshness of the live feed.
  stages.push({
    key: "exchange",
    label: "Exchange Feed",
    state: deriveStageState({
      lastEventAt: marketDataLast,
      count24h: tick24h + candle24h,
      errorCount: countFailed(/connector|ws|stream/i),
      freshSec: 60,
      staleSec: 600,
      now,
    }),
    lastEventAt: marketDataLast ? marketDataLast.toISOString() : null,
    throughputPerMin: perMin(tick24h + candle24h),
    latencyMs: null,
    errorCount: countFailed(/connector|ws|stream/i),
    detail: marketDataLast
      ? `${(tick24h + candle24h).toLocaleString()} rows/24h · last ${lagSecondsFrom(marketDataLast, now)}s ago`
      : "no market data received",
  });

  // 2. Ingestion service — JobRun heartbeats + market-data writes.
  stages.push({
    key: "ingestion",
    label: "Ingestion",
    state: deriveStageState({
      lastEventAt: marketDataLast,
      count24h: tick24h + candle24h,
      errorCount: countFailed(/connector|backfill|ingest|tick|candle/i),
      freshSec: 60,
      staleSec: 600,
      now,
    }),
    lastEventAt: marketDataLast ? marketDataLast.toISOString() : null,
    throughputPerMin: perMin(tick24h + candle24h),
    latencyMs: null,
    errorCount: countFailed(/connector|backfill|ingest|tick|candle/i),
    detail: marketDataLast
      ? `ticks+candles ${(tick24h + candle24h).toLocaleString()}/24h`
      : "no ingestion writes",
  });

  // 3. Data Quality gateway.
  stages.push({
    key: "dataQuality",
    label: "Data Quality",
    state: deriveStageState({
      lastEventAt: dqLast?.createdAt ?? null,
      count24h: dq24h,
      errorCount: dqFailed24h,
      freshSec: 300,
      staleSec: 3600,
      now,
    }),
    lastEventAt: dqLast?.createdAt.toISOString() ?? null,
    throughputPerMin: perMin(dq24h),
    latencyMs: null,
    errorCount: dqFailed24h,
    detail: dqLast
      ? `${dq24h} reports/24h · ${dqFailed24h} failed`
      : "no DQ reports",
  });

  // 4. Feature generation.
  stages.push({
    key: "featureGeneration",
    label: "Feature Generation",
    state: deriveStageState({
      lastEventAt: featLast?.createdAt ?? null,
      count24h: feat24h,
      errorCount: countFailed(/feature|snapshot/i),
      freshSec: 120,
      staleSec: 1800,
      now,
    }),
    lastEventAt: featLast?.createdAt.toISOString() ?? null,
    throughputPerMin: perMin(feat24h),
    latencyMs: null,
    errorCount: countFailed(/feature|snapshot/i),
    detail: featLast ? `${feat24h} snapshots/24h` : "no feature snapshots",
  });

  // 5. Signal engine.
  stages.push({
    key: "signalEngine",
    label: "Signal Engine",
    state: deriveStageState({
      lastEventAt: sigLast?.createdAt ?? null,
      count24h: sig24h,
      errorCount: countFailed(/signal|engine|pipeline|decision/i),
      freshSec: 60,
      staleSec: 600,
      now,
    }),
    lastEventAt: sigLast?.createdAt.toISOString() ?? null,
    throughputPerMin: perMin(sig24h),
    latencyMs: null,
    errorCount: countFailed(/signal|engine|pipeline|decision/i),
    detail: sigLast ? `${sig24h} signals/24h` : "no engine signals",
  });

  // 6. Risk engine — bespoke: NORMAL & quiet is healthy ("idle"), open
  // CRITICAL/EMERGENCY events make it "failing".
  const riskLastAt = maxDate(riskEventLast?.createdAt, riskState?.ts);
  const riskMode = riskState?.mode ?? null;
  const riskState4: PipelineStage["state"] =
    riskOpen > 0
      ? "failing"
      : riskMode && riskMode !== "NORMAL"
        ? "degraded"
        : riskLastAt
          ? "active"
          : "idle";
  stages.push({
    key: "riskEngine",
    label: "Risk Engine",
    state: riskState4,
    lastEventAt: riskLastAt ? riskLastAt.toISOString() : null,
    throughputPerMin: null,
    latencyMs: null,
    errorCount: riskOpen,
    detail:
      `mode ${riskMode ?? "NORMAL"}` +
      (riskOpen > 0 ? ` · ${riskOpen} open risk event(s)` : " · no open risk events"),
  });

  // 7. Execution — event-sourced; observed only via JobRun (best-effort).
  const execLast = execJobs[0]?.startedAt ?? null;
  stages.push({
    key: "execution",
    label: "Execution",
    state:
      execLast === null
        ? "unknown"
        : deriveStageState({
            lastEventAt: execLast,
            count24h: execJobs.length,
            errorCount: execJobs.filter((j) => j.status === "FAILED").length,
            freshSec: 120,
            staleSec: 600,
            now,
          }),
    lastEventAt: execLast ? execLast.toISOString() : null,
    throughputPerMin: perMin(execJobs.length),
    latencyMs: null,
    errorCount: execJobs.filter((j) => j.status === "FAILED").length,
    detail:
      execLast === null
        ? "no DB-observable execution activity (opt-in via MARKET_BROKER)"
        : `${execJobs.length} execution job(s)/24h`,
  });

  // 8. Persistence — DB reachability + recent write activity.
  stages.push({
    key: "persistence",
    label: "Persistence",
    state: !dbHealthy
      ? "failing"
      : anyWriteLast
        ? "active"
        : "empty",
    lastEventAt: anyWriteLast ? anyWriteLast.toISOString() : null,
    throughputPerMin: null,
    latencyMs: null,
    errorCount: dbHealthy ? 0 : 1,
    detail: !dbHealthy
      ? "database unreachable"
      : anyWriteLast
        ? `last write ${lagSecondsFrom(anyWriteLast, now)}s ago`
        : "database reachable — no writes yet",
  });

  return {
    overall: worstStageState(stages.map((s) => s.state)),
    stages,
  };
}

// ─────────────────── F. Runtime Metrics ───────────────────

export async function getRuntimeMetrics(): Promise<RuntimeMetrics> {
  const now = Date.now();
  const hourAgo = new Date(now - HOUR);
  const dayAgo = new Date(now - DAY);

  const [
    tick1h, tick24h,
    book1h, book24h,
    candle1h, candle24h,
    feat1h, feat24h,
    sig1h, sig24h,
    jobs,
    riskState,
    openRisk,
    lastRisk,
  ] = await Promise.all([
    prisma.marketTick.count({ where: { ts: { gte: hourAgo } } }),
    prisma.marketTick.count({ where: { ts: { gte: dayAgo } } }),
    prisma.orderbookSnapshot.count({ where: { ts: { gte: hourAgo } } }),
    prisma.orderbookSnapshot.count({ where: { ts: { gte: dayAgo } } }),
    prisma.marketCandle.count({ where: { ts: { gte: hourAgo } } }),
    prisma.marketCandle.count({ where: { ts: { gte: dayAgo } } }),
    prisma.featureSnapshot.count({ where: { createdAt: { gte: hourAgo } } }),
    prisma.featureSnapshot.count({ where: { createdAt: { gte: dayAgo } } }),
    prisma.engineSignal.count({ where: { createdAt: { gte: hourAgo } } }),
    prisma.engineSignal.count({ where: { createdAt: { gte: dayAgo } } }),
    prisma.jobRun.findMany({
      where: { startedAt: { gte: dayAgo } },
      orderBy: { startedAt: "desc" },
      take: 500,
      select: { job: true, status: true, startedAt: true, endedAt: true },
    }),
    prisma.systemRiskState.findFirst({ orderBy: { ts: "desc" }, select: { mode: true } }),
    prisma.riskEvent.count({ where: { resolvedAt: null } }),
    prisma.riskEvent.findFirst({ orderBy: { createdAt: "desc" }, select: { createdAt: true } }),
  ]);

  const j = jobs as JobRow[];
  const running = j.filter((x) => x.status === "RUNNING");
  const ok = j.filter((x) => x.status === "OK");
  const failed = j.filter((x) => x.status === "FAILED");
  const completed = j.filter((x) => x.endedAt !== null);
  const avgLatencyMs =
    completed.length > 0
      ? Math.round(
          completed.reduce((s, x) => s + (x.endedAt!.getTime() - x.startedAt.getTime()), 0) /
            completed.length,
        )
      : null;
  const oldest = j.length > 0 ? j[j.length - 1]!.startedAt.getTime() : now;
  const windowMin = Math.max(1, (now - oldest) / MINUTE);

  const execJobs = j.filter((x) => EXECUTION_JOB_RE.test(x.job));
  const counts: StreamCount[] = [
    { stream: "marketTick", lastHour: tick1h, last24h: tick24h },
    { stream: "orderbookSnapshot", lastHour: book1h, last24h: book24h },
    { stream: "marketCandle", lastHour: candle1h, last24h: candle24h },
    { stream: "featureSnapshot", lastHour: feat1h, last24h: feat24h },
    { stream: "engineSignal", lastHour: sig1h, last24h: sig24h },
    {
      stream: "execution",
      lastHour: execJobs.filter((x) => x.startedAt >= hourAgo).length,
      last24h: execJobs.length,
    },
  ];

  return {
    webUptimeSeconds: Math.round(process.uptime()),
    counts,
    jobs: {
      running: running.length,
      ok24h: ok.length,
      failed24h: failed.length,
      ratePerMin: j.length > 0 ? Number((ok.length / windowMin).toFixed(3)) : null,
      avgLatencyMs,
      activeWorkers: new Set(running.map((x) => x.job)).size,
    },
    risk: {
      mode: riskState?.mode ?? null,
      openRiskEvents: openRisk,
      lastRiskEventAt: lastRisk?.createdAt.toISOString() ?? null,
    },
  };
}

// ─────────────────── D. Operator Actions ───────────────────

/**
 * In-process operator state. Deliberately NOT persisted: operator actions must
 * never mutate the database (Section D). This holds only ephemeral UI markers.
 */
const opsState: { clearedStaleAt: number | null; lastHealthRunAt: number | null } = {
  clearedStaleAt: null,
  lastHealthRunAt: null,
};

/** Restart actions are gated behind an explicit, opt-in control channel. */
function controlChannelConfigured(): boolean {
  return process.env.OPS_CONTROL_ENABLED === "true";
}

export function getActionsCatalog(): ActionsCatalog {
  const controlOn = controlChannelConfigured();
  const restartReason = controlOn
    ? null
    : "no control channel configured — set OPS_CONTROL_ENABLED=true and wire a supervisor";

  const actions: OperatorAction[] = [
    {
      id: "refreshHealth",
      label: "Refresh Health",
      description: "Re-probe every component and refresh the dashboard now.",
      enabled: true,
      destructive: false,
      disabledReason: null,
    },
    {
      id: "rerunHealthChecks",
      label: "Re-run Health Checks",
      description: "Force a fresh aggregation of system health and data-flow.",
      enabled: true,
      destructive: false,
      disabledReason: null,
    },
    {
      id: "clearStaleStatus",
      label: "Clear Stale Status",
      description: "Dismiss stale client banners and reset freshness markers.",
      enabled: true,
      destructive: false,
      disabledReason: null,
    },
    {
      id: "restartIngestion",
      label: "Restart Ingestion",
      description: "Request the ingestion service supervisor to restart the daemon.",
      enabled: controlOn,
      destructive: false,
      disabledReason: restartReason,
    },
    {
      id: "restartWorkers",
      label: "Restart Workers",
      description: "Request the workers service supervisor to restart the pipeline.",
      enabled: controlOn,
      destructive: false,
      disabledReason: restartReason,
    },
  ];
  return { actions, controlChannelConfigured: controlOn };
}

/**
 * Execute a guarded operator action. NON-DESTRUCTIVE and NON-MUTATING by
 * construction: safe actions touch only in-process markers / re-probe; restart
 * actions emit a logged control REQUEST for an external supervisor to honor
 * (this process never kills sibling services), and are refused when the control
 * channel is not configured.
 */
export async function executeAction(id: OperatorActionId): Promise<OperatorActionResult> {
  const performedAt = new Date().toISOString();
  const base = { id, performedAt };

  switch (id) {
    case "refreshHealth": {
      const health = await getSystemHealth();
      opsState.lastHealthRunAt = Date.now();
      return { ...base, ok: true, accepted: true, message: `health re-probed: ${health.overallStatus}` };
    }
    case "rerunHealthChecks": {
      const [health] = await Promise.all([getSystemHealth(), getDataFlowMonitor()]);
      opsState.lastHealthRunAt = Date.now();
      return { ...base, ok: true, accepted: true, message: `re-ran checks: ${health.overallStatus}` };
    }
    case "clearStaleStatus": {
      opsState.clearedStaleAt = Date.now();
      return { ...base, ok: true, accepted: true, message: "stale status cleared" };
    }
    case "restartIngestion":
    case "restartWorkers": {
      if (!controlChannelConfigured()) {
        return {
          ...base,
          ok: false,
          accepted: false,
          message: "disabled — no control channel configured (OPS_CONTROL_ENABLED!=true)",
        };
      }
      // Emit an auditable control request. No process is killed here; an external
      // supervisor subscribed to the control channel performs the actual restart.
      console.warn(
        JSON.stringify({
          level: "warn",
          event: "ops.control.request",
          action: id,
          requestedAt: performedAt,
        }),
      );
      return {
        ...base,
        ok: true,
        accepted: true,
        message: `restart request accepted for ${id === "restartIngestion" ? "ingestion" : "workers"} — supervisor will honor it`,
      };
    }
    default: {
      // Exhaustiveness guard — unknown ids are rejected.
      return {
        id,
        performedAt,
        ok: false,
        accepted: false,
        message: `unknown action: ${String(id)}`,
      };
    }
  }
}
