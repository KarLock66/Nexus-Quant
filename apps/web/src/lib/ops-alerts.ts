import { Prisma, prisma } from "@nexus/db";
import { getSystemHealth } from "./system-health";
import { getDataFlowMonitor } from "./ops";
import type {
  AlertSeverity,
  AlertsSummary,
  DataFlowMonitor,
  OpsAlertView,
  StreamKey,
  SystemHealth,
} from "./ops-types";

/**
 * Phase 9.6 — Alerting Engine (Section E).
 *
 * Rule evaluation is a PURE function of a health + data-flow snapshot, so it is
 * fully unit-testable. Persistence (the OpsAlert table) is a best-effort SIDE
 * EFFECT layered on top: a firing rule is deduplicated by `ruleId` while ACTIVE
 * (re-firing bumps `lastSeen`, never a new row); when a rule stops firing its
 * active row is RESOLVED. If the table is unavailable (cold DB / migration not
 * yet applied) the engine DEGRADES GRACEFULLY — alerts are still computed live
 * and returned with `persisted:false`, and `persistenceOk:false` is surfaced.
 */

export interface AlertSnapshot {
  health: SystemHealth;
  dataFlow: DataFlowMonitor;
}

export interface FiringRule {
  ruleId: string;
  severity: AlertSeverity;
  message: string;
  detail: string | null;
}

/** Section E staleness thresholds (seconds), verbatim from the spec. */
const STALE_RULES: { stream: StreamKey; ruleId: string; limitSec: number; label: string }[] = [
  { stream: "marketTick", ruleId: "ticks.stale", limitSec: 60, label: "market ticks" },
  { stream: "featureSnapshot", ruleId: "features.stale", limitSec: 60, label: "feature snapshots" },
  { stream: "engineSignal", ruleId: "signals.stale", limitSec: 120, label: "engine signals" },
  { stream: "execution", ruleId: "execution.stale", limitSec: 300, label: "executions" },
];

/**
 * Evaluate every monitoring rule against a snapshot. Pure — no I/O.
 * Unreachable infra (db/redis/quant) → CRITICAL; data-flow staleness → WARNING.
 */
export function evaluateAlertRules(snapshot: AlertSnapshot): FiringRule[] {
  const firing: FiringRule[] = [];
  const comp = (key: string) => snapshot.health.components.find((c) => c.key === key);
  const stream = (key: StreamKey) => snapshot.dataFlow.streams.find((s) => s.key === key);

  // ── Infrastructure reachability (CRITICAL) ──
  const db = comp("database");
  if (db && db.status === "failing") {
    firing.push({ ruleId: "db.unreachable", severity: "CRITICAL", message: "Database unreachable", detail: db.detail });
  }
  const redis = comp("redis");
  // Only alert when redis is configured AND failing — an unconfigured (in-process
  // bus) redis is "unknown" and must not raise a false critical.
  if (redis && redis.status === "failing") {
    firing.push({ ruleId: "redis.unreachable", severity: "CRITICAL", message: "Redis unreachable", detail: redis.detail });
  }
  const quant = comp("quant");
  if (quant && quant.status === "failing") {
    firing.push({ ruleId: "quant.unreachable", severity: "CRITICAL", message: "Quant service unreachable", detail: quant.detail });
  }

  // ── Data-flow staleness (WARNING) ──
  for (const rule of STALE_RULES) {
    const s = stream(rule.stream);
    if (!s) continue;
    // An unobservable stream (execution opt-in, default-off) is `unknown`: do not
    // raise a false alarm for a stream this deployment isn't producing.
    if (s.freshness === "unknown") continue;
    const lag = s.lagSeconds;
    if (lag === null) {
      firing.push({
        ruleId: rule.ruleId,
        severity: "WARNING",
        message: `No ${rule.label} observed`,
        detail: `no ${rule.label} have been produced`,
      });
    } else if (lag > rule.limitSec) {
      firing.push({
        ruleId: rule.ruleId,
        severity: "WARNING",
        message: `No ${rule.label} in ${lag}s (limit ${rule.limitSec}s)`,
        detail: `last ${rule.label} ${lag}s ago`,
      });
    }
  }

  return firing;
}

function toView(row: {
  id: string;
  ruleId: string;
  severity: AlertSeverity;
  message: string;
  status: string;
  firstSeen: Date;
  lastSeen: Date;
  detail: string | null;
}): OpsAlertView {
  return {
    id: row.id,
    ruleId: row.ruleId,
    severity: row.severity,
    message: row.message,
    status: row.status === "RESOLVED" ? "RESOLVED" : "ACTIVE",
    firstSeen: row.firstSeen.toISOString(),
    lastSeen: row.lastSeen.toISOString(),
    detail: row.detail,
    persisted: true,
  };
}

