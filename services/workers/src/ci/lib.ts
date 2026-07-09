/**
 * CI Runtime Execution Harness — shared utilities.
 *
 * Deterministic helpers used by every phase: structured logging, fail-closed
 * assertions, condition-based waiting (NO fixed sleeps — we poll an observable
 * state with a bounded deadline), a bounded-concurrency promise pool, EngineSignal
 * DB helpers keyed on the deterministic CI fixture lineage, a manual SSE client
 * (full control over Last-Event-ID + frame ids), and child-process spawners for
 * the worker (single node PID so SIGKILL hits it directly) and the web server.
 *
 * The CI fixture lineage (src/ci/fixtures.ts) produces EXACTLY two
 * (featureSnapshotId, strategyVersionId) pairs — BTC-PERP and ETH-PERP — so the
 * EngineSignal row count for the fixture lineage is an invariant (exactly 2). Any
 * deviation is a duplicate write and a hard failure. That invariant, not timing,
 * is what every assertion rests on.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { prisma } from "@nexus/db";
import { assertDestructiveDbAllowed } from "./destructive-guard.js";

// ── Paths ────────────────────────────────────────────────────────────────────
const HERE = dirname(fileURLToPath(import.meta.url)); // .../services/workers/{src|dist}/ci
export const WORKERS_DIR = resolve(HERE, "..", ".."); // services/workers
export const REPO_ROOT = resolve(WORKERS_DIR, "..", ".."); // repo root

// ── Logging ──────────────────────────────────────────────────────────────────
export type Level = "info" | "warn" | "error";
const RANK: Record<Level, number> = { info: 0, warn: 1, error: 2 };

export function log(level: Level, msg: string, extra?: Record<string, unknown>): void {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    service: "ci-harness",
    level,
    msg,
    ...extra,
  });
  if (level === "error") console.error(line);
  else console.log(line);
}

/** A logger that drops everything below `min` — used to mute per-tick spam. */
export function makeLog(min: Level): (l: Level, m: string, e?: object) => void {
  return (l, m, e) => {
    if (RANK[l] >= RANK[min]) log(l, m, e as Record<string, unknown>);
  };
}

// ── Failure model (fail-closed) ──────────────────────────────────────────────
export class HarnessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HarnessError";
  }
}

export function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new HarnessError(message);
}

export function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ── Timing primitives ────────────────────────────────────────────────────────
export function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

/**
 * Poll `predicate` until it returns true, or throw once `timeoutMs` elapses.
 * Condition-based (deterministic): we wait for observable state, never a fixed
 * duration. The timeout is a safety net, not the thing being measured.
 */
export async function waitFor(
  label: string,
  predicate: () => Promise<boolean> | boolean,
  opts: { timeoutMs: number; intervalMs?: number },
): Promise<void> {
  const interval = opts.intervalMs ?? 250;
  const deadline = Date.now() + opts.timeoutMs;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (await predicate()) return;
    if (Date.now() >= deadline) {
      throw new HarnessError(`timed out after ${opts.timeoutMs}ms waiting for: ${label}`);
    }
    await sleep(interval);
  }
}

/** Run `worker` over `items` with at most `width` in flight. Throws on first error. */
export async function promisePool<T, R>(
  items: T[],
  width: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  async function runner(): Promise<void> {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await worker(items[i]!, i);
    }
  }
  const lanes = Array.from({ length: Math.min(width, items.length) }, () => runner());
  await Promise.all(lanes);
  return results;
}

export const range = (n: number): number[] => Array.from({ length: n }, (_, i) => i);

export function idsEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// ── EngineSignal / fixture-lineage DB helpers ────────────────────────────────
/** Stable FeatureSnapshot ids of the CI fixture lineage (exactly two). */
export const FIXTURE_SNAPSHOT_IDS = ["ci-fs-btc-perp-h1", "ci-fs-eth-perp-h1"] as const;

export interface FixtureRow {
  id: string;
  featureSnapshotId: string;
  strategyVersionId: string;
  decision: string;
  side: string;
  confidence: string;
  dqReportId: string;
  datasetHash: string;
  featureHash: string;
  createdAt: Date;
}

