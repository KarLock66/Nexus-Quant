import net from "node:net";
import { prisma } from "@nexus/db";
import type {
  ComponentStatus,
  OpsComponent,
  OverallStatus,
  SystemHealth,
} from "./ops-types";

/**
 * Phase 9.6 — System Health Aggregator (Section A).
 *
 * Single source of truth for "is the platform alive?". Every component status is
 * COMPUTED from a real probe or real persisted evidence — never hardcoded — and
 * the aggregation is FAIL-CLOSED: an unknown / unreachable required component can
 * never round up to "healthy".
 *
 * Probes by component:
 *   - web        : this process (uptime — we are, by definition, up to answer).
 *   - database   : Prisma `SELECT 1` with a hard timeout.
 *   - redis      : a real RESP `PING` over a raw TCP socket (node:net). The web
 *                  tier deliberately has NO ioredis dependency, so we speak the
 *                  two-byte protocol directly rather than fabricate an "ok".
 *   - quant      : GET {QUANT_SERVICE_URL}/health.
 *   - ingestion  : derived from the freshness of the live market-data tables it
 *                  writes (MarketTick / OrderbookSnapshot / MarketCandle).
 *   - workers    : derived from JobRun heartbeats + EngineSignal production.
 *
 * Reused intentionally NOWHERE from the sealed business logic — this module only
 * READS persisted state and opens short-lived probe connections.
 */

const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

const PROBE_TIMEOUT_MS = 2_000;

/** Map an age (ms) onto a component status using two thresholds. */
function statusFromAge(
  ageMs: number | null,
  healthyWithinMs: number,
  degradedWithinMs: number,
): ComponentStatus {
  if (ageMs === null) return "unknown";
  if (ageMs <= healthyWithinMs) return "healthy";
  if (ageMs <= degradedWithinMs) return "degraded";
  return "failing";
}

// ─────────────────── individual probes ───────────────────

function probeWeb(): OpsComponent {
  return {
    key: "web",
    label: "Web / API (Next.js)",
    status: "healthy",
    required: true,
    detail: `serving — uptime ${Math.round(process.uptime())}s`,
    latencyMs: null,
    lastObservedAt: new Date().toISOString(),
  };
}

async function probeDatabase(): Promise<OpsComponent> {
  const start = Date.now();
  try {
    await Promise.race([
      prisma.$queryRaw`SELECT 1`,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("timeout")), PROBE_TIMEOUT_MS),
      ),
    ]);
    const latencyMs = Date.now() - start;
    return {
      key: "database",
      label: "Postgres / TimescaleDB",
      status: latencyMs < 500 ? "healthy" : "degraded",
      required: true,
      detail: `SELECT 1 in ${latencyMs}ms`,
      latencyMs,
      lastObservedAt: new Date().toISOString(),
    };
  } catch (err) {
    return {
      key: "database",
      label: "Postgres / TimescaleDB",
      status: "failing",
      required: true,
      detail: `unreachable — ${err instanceof Error ? err.message : String(err)}`,
      latencyMs: null,
      lastObservedAt: null,
    };
  }
}

/**
 * Real Redis liveness via a raw RESP `PING`. Parses `redis://[:pass@]host:port`.
 * No ioredis: the web bundle must not grow a Redis client just to ping. Resolves
 * (never rejects) so the aggregator stays fail-closed.
 */
