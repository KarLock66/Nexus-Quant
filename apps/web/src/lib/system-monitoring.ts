import { Exchange, prisma } from "@nexus/db";
import type {
  ConnectorStatus,
  DataQualitySummary,
  DqCheckRollup,
  DqStageScore,
  HealthLevel,
  PipelineStage,
  PipelineState,
  PipelineStatus,
  QueueMetrics,
  ServiceComponent,
  ServiceHealth,
} from "./system-monitoring-types";

/**
 * Server-only data layer for the System Monitoring page. Every value is read
 * from real persisted state (Prisma) and normalized into the wire models in
 * `system-monitoring-types.ts`. Nothing here is mocked: connector health comes
 * from MarketCandle freshness, DQ from DataQualityReport, pipeline stages from
 * the produced artifacts, and queue/worker activity from JobRun.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Map a staleness lag onto health bands (healthy < fresh < degraded < dead). */
function levelFromLag(lagMs: number, freshMs: number, deadMs: number): HealthLevel {
  if (lagMs <= freshMs) return "healthy";
  if (lagMs <= deadMs) return "degraded";
  return "failing";
}

/** Decay a lag onto a 0..100 score (100 while fresh, 0 once past dead). */
function scoreFromLag(lagMs: number, freshMs: number, deadMs: number): number {
  if (lagMs <= freshMs) return 100;
  if (lagMs >= deadMs) return 0;
  return Math.round(100 * (1 - (lagMs - freshMs) / (deadMs - freshMs)));
}

function levelFromScore(score: number): HealthLevel {
  if (score >= 90) return "healthy";
  if (score >= 70) return "degraded";
  return "failing";
}

/** Worst-of reducer over an explicit severity ordering. */
function worstLevel(levels: HealthLevel[]): HealthLevel {
  const rank: Record<HealthLevel, number> = {
    healthy: 0,
    unknown: 1,
    degraded: 2,
    failing: 3,
  };
  return levels.reduce<HealthLevel>(
    (acc, l) => (rank[l] > rank[acc] ? l : acc),
    "healthy",
  );
}

// ─────────────────── A. Service Health ───────────────────

async function probeDatabase(): Promise<ServiceComponent> {
  const start = Date.now();
  try {
    await Promise.race([
      prisma.$queryRaw`SELECT 1`,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("timeout")), 2_000),
      ),
    ]);
    const latencyMs = Date.now() - start;
    return {
      key: "database",
      label: "Postgres / Timescale",
      status: latencyMs < 500 ? "healthy" : "degraded",
      detail: `SELECT 1 in ${latencyMs}ms`,
      latencyMs,
    };
  } catch {
    return {
      key: "database",
      label: "Postgres / Timescale",
      status: "failing",
      detail: "query failed or timed out",
      latencyMs: null,
    };
  }
}

async function probeQuant(): Promise<ServiceComponent> {
  const base = process.env.QUANT_SERVICE_URL;
  if (!base) {
    return {
      key: "quant",
      label: "Quant Service",
      status: "unknown",
      detail: "QUANT_SERVICE_URL not configured",
      latencyMs: null,
    };
  }
  const start = Date.now();
  try {
    const res = await fetch(`${base}/health`, {
      signal: AbortSignal.timeout(2_000),
      cache: "no-store",
    });
    const latencyMs = Date.now() - start;
    return {
      key: "quant",
      label: "Quant Service",
      status: res.ok ? "healthy" : "degraded",
      detail: res.ok ? `/health ${res.status} in ${latencyMs}ms` : `/health ${res.status}`,
      latencyMs,
    };
  } catch {
    return {
      key: "quant",
      label: "Quant Service",
      status: "failing",
      detail: `unreachable at ${base}`,
      latencyMs: null,
    };
  }
}

/**
 * Worker + Redis liveness are inferred from JobRun: BullMQ workers cannot drain
 * a queue without Redis, so a recently active JobRun is positive evidence for
 * both. We do not open a Redis socket from the web tier (no client dependency),
 * so Redis is reported as a derived signal, never a fabricated "ok".
 */
