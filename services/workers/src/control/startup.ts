/**
 * Phase 9.7 — Startup Validation (Section I), worker side. Runs the real boot-time
 * checks (DB, Redis, Quant, control schema present, freshness probes wired). Any failure
 * means the runtime must go BOOTING → FAILED ("do not start partially"). The pure
 * aggregation lives in `@nexus/control` (summarizeStartup); this gathers the evidence.
 */

import { prisma } from "@nexus/db";
import { summarizeStartup, type StartupCheck, type StartupValidation } from "@nexus/control";
import { probeDatabase, probeQuant, probeRedis } from "./probes.js";

export interface StartupDeps {
  redisUrl: string | undefined;
  quantUrl: string | undefined;
}

export async function validateStartup(deps: StartupDeps): Promise<StartupValidation> {
  const checks: StartupCheck[] = [];

  const db = await probeDatabase();
  checks.push({ name: "database", passed: db.health === "healthy" || db.health === "degraded", detail: db.detail });

  const redis = await probeRedis(deps.redisUrl);
  checks.push({ name: "redis", passed: redis.health === "healthy", detail: redis.detail });

  const quant = await probeQuant(deps.quantUrl);
  checks.push({ name: "quant", passed: quant.health === "healthy", detail: quant.detail });

  // Schema: the five control tables must exist (the migration applied). Touch each.
  try {
    await Promise.all([
      prisma.controlKillSwitch.count(),
      prisma.runtimeStateTransition.count(),
      prisma.protectionEvent.count(),
      prisma.incident.count(),
      prisma.controlAuditLog.count(),
    ]);
    checks.push({ name: "schema", passed: true, detail: "control tables present" });
  } catch (err) {
    checks.push({
      name: "schema",
      passed: false,
      detail: `control tables missing — run migrations: ${err instanceof Error ? err.message : String(err)}`,
    });
  }

  // Freshness probes wired: the feature/signal tables are readable (the source of the
  // freshness inputs). A read failure here means the freshness inputs cannot be gathered.
  try {
    await Promise.all([prisma.featureSnapshot.count(), prisma.engineSignal.count()]);
    checks.push({ name: "freshness_probes", passed: true, detail: "feature/signal tables readable" });
  } catch (err) {
    checks.push({
      name: "freshness_probes",
      passed: false,
      detail: `freshness source unreadable: ${err instanceof Error ? err.message : String(err)}`,
    });
  }

  return summarizeStartup(checks);
}