function pingRedis(
  url: string,
  timeoutMs = PROBE_TIMEOUT_MS,
): Promise<{ ok: boolean; latencyMs: number | null; detail: string }> {
  let host = "127.0.0.1";
  let port = 6379;
  let password: string | undefined;
  try {
    const u = new URL(url);
    if (u.hostname) host = u.hostname;
    if (u.port) port = Number(u.port);
    if (u.password) password = decodeURIComponent(u.password);
  } catch {
    return Promise.resolve({ ok: false, latencyMs: null, detail: `invalid REDIS_URL` });
  }

  const start = Date.now();
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    let buf = "";
    const finish = (ok: boolean, detail: string) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve({ ok, latencyMs: ok ? Date.now() - start : null, detail });
    };
    socket.setTimeout(timeoutMs);
    socket.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      if (buf.includes("+PONG")) finish(true, `PING → PONG in ${Date.now() - start}ms`);
      else if (/-(ERR|NOAUTH|WRONGPASS|NOPERM)/i.test(buf))
        finish(false, `auth/cmd error: ${buf.trim().slice(0, 80)}`);
    });
    socket.on("timeout", () => finish(false, `timeout after ${timeoutMs}ms`));
    socket.on("error", (e) => finish(false, e.message));
    socket.connect(port, host, () => {
      socket.write(password ? `AUTH ${password}\r\nPING\r\n` : "PING\r\n");
    });
  });
}

async function probeRedis(): Promise<OpsComponent> {
  const url = process.env.REDIS_URL;
  if (!url) {
    return {
      key: "redis",
      label: "Redis",
      status: "unknown",
      required: false,
      detail: "REDIS_URL not configured (in-process bus mode)",
      latencyMs: null,
      lastObservedAt: null,
    };
  }
  const r = await pingRedis(url);
  return {
    key: "redis",
    label: "Redis",
    status: r.ok ? "healthy" : "failing",
    required: true,
    detail: r.detail,
    latencyMs: r.latencyMs,
    lastObservedAt: r.ok ? new Date().toISOString() : null,
  };
}

async function probeQuant(): Promise<OpsComponent> {
  const base = process.env.QUANT_SERVICE_URL;
  if (!base) {
    return {
      key: "quant",
      label: "Quant Service",
      status: "unknown",
      required: false,
      detail: "QUANT_SERVICE_URL not configured",
      latencyMs: null,
      lastObservedAt: null,
    };
  }
  const start = Date.now();
  try {
    const res = await fetch(`${base.replace(/\/$/, "")}/health`, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      cache: "no-store",
    });
    const latencyMs = Date.now() - start;
    return {
      key: "quant",
      label: "Quant Service",
      status: res.ok ? "healthy" : "degraded",
      required: false,
      detail: res.ok ? `/health ${res.status} in ${latencyMs}ms` : `/health ${res.status}`,
      latencyMs,
      lastObservedAt: res.ok ? new Date().toISOString() : null,
    };
  } catch {
    return {
      key: "quant",
      label: "Quant Service",
      status: "failing",
      required: false,
      detail: `unreachable at ${base}`,
      latencyMs: null,
      lastObservedAt: null,
    };
  }
}

/**
 * Ingestion liveness is DERIVED from the freshness of the tables the live feed
 * writes. Whichever of ticks / orderbook / candles is freshest carries the signal
 * (a venue that only streams candles in demo mode still reads as alive).
 */
async function probeIngestion(): Promise<OpsComponent> {
  let latest: Date | null = null;
  try {
    const [tick, book, candle] = await Promise.all([
      prisma.marketTick.findFirst({ orderBy: { ts: "desc" }, select: { ts: true } }),
      prisma.orderbookSnapshot.findFirst({ orderBy: { ts: "desc" }, select: { ts: true } }),
      prisma.marketCandle.findFirst({ orderBy: { ts: "desc" }, select: { ts: true } }),
    ]);
    for (const ts of [tick?.ts, book?.ts, candle?.ts]) {
      if (ts && (latest === null || ts > latest)) latest = ts;
    }
  } catch (err) {
    return {
      key: "ingestion",
      label: "Ingestion Service",
      status: "unknown",
      required: false,
      detail: `cannot read market data — ${err instanceof Error ? err.message : String(err)}`,
      latencyMs: null,
      lastObservedAt: null,
    };
  }

  const ageMs = latest ? Date.now() - latest.getTime() : null;
  const status = statusFromAge(ageMs, 2 * MINUTE, HOUR);
  return {
    key: "ingestion",
    label: "Ingestion Service",
    status,
    required: false,
    detail:
      ageMs === null
        ? "no market data ingested yet"
        : `freshest market data ${Math.round(ageMs / SECOND)}s ago`,
    latencyMs: null,
    lastObservedAt: latest ? latest.toISOString() : null,
  };
}