const SEVERITY_RANK: Record<AlertSeverity, number> = {
  EMERGENCY: 0,
  CRITICAL: 1,
  WARNING: 2,
  INFO: 3,
};

/**
 * Reconcile firing rules against persisted state, then return the full alert
 * picture. Always computes alerts live first; persistence only enriches them.
 */
export async function getAlerts(): Promise<AlertsSummary> {
  const [health, dataFlow] = await Promise.all([getSystemHealth(), getDataFlowMonitor()]);
  const firing = evaluateAlertRules({ health, dataFlow });
  const firingIds = new Set(firing.map((f) => f.ruleId));
  const now = new Date();

  try {
    // 1. Upsert each firing rule into an ACTIVE row (dedup by ruleId).
    //    Concurrency-safe: update-first (no read-then-write window), and creation
    //    races between overlapping GETs are closed by the partial unique index
    //    (timescale.sql: at most one ACTIVE row per ruleId) — the losing create
    //    surfaces as P2002 and downgrades to the update path.
    for (const f of firing) {
      const bump = { lastSeen: now, severity: f.severity, message: f.message, detail: f.detail };
      const updated = await prisma.opsAlert.updateMany({
        where: { ruleId: f.ruleId, status: "ACTIVE" },
        data: bump,
      });
      if (updated.count === 0) {
        try {
          await prisma.opsAlert.create({
            data: {
              ruleId: f.ruleId,
              severity: f.severity,
              message: f.message,
              detail: f.detail,
              status: "ACTIVE",
              firstSeen: now,
              lastSeen: now,
            },
          });
        } catch (err) {
          const lostCreationRace =
            err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";
          if (!lostCreationRace) throw err;
          await prisma.opsAlert.updateMany({
            where: { ruleId: f.ruleId, status: "ACTIVE" },
            data: bump,
          });
        }
      }
    }

    // 2. Resolve ACTIVE rows that are no longer firing.
    const actives = await prisma.opsAlert.findMany({
      where: { status: "ACTIVE" },
      select: { id: true, ruleId: true },
    });
    const toResolve = actives.filter((a) => !firingIds.has(a.ruleId)).map((a) => a.id);
    if (toResolve.length > 0) {
      await prisma.opsAlert.updateMany({
        where: { id: { in: toResolve } },
        data: { status: "RESOLVED", resolvedAt: now },
      });
    }

    // 3. Read back: all ACTIVE + recently RESOLVED (history), newest first.
    const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const rows = await prisma.opsAlert.findMany({
      where: { OR: [{ status: "ACTIVE" }, { status: "RESOLVED", resolvedAt: { gte: dayAgo } }] },
      orderBy: [{ status: "asc" }, { lastSeen: "desc" }],
      take: 100,
      select: {
        id: true, ruleId: true, severity: true, message: true,
        status: true, firstSeen: true, lastSeen: true, detail: true,
      },
    });

    const alerts = rows
      .map((r) => toView({ ...r, severity: r.severity as AlertSeverity }))
      .sort((a, b) => {
        // ACTIVE before RESOLVED, then by severity, then most-recent.
        if (a.status !== b.status) return a.status === "ACTIVE" ? -1 : 1;
        const sev = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
        return sev !== 0 ? sev : b.lastSeen.localeCompare(a.lastSeen);
      });

    const active = alerts.filter((a) => a.status === "ACTIVE");
    return {
      active: active.length,
      critical: active.filter((a) => a.severity === "CRITICAL" || a.severity === "EMERGENCY").length,
      alerts,
      persistenceOk: true,
    };
  } catch {
    // Fail-soft: persistence unavailable — return live-computed alerts only.
    const nowIso = now.toISOString();
    const alerts: OpsAlertView[] = firing
      .map((f) => ({
        id: f.ruleId,
        ruleId: f.ruleId,
        severity: f.severity,
        message: f.message,
        status: "ACTIVE" as const,
        firstSeen: nowIso,
        lastSeen: nowIso,
        detail: f.detail,
        persisted: false,
      }))
      .sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);
    return {
      active: alerts.length,
      critical: alerts.filter((a) => a.severity === "CRITICAL" || a.severity === "EMERGENCY").length,
      alerts,
      persistenceOk: false,
    };
  }
}
