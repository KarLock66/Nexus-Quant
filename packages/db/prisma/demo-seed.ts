/**
 * Demo seed — `pnpm db:seed:demo`.
 *
 * Lays down the base reference data (via seedBase) PLUS the deterministic demo
 * signal upstream chain (Strategy/StrategyVersion + DQ reports + FeatureSnapshots)
 * so the read API and Signal Center have data even before the worker runs. The
 * chain helper is the same one the workers pipeline calls every tick, so the two
 * never drift. Fully idempotent — re-running creates no duplicates.
 *
 * (Previously this script pointed at a non-existent file, so `db:seed:demo`
 * errored before inserting anything. This file restores it.)
 */

import { PrismaClient } from "@prisma/client";
import { seedBase } from "./seed.js";
import { ensureSignalDemoChain } from "../src/demo-signal-chain.js";

function log(level: "info" | "warn" | "error", msg: string, extra?: Record<string, unknown>): void {
  console.log(JSON.stringify({ ts: new Date().toISOString(), service: "db", component: "demo-seed", level, msg, ...extra }));
}

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  try {
    await seedBase(prisma);
    const chain = await ensureSignalDemoChain(prisma, log);
    console.log(
      `Demo seed complete: base config + demo signal chain ` +
        `(strategyVersion=${chain.strategyVersion.id}, symbols=${chain.symbols.join(",")}).`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e: unknown) => {
  console.error(e);
  process.exitCode = 1;
});