const FIXTURE_SELECT = {
  id: true,
  featureSnapshotId: true,
  strategyVersionId: true,
  decision: true,
  side: true,
  confidence: true,
  dqReportId: true,
  datasetHash: true,
  featureHash: true,
  createdAt: true,
} as const;

export async function fixtureRows(): Promise<FixtureRow[]> {
  const rows = await prisma.engineSignal.findMany({
    where: { featureSnapshotId: { in: [...FIXTURE_SNAPSHOT_IDS] } },
    orderBy: { featureSnapshotId: "asc" },
    select: FIXTURE_SELECT,
  });
  return rows.map((r) => ({ ...r, confidence: r.confidence.toString() }));
}

export async function countFixtureRows(): Promise<number> {
  return prisma.engineSignal.count({
    where: { featureSnapshotId: { in: [...FIXTURE_SNAPSHOT_IDS] } },
  });
}

export async function resetFixtureEngineSignals(): Promise<void> {
  assertDestructiveDbAllowed();
  await prisma.engineSignal.deleteMany({
    where: { featureSnapshotId: { in: [...FIXTURE_SNAPSHOT_IDS] } },
  });
}

export async function assertDbReachable(): Promise<void> {
  try {
    await prisma.$queryRaw`SELECT 1`;
  } catch (err) {
    throw new HarnessError(
      `database unreachable (check DATABASE_URL / that Postgres is up): ${msg(err)}`,
    );
  }
}

// ── HTTP JSON ────────────────────────────────────────────────────────────────
export async function getJson<T>(url: string): Promise<{ status: number; body: T }> {
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  const body = (await res.json()) as T;
  return { status: res.status, body };
}

// ── SSE client (manual parser; full control over id / Last-Event-ID) ──────────
export interface SseEvent {
  id: string | null;
  event: string;
  data: string;
}

export interface SseCollectResult {
  events: SseEvent[];
  lastEventId: string | null;
}

/**
 * Connect to an SSE endpoint and collect frames until `stopWhen(events)` is true
 * or `maxMs` elapses, then close. Parses the wire format directly so heartbeat
 * comments (`: ping`) are skipped and each frame's `id:` is captured verbatim.
 */
export async function collectSse(
  url: string,
  opts: {
    stopWhen: (events: SseEvent[]) => boolean;
    maxMs: number;
    lastEventId?: string;
  },
): Promise<SseCollectResult> {
  const ac = new AbortController();
  const headers: Record<string, string> = { Accept: "text/event-stream" };
  if (opts.lastEventId !== undefined) headers["Last-Event-ID"] = opts.lastEventId;

  const events: SseEvent[] = [];
  let lastEventId: string | null = opts.lastEventId ?? null;
  const timer = setTimeout(() => ac.abort(), opts.maxMs);

  let curId: string | null = null;
  let curEvent = "message";
  let curData: string[] = [];
  const dispatch = (): void => {
    if (curId === null && curEvent === "message" && curData.length === 0) return; // blank frame
    events.push({ id: curId, event: curEvent, data: curData.join("\n") });
    if (curId !== null) lastEventId = curId;
    curId = null;
    curEvent = "message";
    curData = [];
  };

  try {
    const res = await fetch(url, { headers, signal: ac.signal });
    if (!res.ok || res.body === null) {
      throw new HarnessError(`SSE connect failed: HTTP ${res.status}`);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    // eslint-disable-next-line no-constant-condition
    while (true) {
      if (opts.stopWhen(events)) break;
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        let line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (line.endsWith("\r")) line = line.slice(0, -1);
        if (line === "") {
          dispatch();
          continue;
        }
        if (line.startsWith(":")) continue; // comment / heartbeat
        const colon = line.indexOf(":");
        const field = colon < 0 ? line : line.slice(0, colon);
        let val = colon < 0 ? "" : line.slice(colon + 1);
        if (val.startsWith(" ")) val = val.slice(1);
        if (field === "id") curId = val;
        else if (field === "event") curEvent = val;
        else if (field === "data") curData.push(val);
      }
      if (opts.stopWhen(events)) break;
    }
    try {
      await reader.cancel();
    } catch {
      // already closing
    }
  } catch (err) {
    if (!ac.signal.aborted) throw err; // a real failure, not our own abort
  } finally {
    clearTimeout(timer);
    ac.abort();
  }

  return { events, lastEventId };
}

