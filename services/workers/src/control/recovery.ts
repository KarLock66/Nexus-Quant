/**
 * Phase 9.7 — Recovery verification (Section E), worker side. "Never auto-resume
 * blindly": when a previously-protected component returns healthy the evaluator calls
 * {@link verifyRecovery}, which runs CONCRETE probes (not just a status re-read) per the
 * RECOVERY_PLAN. Only when every step passes does the component count as recovered; the
 * pure aggregation (`recoveryOutcome`) then drives PROTECTED→RECOVERING→HEALTHY.
 */

import { prisma } from "@nexus/db";
import {
  FRESHNESS_BANDS,
  type ControlComponent,
  type RecoveryReport,
  type RecoveryStep,
} from "@nexus/control";
import { probeDatabase, probeQuant, probeRedis } from "./probes.js";

export interface VerifyDeps {
  redisUrl: string | undefined;
  quantUrl: string | undefined;
  getRiskActive: () => boolean;
  lastExecutionAt: Date | null;
}

function freshEnough(ts: Date | null, staleSeconds: number): boolean {
  return ts !== null && (Date.now() - ts.getTime()) / 1000 <= staleSeconds;
}

export async function verifyRecovery(
  component: ControlComponent,
  deps: VerifyDeps,
): Promise<RecoveryReport> {
  const steps: RecoveryStep[] = [];

  switch (component) {
    case "database": {
      const db = await probeDatabase();
      steps.push({ name: "SELECT 1", passed: db.health !== "failing" && db.health !== "unknown", detail: db.detail });
      // Real write + read-back against the immutable audit table (a recovery probe row).
      try {
        const row = await prisma.controlAuditLog.create({
          data: { actor: "system:control", action: "RECOVERY_PROBE", result: "OK", metadata: { component } },
          select: { id: true },
        });
        const back = await prisma.controlAuditLog.findUnique({ where: { id: row.id }, select: { id: true } });
        steps.push({ name: "write", passed: true, detail: `wrote probe ${row.id}` });
        steps.push({ name: "read-back", passed: back?.id === row.id, detail: back ? "read back ok" : "read-back failed" });
      } catch (err) {
        steps.push({ name: "write/read", passed: false, detail: err instanceof Error ? err.message : String(err) });
      }
      break;
    }
    case "redis": {
      const r = await probeRedis(deps.redisUrl);
      steps.push({ name: "PING", passed: r.health === "healthy", detail: r.detail });
      break;
    }
    case "quant": {
      const a = await probeQuant(deps.quantUrl);
      steps.push({ name: "GET /health (1)", passed: a.health === "healthy", detail: a.detail });
      const b = await probeQuant(deps.quantUrl);
      steps.push({ name: "GET /health (2)", passed: b.health === "healthy", detail: b.detail });
      break;
    }
    case "features": {
      const last = await prisma.featureSnapshot
        .findFirst({ orderBy: { createdAt: "desc" }, select: { createdAt: true } })
        .catch(() => null);
      const ok = freshEnough(last?.createdAt ?? null, FRESHNESS_BANDS.features.staleSeconds);
      steps.push({ name: "fresh FeatureSnapshot", passed: ok, detail: ok ? "within bound" : "still stale/empty" });
      break;
    }
    case "signals": {
      const last = await prisma.engineSignal
        .findFirst({ orderBy: { createdAt: "desc" }, select: { createdAt: true } })
        .catch(() => null);
      const ok = freshEnough(last?.createdAt ?? null, FRESHNESS_BANDS.signals.staleSeconds);
      steps.push({ name: "fresh EngineSignal", passed: ok, detail: ok ? "within bound" : "still stale/empty" });
      break;
    }
    case "execution": {
      const ok = freshEnough(deps.lastExecutionAt, FRESHNESS_BANDS.execution.staleSeconds);
      steps.push({ name: "recent execution", passed: ok, detail: ok ? "within bound" : "no recent execution" });
      break;
    }
    case "risk": {
      const ok = deps.getRiskActive();
      steps.push({ name: "risk armed", passed: ok, detail: ok ? "armed" : "disabled/halted" });
      break;
    }
  }

  return { component, verified: steps.length > 0 && steps.every((s) => s.passed), steps };
}
