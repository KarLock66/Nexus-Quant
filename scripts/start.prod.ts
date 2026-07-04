/**
 * Phase 9.6 — Production startup validation (Section G).
 *
 * Single source of truth for "is the platform safe to serve?". Optionally starts
 * the infra containers, then VERIFIES every dependency and emits a final health
 * summary. FAIL-CLOSED: a down hard-dependency (database, or Redis when
 * configured) exits non-zero so a supervisor never routes traffic to a broken
 * stack.
 *
 * Dependency-light by design — Node built-ins + fetch only. The Prisma client is
 * imported DYNAMICALLY: when the workspace is linked we run a real `SELECT 1`;
 * otherwise we fall back to a raw TCP connect so the script still runs anywhere.
 *
 * Usage:
 *   pnpm start:prod                 # verify only
 *   pnpm start:prod --start-infra   # docker compose up -d postgres redis quant, then verify
 *   START_INFRA=1 pnpm start:prod   # same, via env
 */

import net from "node:net";
import { spawnSync } from "node:child_process";

type Status = "ok" | "warn" | "down" | "skipped";

interface CheckResult {
  name: string;
  required: boolean;
  status: Status;
  detail: string;
  latencyMs: number | null;
}

const WEB_URL = process.env.WEB_URL ?? "http://localhost:3000";
const QUANT_URL = process.env.QUANT_SERVICE_URL ?? "http://localhost:8000";
const REDIS_URL = process.env.REDIS_URL ?? "";
const DATABASE_URL = process.env.DATABASE_URL ?? "";
const TIMEOUT_MS = 3_000;
const WANT_INFRA =
  process.argv.includes("--start-infra") || process.env.START_INFRA === "1";

function log(msg: string): void {
  // eslint-disable-next-line no-console
  console.log(msg);
}

/** Parse host/port from a URL-ish string with a default port. */
function hostPort(raw: string, defaultPort: number): { host: string; port: number } {
  try {
    const u = new URL(raw);
    return { host: u.hostname || "127.0.0.1", port: u.port ? Number(u.port) : defaultPort };
  } catch {
    return { host: "127.0.0.1", port: defaultPort };
  }
}

/** Raw TCP connectivity probe (port open?). Resolves, never rejects. */
function tcpConnect(host: string, port: number, timeoutMs = TIMEOUT_MS): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const done = (ok: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
    socket.connect(port, host);
  });
}

/** Real Redis RESP PING (with optional AUTH). Resolves, never rejects. */
function redisPing(raw: string, timeoutMs = TIMEOUT_MS): Promise<{ ok: boolean; detail: string }> {
  const { host, port } = hostPort(raw, 6379);
  let password: string | undefined;
  try {
    const u = new URL(raw);
    if (u.password) password = decodeURIComponent(u.password);
  } catch {
    /* defaults */
  }
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    let buf = "";
    const done = (ok: boolean, detail: string) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve({ ok, detail });
    };
    socket.setTimeout(timeoutMs);
    socket.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      if (buf.includes("+PONG")) done(true, "PING → PONG");
      else if (/-(ERR|NOAUTH|WRONGPASS|NOPERM)/i.test(buf)) done(false, buf.trim().slice(0, 80));
    });
    socket.on("timeout", () => done(false, "timeout"));
    socket.on("error", (e) => done(false, e.message));
    socket.connect(port, host, () => {
      socket.write(password ? `AUTH ${password}\r\nPING\r\n` : "PING\r\n");
    });
  });
}

async function httpOk(url: string, timeoutMs = TIMEOUT_MS): Promise<{ ok: boolean; status: number | null; detail: string }> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), cache: "no-store" });
    return { ok: res.ok, status: res.status, detail: `HTTP ${res.status}` };
  } catch (err) {
    return { ok: false, status: null, detail: err instanceof Error ? err.message : String(err) };
  }
}

/** Lazily resolve the Prisma client without making it a hard dependency. */
async function tryPrisma(): Promise<{
  prisma: { $queryRaw: (q: TemplateStringsArray) => Promise<unknown>; [k: string]: unknown };
} | null> {
  try {
    // @ts-expect-error — resolved at runtime only when the workspace is linked.
    const mod = await import("@nexus/db");
    return mod as never;
  } catch {
    return null;
  }
}

// ─────────────────── infra ───────────────────

function startInfra(): void {
  log("→ starting infra (docker compose up -d postgres redis quant)…");
  const res = spawnSync(
    "docker",
    ["compose", "-f", "docker/docker-compose.yml", "up", "-d", "postgres", "redis", "quant"],
    { stdio: "inherit", shell: false },
  );
  if (res.error) {
    log(`  ! docker not available (${res.error.message}) — continuing to verify what is up`);
  } else if (res.status !== 0) {
    log(`  ! docker compose exited ${res.status} — continuing to verify`);
  } else {
    log("  ✓ infra containers requested");
  }
}