/** SSE event id the stream stamps on each signal: `<createdAt epoch ms>:<rowId>`. */
export function eventIdOf(s: { id: string; createdAt: string }): string {
  return `${new Date(s.createdAt).getTime()}:${s.id}`;
}

// ── Process spawners ─────────────────────────────────────────────────────────
export interface WorkerHandle {
  pid: number | undefined;
  tickCompleteCount: () => number;
  lines: () => string[];
  kill: (signal: NodeJS.Signals) => Promise<void>;
  waitExit: () => Promise<number | null>;
}

/**
 * Spawn the real worker runtime as a SINGLE node process (so SIGKILL terminates
 * the worker itself, not a wrapper). Prefers the built dist entry; falls back to
 * the tsx loader for un-built local runs.
 */
export function spawnWorker(extraEnv: Record<string, string>): WorkerHandle {
  const distEntry = resolve(WORKERS_DIR, "dist", "index.js");
  const useDist = existsSync(distEntry);
  const args = useDist
    ? [distEntry]
    : ["--import", "tsx", resolve(WORKERS_DIR, "src", "index.ts")];
  const child = spawn(process.execPath, args, {
    cwd: WORKERS_DIR,
    // The worker resolves ONLY persisted lineage (no bootstrap flag exists) —
    // callers seed the CI fixture lineage BEFORE spawning (see fixtures.ts).
    env: { ...process.env, ...extraEnv },
    stdio: ["ignore", "pipe", "pipe"],
  });

  const lines: string[] = [];
  let tickComplete = 0;
  const onData = (buf: Buffer): void => {
    for (const ln of buf.toString("utf8").split("\n")) {
      if (ln.trim() === "") continue;
      lines.push(ln);
      if (ln.includes('"pipeline tick complete"')) tickComplete += 1;
    }
  };
  child.stdout?.on("data", onData);
  child.stderr?.on("data", onData);

  let exitCode: number | null = null;
  const exited = new Promise<number | null>((res) => {
    child.once("exit", (code) => {
      exitCode = code;
      res(code);
    });
  });

  log("info", "worker spawned", { pid: child.pid, mode: useDist ? "dist" : "tsx" });
  return {
    pid: child.pid,
    tickCompleteCount: () => tickComplete,
    lines: () => [...lines],
    kill: async (signal) => {
      try {
        child.kill(signal);
      } catch {
        // already gone
      }
      await Promise.race([exited, sleep(8000)]);
    },
    waitExit: async () => Promise.race([exited, sleep(8000).then(() => exitCode)]),
  };
}

export interface ServerHandle {
  stop: () => Promise<void>;
  lines: () => string[];
  /** True once the server process has exited (so callers can fail fast). */
  hasExited: () => boolean;
}

/**
 * Start the Next.js web server (`next start`) on `port`, in its own process group
 * so the whole group can be torn down deterministically afterwards.
 */
export function startWebServer(port: number, extraEnv: Record<string, string>): ServerHandle {
  const child = spawn("pnpm", ["--filter", "@nexus/web", "start"], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      ...extraEnv,
      PORT: String(port),
      NEXT_TELEMETRY_DISABLED: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
    shell: process.platform === "win32",
  });

  const lines: string[] = [];
  const onData = (buf: Buffer): void => {
    for (const ln of buf.toString("utf8").split("\n")) {
      if (ln.trim() !== "") lines.push(ln);
    }
  };
  child.stdout?.on("data", onData);
  child.stderr?.on("data", onData);

  let exitedFlag = false;
  const exited = new Promise<void>((res) =>
    child.once("exit", () => {
      exitedFlag = true;
      res();
    }),
  );
  log("info", "web server spawned", { pid: child.pid, port });

  return {
    lines: () => [...lines],
    hasExited: () => exitedFlag,
    stop: async () => {
      const pid = child.pid;
      if (pid === undefined) return;
      try {
        if (process.platform === "win32") {
          spawn("taskkill", ["/pid", String(pid), "/T", "/F"]);
        } else {
          process.kill(-pid, "SIGKILL"); // kill the whole detached group
        }
      } catch {
        try {
          child.kill("SIGKILL");
        } catch {
          // already gone
        }
      }
      await Promise.race([exited, sleep(8000)]);
    },
  };
}