async function probeWorkerAndRedis(): Promise<[ServiceComponent, ServiceComponent]> {
  const latest = await prisma.jobRun.findFirst({
    orderBy: { startedAt: "desc" },
    select: { job: true, status: true, startedAt: true, endedAt: true },
  });

  if (!latest) {
    const unknown: ServiceComponent = {
      key: "worker",
      label: "Workers (BullMQ)",
      status: "unknown",
      detail: "no JobRun rows recorded yet",
      latencyMs: null,
    };
    return [
      unknown,
      {
        key: "redis",
        label: "Redis (derived)",
        status: "unknown",
        detail: "no job activity to infer from",
        latencyMs: null,
      },
    ];
  }

  const lag = Date.now() - latest.startedAt.getTime();
  const fresh = lag <= 15 * MINUTE;
  const workerStatus: HealthLevel =
    latest.status === "FAILED" ? "degraded" : fresh ? "healthy" : "degraded";
  const worker: ServiceComponent = {
    key: "worker",
    label: "Workers (BullMQ)",
    status: workerStatus,
    detail: `last job "${latest.job}" ${latest.status} ${Math.round(lag / MINUTE)}m ago`,
    latencyMs: null,
  };
  const redis: ServiceComponent = {
    key: "redis",
    label: "Redis (derived)",
    status: fresh ? "healthy" : "unknown",
    detail: fresh ? "inferred up — workers draining jobs" : "no recent job activity",
    latencyMs: null,
  };
  return [worker, redis];
}

export async function getServiceHealth(): Promise<ServiceHealth> {
  const api: ServiceComponent = {
    key: "api",
    label: "Web API",
    status: "healthy",
    detail: `up ${Math.round(process.uptime())}s`,
    latencyMs: null,
  };
  const [database, quant, [worker, redis]] = await Promise.all([
    probeDatabase(),
    probeQuant(),
    probeWorkerAndRedis(),
  ]);
  const components = [api, database, redis, quant, worker];
  return {
    status: worstLevel(components.map((c) => c.status)),
    components,
    version: process.env.npm_package_version ?? "0.1.0",
    uptimeSeconds: Math.round(process.uptime()),
  };
}

// ─────────────────── B. Connector Status ───────────────────

export async function getConnectorStatus(): Promise<ConnectorStatus[]> {
  const dayAgo = new Date(Date.now() - DAY);
  const weekAgo = new Date(Date.now() - 7 * DAY);

  const [latest, last24, seriesRows] = await Promise.all([
    prisma.marketCandle.groupBy({ by: ["exchange"], _max: { ts: true } }),
    prisma.marketCandle.groupBy({
      by: ["exchange"],
      where: { ts: { gte: dayAgo } },
      _count: { _all: true },
    }),
    prisma.marketCandle.groupBy({
      by: ["exchange", "symbol"],
      where: { ts: { gte: weekAgo } },
    }),
  ]);

  const rows24h = new Map(last24.map((r) => [r.exchange, r._count._all]));
  const symbolsByExchange = new Map<Exchange, string[]>();
  for (const r of seriesRows) {
    const arr = symbolsByExchange.get(r.exchange) ?? [];
    arr.push(r.symbol);
    symbolsByExchange.set(r.exchange, arr);
  }

  const connectors: ConnectorStatus[] = latest
    .map((r) => {
      const lastTs = r._max.ts;
      const lagMs = lastTs ? Date.now() - lastTs.getTime() : null;
      const status: HealthLevel =
        lagMs === null ? "unknown" : levelFromLag(lagMs, 3 * HOUR, DAY);
      return {
        exchange: r.exchange,
        status,
        lastSyncAt: lastTs ? lastTs.toISOString() : null,
        lagSeconds: lagMs === null ? null : Math.round(lagMs / 1000),
        rowsLast24h: rows24h.get(r.exchange) ?? 0,
        symbols: (symbolsByExchange.get(r.exchange) ?? []).sort(),
        error:
          status === "failing"
            ? "no candles within 24h — connector stalled or backfill pending"
            : null,
      } satisfies ConnectorStatus;
    })
    .sort((a, b) => a.exchange.localeCompare(b.exchange));

  // An empty market-data table yields an EMPTY list — the truth. No synthetic
  // connector entry is ever injected; the UI renders its own explicit
  // "no connectors reporting" state.
  return connectors;
}

// ─────────────────── C. Data Quality ───────────────────

interface DqCheck {
  check: string;
  passed: boolean;
  deduction?: number;
  detail?: string;
}

async function latestTs(
  model: "feature" | "signal" | "candle",
): Promise<Date | null> {
  if (model === "feature") {
    const r = await prisma.featureSnapshot.findFirst({
      orderBy: { createdAt: "desc" },
      select: { createdAt: true },
    });
    return r?.createdAt ?? null;
  }
  if (model === "signal") {
    const r = await prisma.engineSignal.findFirst({
      orderBy: { createdAt: "desc" },
      select: { createdAt: true },
    });
    return r?.createdAt ?? null;
  }
  const r = await prisma.marketCandle.findFirst({
    orderBy: { ts: "desc" },
    select: { ts: true },
  });
  return r?.ts ?? null;
}