// ─────────────────── checks ───────────────────

async function checkDatabase(prismaMod: Awaited<ReturnType<typeof tryPrisma>>): Promise<CheckResult> {
  const start = Date.now();
  if (prismaMod) {
    try {
      await Promise.race([
        prismaMod.prisma.$queryRaw`SELECT 1`,
        new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), TIMEOUT_MS)),
      ]);
      return { name: "database", required: true, status: "ok", detail: "SELECT 1", latencyMs: Date.now() - start };
    } catch (err) {
      return {
        name: "database",
        required: true,
        status: "down",
        detail: `query failed — ${err instanceof Error ? err.message : String(err)}`,
        latencyMs: null,
      };
    }
  }
  // Fallback: TCP to the configured DB port.
  if (!DATABASE_URL) {
    return { name: "database", required: true, status: "down", detail: "DATABASE_URL not set", latencyMs: null };
  }
  const { host, port } = hostPort(DATABASE_URL, 5432);
  const ok = await tcpConnect(host, port);
  return {
    name: "database",
    required: true,
    status: ok ? "ok" : "down",
    detail: ok ? `port ${host}:${port} open (no client; TCP probe)` : `cannot reach ${host}:${port}`,
    latencyMs: ok ? Date.now() - start : null,
  };
}

/**
 * Zero-demo discipline: production validation FAILS while the platform-wide
 * DEMO_MODE opt-in is set — a production stack must never serve synthetic data.
 */
function checkDemoMode(): CheckResult {
  const raw = (process.env.DEMO_MODE ?? "").trim().toLowerCase();
  const enabled = ["true", "1", "yes"].includes(raw);
  return {
    name: "demo-mode",
    required: true,
    status: enabled ? "down" : "ok",
    detail: enabled
      ? "DEMO_MODE is enabled — synthetic data opt-in is active; unset it for production"
      : "DEMO_MODE off (live data only)",
    latencyMs: null,
  };
}

/**
 * Real-venue broker configuration (Final production completion). When
 * MARKET_BROKER=real is requested, the live order-routing prerequisites must
 * hold or the worker will (correctly) refuse to arm execution — surface that
 * misconfiguration HERE, at startup validation, instead of as a silent
 * signals-only runtime: credentials present, realtime marks selected, and a
 * durable market journal configured. Any other broker value passes as skipped.
 */
function checkBrokerConfig(): CheckResult {
  const broker = (process.env.MARKET_BROKER ?? "").trim();
  if (broker !== "real") {
    return {
      name: "broker",
      required: false,
      status: "skipped",
      detail: broker === "" ? "MARKET_BROKER not set (execution unarmed)" : `${broker} broker (deterministic)`,
      latencyMs: null,
    };
  }
  const missing: string[] = [];
  if ((process.env.DERIBIT_CLIENT_ID ?? "").trim() === "") missing.push("DERIBIT_CLIENT_ID");
  if ((process.env.DERIBIT_CLIENT_SECRET ?? "").trim() === "") missing.push("DERIBIT_CLIENT_SECRET");
  if ((process.env.MARKET_DATA_SOURCE ?? "").trim() !== "realtime") missing.push("MARKET_DATA_SOURCE=realtime");
  if ((process.env.MARKET_JOURNAL_PATH ?? "").trim() === "") missing.push("MARKET_JOURNAL_PATH");
  const venueEnv = (process.env.DERIBIT_ENV ?? "test").trim().toLowerCase();
  if (venueEnv !== "live" && venueEnv !== "test") missing.push("DERIBIT_ENV (live|test)");
  if (missing.length > 0) {
    return {
      name: "broker",
      required: true,
      status: "down",
      detail: `MARKET_BROKER=real but missing/invalid: ${missing.join(", ")} (execution would stay unarmed)`,
      latencyMs: null,
    };
  }
  return {
    name: "broker",
    required: true,
    status: "ok",
    detail: `real venue configured (Deribit ${venueEnv.toUpperCase()} environment)`,
    latencyMs: null,
  };
}

async function checkRedis(): Promise<CheckResult> {
  if (!REDIS_URL) {
    return { name: "redis", required: false, status: "skipped", detail: "REDIS_URL not set (in-process bus)", latencyMs: null };
  }
  const start = Date.now();
  const r = await redisPing(REDIS_URL);
  return { name: "redis", required: true, status: r.ok ? "ok" : "down", detail: r.detail, latencyMs: r.ok ? Date.now() - start : null };
}

async function checkQuant(): Promise<CheckResult> {
  const start = Date.now();
  const r = await httpOk(`${QUANT_URL.replace(/\/$/, "")}/health`);
  return { name: "quant", required: false, status: r.ok ? "ok" : "warn", detail: `${QUANT_URL} ${r.detail}`, latencyMs: r.ok ? Date.now() - start : null };
}

