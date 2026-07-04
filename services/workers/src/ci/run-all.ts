/**
 * CI Runtime Execution Harness — orchestrator.
 *
 *   pnpm --filter @nexus/workers ci:harness
 *
 * Assumes Postgres (and optionally Redis) are already up and committed migrations
 * are applied (the CI job / docker-compose.ci.yml handle that). The harness then
 * drives the full stack under real execution conditions:
 *
 *   PHASE 1  pipeline execution  — >=50 concurrent ticks, no duplicate writes
 *   PHASE 2  restart / crash     — SIGKILL the worker, restart, idempotency holds
 *   PHASE 4  replay determinism  — identical inputs -> identical outputs
 *   PHASE 6  market integration  — order lifecycle, position/account, reconciliation
 *   PHASE 7  durability          — append-only journal, restart rebuild, fail-closed
 *   PHASE 8  risk & capital       — pre-trade gate, kill switch persist + recover
 *   PHASE 5  pagination / cursor  — keyset == single-query == offset, no dup (web)
 *   PHASE 3  SSE consistency      — Last-Event-ID reconnect: no dup, no gap (web)
 *
 * DB-only phases run first; then the web server is booted (own process group) for
 * the HTTP phases and torn down at the end. Fail-closed: the first failing
 * assertion aborts the run with a non-zero exit code.
 */

import { prisma } from "@nexus/db";
import {
  assertDbReachable,
  getJson,
  HarnessError,
  log,
  msg,
  startWebServer,
  waitFor,
} from "./lib.js";
import { runPhase1 } from "./phase1-pipeline.js";
import { runPhase2 } from "./phase2-restart-crash.js";
import { runPhase3 } from "./phase3-sse.js";
import { runPhase4 } from "./phase4-replay.js";
import { runPhase5 } from "./phase5-pagination.js";
import { runPhase6 } from "./phase6-market.js";
import { runPhase7 } from "./phase7-durability.js";
import { runPhase8 } from "./phase8-risk.js";

const WEB_PORT = Number(process.env["HARNESS_WEB_PORT"] ?? "3000");
const BASE_URL = `http://127.0.0.1:${WEB_PORT}`;

async function main(): Promise<void> {
  log("info", "CI Runtime Execution Harness — start", { baseUrl: BASE_URL });
  await assertDbReachable();

  // ── DB-only phases (no web server needed) ───────────────────────────────────
  await runPhase1();
  await runPhase2();
  await runPhase4();
  await runPhase6();
  await runPhase7();
  await runPhase8();

  // ── HTTP phases (boot the web server, tear down afterwards) ─────────────────
  const web = startWebServer(WEB_PORT, {});
  try {
    await waitFor(
      "web server ready (GET /signals -> 200)",
      async () => {
        // Fail fast if the server died (e.g. port in use) instead of waiting out the timeout.
        if (web.hasExited()) {
          throw new HarnessError(
            `web server exited before becoming ready: ${web.lines().slice(-8).join(" | ")}`,
          );
        }
        try {
          // The endpoint the phases actually use; a 200 here means web + DB read both work.
          const r = await getJson<{ data: unknown[] }>(`${BASE_URL}/api/v1/signals?limit=1`);
          return r.status === 200 && Array.isArray(r.body.data);
        } catch {
          return false;
        }
      },
      { timeoutMs: 90_000, intervalMs: 1_000 },
    );
    await runPhase5(BASE_URL);
    await runPhase3(BASE_URL);
  } catch (err) {
    // Surface the last web-server output to make CI failures diagnosable.
    const tail = web.lines().slice(-20);
    if (tail.length > 0) log("error", "web server output (tail)", { tail });
    throw err;
  } finally {
    await web.stop();
  }

  await prisma.$disconnect().catch(() => undefined);
  log("info", "CI Runtime Execution Harness — ALL PHASES PASS");
}

main()
  .then(() => process.exit(0))
  .catch(async (err: unknown) => {
    log("error", "CI Runtime Execution Harness — FAILED", { error: msg(err) });
    if (err instanceof Error && err.stack) console.error(err.stack);
    await prisma.$disconnect().catch(() => undefined);
    process.exit(1);
  });
