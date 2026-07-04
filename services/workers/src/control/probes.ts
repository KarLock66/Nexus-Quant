/**
 * Phase 9.7 — worker-side health probes. The control plane lives where trading happens
 * (the worker), so it probes infra directly rather than trusting the web tier. These
 * mirror the proven Phase 9.6 probes (`apps/web/src/lib/system-health.ts`): a Prisma
 * `SELECT 1`, a raw RESP `PING` over node:net (no ioredis connection churn), and a
 * quant `GET /health`. Every probe RESOLVES (never rejects) and maps uncertainty to a
 * fail-closed status so the evaluators stay conservative.
 */

import net from "node:net";
import { prisma } from "@nexus/db";
import type { ComponentHealth } from "@nexus/control";

const PROBE_TIMEOUT_MS = 2_000;

/** Database: `SELECT 1` with a hard timeout. */
export async function probeDatabase(): Promise<{ health: ComponentHealth; detail: string }> {
  const start = Date.now();
  try {
    await Promise.race([
      prisma.$queryRaw`SELECT 1`,
      new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), PROBE_TIMEOUT_MS)),
    ]);
    const ms = Date.now() - start;
    return { health: ms < 500 ? "healthy" : "degraded", detail: `SELECT 1 in ${ms}ms` };
  } catch (err) {
    return { health: "failing", detail: `unreachable — ${err instanceof Error ? err.message : String(err)}` };
  }
}

/** Real Redis liveness via a raw RESP PING. Parses redis://[:pass@]host:port. */
function pingRedis(url: string): Promise<{ ok: boolean; detail: string }> {
  let host = "127.0.0.1";
  let port = 6379;
  let password: string | undefined;
  try {
    const u = new URL(url);
    if (u.hostname) host = u.hostname;
    if (u.port) port = Number(u.port);
    if (u.password) password = decodeURIComponent(u.password);
  } catch {
    return Promise.resolve({ ok: false, detail: "invalid REDIS_URL" });
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
      resolve({ ok, detail });
    };
    socket.setTimeout(PROBE_TIMEOUT_MS);
    socket.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      if (buf.includes("+PONG")) finish(true, `PING → PONG in ${Date.now() - start}ms`);
      else if (/-(ERR|NOAUTH|WRONGPASS|NOPERM)/i.test(buf)) finish(false, `auth/cmd error`);
    });
    socket.on("timeout", () => finish(false, `timeout after ${PROBE_TIMEOUT_MS}ms`));
    socket.on("error", (e) => finish(false, e.message));
    socket.connect(port, host, () => {
      socket.write(password ? `AUTH ${password}\r\nPING\r\n` : "PING\r\n");
    });
  });
}

/**
 * Redis health. REDIS_URL is REQUIRED for the control plane (the Section B trade
 * condition + Section I startup check) — when unset, health is `unknown` (fail-closed,
 * never healthy).
 */
export async function probeRedis(url: string | undefined): Promise<{ health: ComponentHealth; detail: string }> {
  if (!url) return { health: "unknown", detail: "REDIS_URL not configured" };
  const r = await pingRedis(url);
  return { health: r.ok ? "healthy" : "failing", detail: r.detail };
}

/** Quant health via GET {url}/health. */
export async function probeQuant(url: string | undefined): Promise<{ health: ComponentHealth; detail: string }> {
  if (!url) return { health: "unknown", detail: "QUANT_SERVICE_URL not configured" };
  const start = Date.now();
  try {
    const res = await fetch(`${url.replace(/\/$/, "")}/health`, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    const ms = Date.now() - start;
    return {
      health: res.ok ? "healthy" : "degraded",
      detail: res.ok ? `/health ${res.status} in ${ms}ms` : `/health ${res.status}`,
    };
  } catch {
    return { health: "failing", detail: `unreachable at ${url}` };
  }
}