/**
 * Worker liveness is DERIVED from JobRun heartbeats (BullMQ/pipeline write them)
 * and EngineSignal production. A FAILED most-recent job degrades the status even
 * when recent.
 */
async function probeWorkers(): Promise<OpsComponent> {
  let job: { job: string; status: string; startedAt: Date } | null = null;
  let signalAt: Date | null = null;
  try {
    const [latestJob, latestSignal] = await Promise.all([
      prisma.jobRun.findFirst({
        orderBy: { startedAt: "desc" },
        select: { job: true, status: true, startedAt: true },
      }),
      prisma.engineSignal.findFirst({
        orderBy: { createdAt: "desc" },
        select: { createdAt: true },
      }),
    ]);
    job = latestJob;
    signalAt = latestSignal?.createdAt ?? null;
  } catch (err) {
    return {
      key: "workers",
      label: "Workers (signal pipeline)",
      status: "unknown",
      required: false,
      detail: `cannot read job activity — ${err instanceof Error ? err.message : String(err)}`,
      latencyMs: null,
      lastObservedAt: null,
    };
  }

  // Freshest evidence of worker activity: a heartbeat or a produced signal.
  const evidence = [job?.startedAt, signalAt].filter(Boolean) as Date[];
  const latest = evidence.length
    ? evidence.reduce((a, b) => (a > b ? a : b))
    : null;
  const ageMs = latest ? Date.now() - latest.getTime() : null;
  let status = statusFromAge(ageMs, 5 * MINUTE, HOUR);
  if (job?.status === "FAILED" && status === "healthy") status = "degraded";

  return {
    key: "workers",
    label: "Workers (signal pipeline)",
    status,
    required: false,
    detail:
      latest === null
        ? "no job activity recorded yet"
        : job
          ? `last job "${job.job}" ${job.status} · ${Math.round((ageMs ?? 0) / SECOND)}s ago`
          : `last signal ${Math.round((ageMs ?? 0) / SECOND)}s ago`,
    latencyMs: null,
    lastObservedAt: latest ? latest.toISOString() : null,
  };
}

// ─────────────────── aggregation (pure, testable) ───────────────────

/** Components whose hard failure makes the WHOLE platform critical. */
const CRITICAL_TIER: ReadonlySet<string> = new Set(["database", "redis"]);

/**
 * Fail-closed reduction of component statuses to a single platform verdict.
 *   critical : a critical-tier component (database / configured redis) is failing.
 *   degraded : anything failing/degraded, or a REQUIRED component is unknown.
 *   healthy  : everything healthy (optional, unconfigured components may be unknown).
 */
export function reduceOverall(components: OpsComponent[]): OverallStatus {
  const criticalDown = components.some(
    (c) => CRITICAL_TIER.has(c.key) && c.status === "failing",
  );
  if (criticalDown) return "critical";

  const anyBad = components.some(
    (c) => c.status === "failing" || c.status === "degraded",
  );
  const requiredUnknown = components.some(
    (c) => c.required && c.status === "unknown",
  );
  if (anyBad || requiredUnknown) return "degraded";

  return "healthy";
}

/** Aggregate health across every platform component (Section A entrypoint). */
export async function getSystemHealth(): Promise<SystemHealth> {
  const [database, redis, quant, ingestion, workers] = await Promise.all([
    probeDatabase(),
    probeRedis(),
    probeQuant(),
    probeIngestion(),
    probeWorkers(),
  ]);
  const components: OpsComponent[] = [
    probeWeb(),
    database,
    redis,
    quant,
    ingestion,
    workers,
  ];
  return {
    overallStatus: reduceOverall(components),
    components,
    version: process.env.npm_package_version ?? "0.1.0",
    uptimeSeconds: Math.round(process.uptime()),
    checkedAt: new Date().toISOString(),
  };
}
