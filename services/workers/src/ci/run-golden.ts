/**
 * Standalone entry for PHASE G (golden snapshot determinism gate):
 *
 *   pnpm --filter @nexus/workers ci:golden
 *
 * Requires a reachable Postgres with committed migrations applied (the same
 * precondition as ci:harness, which also runs this phase inline).
 */

import { prisma } from "@nexus/db";
import { assertDbReachable, log, msg } from "./lib.js";
import { runGoldenSnapshot } from "./golden-snapshot.js";

async function main(): Promise<void> {
  await assertDbReachable();
  await runGoldenSnapshot();
}

main()
  .then(async () => {
    await prisma.$disconnect().catch(() => undefined);
    process.exit(0);
  })
  .catch(async (err: unknown) => {
    log("error", "PHASE G — golden snapshot FAILED", { error: msg(err) });
    await prisma.$disconnect().catch(() => undefined);
    process.exit(1);
  });