export async function getDataQualitySummary(): Promise<DataQualitySummary> {
  const SAMPLE = 200;
  const [reports, candleTs, featureTs, signalTs] = await Promise.all([
    prisma.dataQualityReport.findMany({
      orderBy: { createdAt: "desc" },
      take: SAMPLE,
      select: {
        score: true,
        status: true,
        checks: true,
        exchange: true,
        symbol: true,
        timeframe: true,
      },
    }),
    latestTs("candle"),
    latestTs("feature"),
    latestTs("signal"),
  ]);

  // Latest report per (exchange, symbol, timeframe) — `reports` is desc, so the
  // first occurrence of each key is the most recent.
  const latestPerSeries = new Map<string, (typeof reports)[number]>();
  for (const r of reports) {
    const key = `${r.exchange}|${r.symbol}|${r.timeframe ?? "-"}`;
    if (!latestPerSeries.has(key)) latestPerSeries.set(key, r);
  }
  const latest = [...latestPerSeries.values()];

  const overallScore =
    latest.length > 0
      ? Math.round(latest.reduce((s, r) => s + r.score, 0) / latest.length)
      : null;
  const passCount = reports.filter((r) => r.status === "PASSED").length;
  const passRate = reports.length > 0 ? passCount / reports.length : null;

  // Roll up failed checks across the sample for the anomaly count + worst list.
  const rollup = new Map<string, { fails: number; deduction: number }>();
  let anomalyCount = 0;
  for (const r of reports) {
    const checks = Array.isArray(r.checks) ? (r.checks as unknown as DqCheck[]) : [];
    for (const c of checks) {
      if (c && c.passed === false) {
        anomalyCount += 1;
        const cur = rollup.get(c.check) ?? { fails: 0, deduction: 0 };
        cur.fails += 1;
        cur.deduction += Number(c.deduction ?? 0);
        rollup.set(c.check, cur);
      }
    }
  }
  const worstChecks: DqCheckRollup[] = [...rollup.entries()]
    .map(([check, v]) => ({
      check,
      failRate: reports.length > 0 ? v.fails / reports.length : 0,
      deduction: v.deduction,
    }))
    .sort((a, b) => b.deduction - a.deduction)
    .slice(0, 5);

  // Per-stage health: each stage's score reflects the real health of that stage.
  const ingestScore =
    candleTs === null ? 0 : scoreFromLag(Date.now() - candleTs.getTime(), 3 * HOUR, DAY);
  const transformScore = overallScore ?? 0;
  const featureScore =
    featureTs === null ? 0 : scoreFromLag(Date.now() - featureTs.getTime(), 6 * HOUR, 2 * DAY);
  const signalScore =
    signalTs === null ? 0 : scoreFromLag(Date.now() - signalTs.getTime(), 6 * HOUR, 2 * DAY);

  const stages: DqStageScore[] = [
    { stage: "ingest", score: ingestScore, status: levelFromScore(ingestScore) },
    { stage: "transform", score: transformScore, status: levelFromScore(transformScore) },
    { stage: "feature", score: featureScore, status: levelFromScore(featureScore) },
    { stage: "signal", score: signalScore, status: levelFromScore(signalScore) },
  ];

  return {
    overallScore,
    status: overallScore === null ? "unknown" : levelFromScore(overallScore),
    passRate,
    failureRate: passRate === null ? null : Number((1 - passRate).toFixed(4)),
    anomalyCount,
    reportsSampled: reports.length,
    stages,
    worstChecks,
  };
}

// ─────────────────── D. Pipeline / Runtime ───────────────────

const PIPELINE_JOB_PATTERNS: Record<string, RegExp> = {
  ingest: /ingest|candle|backfill|connector/i,
  dq: /dq|quality|gateway/i,
  feature: /feature|snapshot/i,
  signal: /signal|engine|pipeline/i,
};

interface RecentJob {
  job: string;
  status: string;
  startedAt: Date;
  endedAt: Date | null;
}

function stageState(
  key: string,
  lastRunAt: Date | null,
  count24h: number,
  jobs: RecentJob[],
): PipelineState {
  if (lastRunAt === null && count24h === 0) return "empty";
  const pattern = PIPELINE_JOB_PATTERNS[key];
  const match = pattern ? jobs.find((j) => pattern.test(j.job)) : undefined;
  if (match?.status === "RUNNING") return "running";
  if (match?.status === "FAILED") return "failing";
  const lagMs = lastRunAt ? Date.now() - lastRunAt.getTime() : Infinity;
  if (lagMs > DAY) return "failing";
  return "idle";
}

