/**
 * Phase 6 SEAL — DB-only runtime verification.
 *
 *   pnpm --filter @nexus/workers ci:seal:phase6
 *
 * Runs the DB-backed runtime phases that bear on the Phase 6 seal, against a live
 * Postgres (docker/docker-compose.ci.yml). It is the run-all.ts DB-only prefix
 * (regression) plus PHASE 6 — it deliberately omits the web HTTP phases (5/3),
 * which are unrelated to the market layer and require a Next.js build:
 *
 *   PHASE 1  pipeline execution  — concurrent ticks, no duplicate writes (regression)
 *   PHASE 2  restart / crash     — SIGKILL + restart, idempotency holds  (regression)
 *   PHASE 4  replay determinism  — identical inputs -> identical outputs (regression)
 *   PHASE 6  market integration  — order lifecycle, position/account, reconciliation
 *
 * Fail-closed: the first failing assertion aborts with a non-zero exit code.
 */

import { prisma } from "@nexus/db";
import { assertDbReachable, log, msg } from "./lib.js";
import { runPhase1 } from "./phase1-pipeline.js";
import { runPhase2 } from "./phase2-restart-crash.js";
import { runPhase4 } from "./phase4-replay.js";
import { runPhase6 } from "./phase6-market.js";

async function main(): Promise<void> {
  log("info", "Phase 6 SEAL — DB-only runtime verification — start");
  await assertDbReachable();

  await runPhase1();
  await runPhase2();
  await runPhase4();
  await runPhase6();

  await prisma.$disconnect().catch(() => undefined);
  log("info", "Phase 6 SEAL — ALL DB-ONLY PHASES PASS");
}

main()
  .then(() => process.exit(0))
  .catch(async (err: unknown) => {
    log("error", "Phase 6 SEAL — FAILED", { error: msg(err) });
    if (err instanceof Error && err.stack) console.error(err.stack);
    await prisma.$disconnect().catch(() => undefined);
    process.exit(1);
  });