async function checkWeb(): Promise<CheckResult> {
  const start = Date.now();
  const r = await httpOk(`${WEB_URL.replace(/\/$/, "")}/api/v1/ops/health`);
  return { name: "web", required: false, status: r.ok ? "ok" : "warn", detail: `${WEB_URL} ${r.detail}`, latencyMs: r.ok ? Date.now() - start : null };
}

async function checkWorkers(prismaMod: Awaited<ReturnType<typeof tryPrisma>>): Promise<CheckResult> {
  if (!prismaMod) {
    return { name: "workers", required: false, status: "skipped", detail: "no db client to infer activity", latencyMs: null };
  }
  try {
    const jobRun = prismaMod.prisma["jobRun"] as {
      findFirst: (a: unknown) => Promise<{ job: string; status: string; startedAt: Date } | null>;
    };
    const latest = await jobRun.findFirst({ orderBy: { startedAt: "desc" }, select: { job: true, status: true, startedAt: true } });
    if (!latest) return { name: "workers", required: false, status: "warn", detail: "no JobRun activity yet", latencyMs: null };
    const ageMin = Math.round((Date.now() - new Date(latest.startedAt).getTime()) / 60000);
    return {
      name: "workers",
      required: false,
      status: ageMin <= 30 ? "ok" : "warn",
      detail: `last job "${latest.job}" ${latest.status} ${ageMin}m ago`,
      latencyMs: null,
    };
  } catch (err) {
    return { name: "workers", required: false, status: "warn", detail: `cannot read JobRun — ${err instanceof Error ? err.message : String(err)}`, latencyMs: null };
  }
}

async function checkIngestion(prismaMod: Awaited<ReturnType<typeof tryPrisma>>): Promise<CheckResult> {
  if (!prismaMod) {
    return { name: "ingestion", required: false, status: "skipped", detail: "no db client to infer freshness", latencyMs: null };
  }
  try {
    const candle = prismaMod.prisma["marketCandle"] as {
      findFirst: (a: unknown) => Promise<{ ts: Date } | null>;
    };
    const latest = await candle.findFirst({ orderBy: { ts: "desc" }, select: { ts: true } });
    if (!latest) return { name: "ingestion", required: false, status: "warn", detail: "no market data yet", latencyMs: null };
    const ageMin = Math.round((Date.now() - new Date(latest.ts).getTime()) / 60000);
    return { name: "ingestion", required: false, status: ageMin <= 60 ? "ok" : "warn", detail: `freshest candle ${ageMin}m ago`, latencyMs: null };
  } catch (err) {
    return { name: "ingestion", required: false, status: "warn", detail: `cannot read market data — ${err instanceof Error ? err.message : String(err)}`, latencyMs: null };
  }
}

// ─────────────────── runner ───────────────────

function symbol(s: Status): string {
  return s === "ok" ? "✓" : s === "warn" ? "▲" : s === "skipped" ? "·" : "✗";
}

async function main(): Promise<void> {
  log("Nexus Quant — production startup validation (Phase 9.6)");
  if (WANT_INFRA) startInfra();

  const prismaMod = await tryPrisma();
  const checks = await Promise.all([
    Promise.resolve(checkDemoMode()),
    Promise.resolve(checkBrokerConfig()),
    checkDatabase(prismaMod),
    checkRedis(),
    checkQuant(),
    checkIngestion(prismaMod),
    checkWorkers(prismaMod),
    checkWeb(),
  ]);

  log("\nComponent health:");
  for (const c of checks) {
    const lat = c.latencyMs !== null ? ` (${c.latencyMs}ms)` : "";
    log(`  ${symbol(c.status)} ${c.name.padEnd(10)} ${c.status.toUpperCase().padEnd(8)} ${c.detail}${lat}`);
  }

  const requiredDown = checks.filter((c) => c.required && c.status === "down");
  const overall: "healthy" | "degraded" | "critical" =
    requiredDown.length > 0
      ? "critical"
      : checks.some((c) => c.status === "warn" || c.status === "down")
        ? "degraded"
        : "healthy";

  const summary = {
    overall,
    checkedAt: new Date().toISOString(),
    components: checks.map((c) => ({ name: c.name, status: c.status, required: c.required, detail: c.detail })),
  };
  log(`\nSUMMARY ${JSON.stringify(summary)}`);

  if (prismaMod) {
    const pc = prismaMod.prisma as { $disconnect?: () => Promise<void> };
    await pc.$disconnect?.().catch(() => undefined);
  }

  // Fail-closed: a down hard-dependency blocks the boot.
  if (overall === "critical") {
    log(`\n✗ STARTUP FAILED — required component(s) down: ${requiredDown.map((c) => c.name).join(", ")}`);
    process.exit(1);
  }
  log(`\n${overall === "healthy" ? "✓" : "▲"} startup validation ${overall}`);
  process.exit(0);
}

main().catch((err) => {
  log(`fatal: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