export async function getPipelineStatus(): Promise<PipelineStatus> {
  const dayAgo = new Date(Date.now() - DAY);
  const [
    candleLast,
    candle24h,
    dqLast,
    dq24h,
    featLast,
    feat24h,
    sigLast,
    sig24h,
    recentJobs,
  ] = await Promise.all([
    prisma.marketCandle.findFirst({ orderBy: { ts: "desc" }, select: { ts: true } }),
    prisma.marketCandle.count({ where: { ts: { gte: dayAgo } } }),
    prisma.dataQualityReport.findFirst({
      orderBy: { createdAt: "desc" },
      select: { createdAt: true },
    }),
    prisma.dataQualityReport.count({ where: { createdAt: { gte: dayAgo } } }),
    prisma.featureSnapshot.findFirst({
      orderBy: { createdAt: "desc" },
      select: { createdAt: true },
    }),
    prisma.featureSnapshot.count({ where: { createdAt: { gte: dayAgo } } }),
    prisma.engineSignal.findFirst({
      orderBy: { createdAt: "desc" },
      select: { createdAt: true },
    }),
    prisma.engineSignal.count({ where: { createdAt: { gte: dayAgo } } }),
    prisma.jobRun.findMany({
      where: { startedAt: { gte: dayAgo } },
      orderBy: { startedAt: "desc" },
      take: 200,
      select: { job: true, status: true, startedAt: true, endedAt: true },
    }),
  ]);

  const def: { key: string; label: string; last: Date | null; count: number }[] = [
    { key: "ingest", label: "Market Data Ingest", last: candleLast?.ts ?? null, count: candle24h },
    { key: "dq", label: "Data Quality Gateway", last: dqLast?.createdAt ?? null, count: dq24h },
    { key: "feature", label: "Feature Store", last: featLast?.createdAt ?? null, count: feat24h },
    { key: "signal", label: "Signal Engine", last: sigLast?.createdAt ?? null, count: sig24h },
  ];

  const stages: PipelineStage[] = def.map((d) => {
    const state = stageState(d.key, d.last, d.count, recentJobs);
    const lagMs = d.last ? Date.now() - d.last.getTime() : null;
    return {
      key: d.key,
      label: d.label,
      state,
      lastRunAt: d.last ? d.last.toISOString() : null,
      lagSeconds: lagMs === null ? null : Math.round(lagMs / 1000),
      count24h: d.count,
      detail:
        d.last === null
          ? "no artifacts produced"
          : `${d.count} in 24h · last ${Math.round((lagMs ?? 0) / MINUTE)}m ago`,
    };
  });

  const states = stages.map((s) => s.state);
  const overall: PipelineState = states.includes("failing")
    ? "failing"
    : states.includes("running")
      ? "running"
      : states.every((s) => s === "empty")
        ? "empty"
        : "idle";

  return { state: overall, stages, lastSignalAt: sigLast?.createdAt.toISOString() ?? null };
}

// ─────────────────── E. Queues / Workers ───────────────────

export async function getQueueMetrics(): Promise<QueueMetrics> {
  const windowStart = new Date(Date.now() - DAY);
  const recent = await prisma.jobRun.findMany({
    where: { startedAt: { gte: windowStart } },
    orderBy: { startedAt: "desc" },
    take: 500,
    select: { job: true, status: true, startedAt: true, endedAt: true },
  });

  const running = recent.filter((j) => j.status === "RUNNING");
  const ok = recent.filter((j) => j.status === "OK");
  const failed = recent.filter((j) => j.status === "FAILED");

  const completed = recent.filter((j) => j.endedAt !== null);
  const avgLatencyMs =
    completed.length > 0
      ? Math.round(
          completed.reduce(
            (s, j) => s + (j.endedAt!.getTime() - j.startedAt.getTime()),
            0,
          ) / completed.length,
        )
      : null;

  // Throughput over the actual elapsed window (oldest sampled row → now),
  // bounded so a single old row can't deflate the rate to ~0.
  const oldest = recent.length > 0 ? recent[recent.length - 1]!.startedAt.getTime() : Date.now();
  const windowMin = Math.max(1, (Date.now() - oldest) / MINUTE);
  const processingRatePerMin =
    recent.length > 0 ? Number((ok.length / windowMin).toFixed(3)) : null;

  return {
    depth: running.length,
    processingRatePerMin,
    activeWorkers: new Set(running.map((j) => j.job)).size,
    failed24h: failed.length,
    ok24h: ok.length,
    avgLatencyMs,
    deadLetter: failed.length,
    jobs: recent.slice(0, 12).map((j) => ({
      job: j.job,
      status: j.status,
      startedAt: j.startedAt.toISOString(),
      endedAt: j.endedAt ? j.endedAt.toISOString() : null,
      durationMs: j.endedAt ? j.endedAt.getTime() - j.startedAt.getTime() : null,
    })),
  };
}
