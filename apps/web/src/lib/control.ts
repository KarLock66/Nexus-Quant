import { prisma } from "@nexus/db";
import {
  allRunbooks,
  applicableRunbooks,
  evaluateTradingPermission,
  FRESHNESS_BANDS,
  RECOVERY_PLAN,
  type ComponentHealth,
  type ControlComponent,
  type ControlInputs,
  type ProtectionRuleId,
  type RuntimeState,
} from "@nexus/control";
import { getSystemHealth } from "./system-health";
import type {
  AuditTrailView,
  ControlCommandResult,
  IncidentTimelineView,
  IncidentWindow,
  KillSwitchView,
  ProtectionView,
  RecoveryView,
  RunbooksView,
  RuntimeStateView,
  TradingPermissionView,
} from "./control-types";

/**
 * Server-only data layer for the Phase 9.7 Control Plane. READS the worker-persisted
 * control state (transitions, protection events, incidents, audit, kill switch) — the
 * worker is the canonical writer — and recomputes a LIVE trading-permission view from
 * the shared @nexus/control evaluators against live infra probes, so the /control page
 * reflects real state even between worker ticks. Kill/resume are the two operator
 * WRITES the web performs (Section C); they also append to the immutable audit trail.
 */

const KILL_SWITCH_ID = "singleton";
const SECOND = 1_000;

const WINDOW_MS: Record<IncidentWindow, number> = {
  "1h": 60 * 60 * SECOND,
  "24h": 24 * 60 * 60 * SECOND,
  "7d": 7 * 24 * 60 * 60 * SECOND,
  "30d": 30 * 24 * 60 * 60 * SECOND,
};

function asState(s: string | null | undefined): RuntimeState {
  return (s as RuntimeState | null | undefined) ?? "BOOTING";
}

// ─────────────────────────── Kill switch ───────────────────────────

export async function getKillSwitch(): Promise<KillSwitchView> {
  const row = await prisma.controlKillSwitch.findUnique({ where: { id: KILL_SWITCH_ID } });
  if (!row) return { engaged: false, actor: null, reason: null, engagedAt: null };
  return {
    engaged: row.engaged,
    actor: row.actor,
    reason: row.reason,
    engagedAt: row.engagedAt ? row.engagedAt.toISOString() : null,
  };
}

export async function engageKill(actor: string, reason: string): Promise<ControlCommandResult> {
  const now = new Date();
  await prisma.controlKillSwitch.upsert({
    where: { id: KILL_SWITCH_ID },
    create: { id: KILL_SWITCH_ID, engaged: true, actor, reason, engagedAt: now },
    update: { engaged: true, actor, reason, engagedAt: now, resumedAt: null, resumedBy: null },
  });
  await prisma.controlAuditLog.create({
    data: { actor, action: "KILL", reason, result: "ACCEPTED", metadata: { source: "web" } },
  });
  return { ok: true, killSwitch: await getKillSwitch(), message: "kill switch engaged — trading stopped" };
}

export async function resumeKill(actor: string, reason: string): Promise<ControlCommandResult> {
  const now = new Date();
  await prisma.controlKillSwitch.upsert({
    where: { id: KILL_SWITCH_ID },
    create: { id: KILL_SWITCH_ID, engaged: false, resumedBy: actor, reason, resumedAt: now },
    update: { engaged: false, resumedBy: actor, reason, resumedAt: now },
  });
  await prisma.controlAuditLog.create({
    data: { actor, action: "RESUME", reason, result: "ACCEPTED", metadata: { source: "web" } },
  });
  return { ok: true, killSwitch: await getKillSwitch(), message: "kill switch disengaged — runtime will re-evaluate" };
}

// ─────────────────────────── Runtime state (A) ───────────────────────────

export async function getRuntimeStateView(): Promise<RuntimeStateView> {
  const recent = await prisma.runtimeStateTransition.findMany({
    orderBy: { enteredAt: "desc" },
    take: 20,
  });
  const latest = recent[0];
  return {
    current: asState(latest?.state),
    previousState: (latest?.previousState as RuntimeState | null) ?? null,
    reason: latest?.reason ?? "no transitions recorded yet",
    affectedComponents: ((latest?.affectedComponents as ControlComponent[] | null) ?? []),
    enteredAt: latest?.enteredAt ? latest.enteredAt.toISOString() : null,
    durationSeconds: latest ? Math.max(0, Math.round((Date.now() - latest.enteredAt.getTime()) / 1000)) : null,
    recent: recent.map((r) => ({
      state: r.state as RuntimeState,
      previousState: (r.previousState as RuntimeState | null) ?? null,
      reason: r.reason,
      affectedComponents: (r.affectedComponents as ControlComponent[] | null) ?? [],
      enteredAt: r.enteredAt.toISOString(),
    })),
  };
}

// ─────────────────────────── Trading permission (B) ───────────────────────────

/** Active protection ruleIds the worker has persisted (authoritative source of risk/etc). */
async function activeRuleIds(): Promise<ProtectionRuleId[]> {
  const rows = await prisma.protectionEvent.findMany({
    where: { status: "ACTIVE" },
    select: { ruleId: true },
  });
  return rows.map((r) => r.ruleId as ProtectionRuleId);
}

async function buildLiveInputs(): Promise<{ inputs: ControlInputs; state: RuntimeState }> {
  const now = Date.now();
  const [health, featLast, sigLast, killSwitch, latest, ruleIds] = await Promise.all([
    getSystemHealth(),
    prisma.featureSnapshot.findFirst({ orderBy: { createdAt: "desc" }, select: { createdAt: true } }),
    prisma.engineSignal.findFirst({ orderBy: { createdAt: "desc" }, select: { createdAt: true } }),
    getKillSwitch(),
    prisma.runtimeStateTransition.findFirst({ orderBy: { enteredAt: "desc" }, select: { state: true } }),
    activeRuleIds(),
  ]);

  const comp = (key: string): ComponentHealth =>
    (health.components.find((c) => c.key === key)?.status as ComponentHealth | undefined) ?? "unknown";

  const lag = (ts: Date | null, band: { warningSeconds: number; staleSeconds: number }) => ({
    lagSeconds: ts === null ? null : Math.max(0, Math.round((now - ts.getTime()) / 1000)),
    warningSeconds: band.warningSeconds,
    staleSeconds: band.staleSeconds,
  });

  const inputs: ControlInputs = {
    now,
    database: comp("database"),
    redis: comp("redis"),
    quant: comp("quant"),
    features: lag(featLast?.createdAt ?? null, FRESHNESS_BANDS.features),
    signals: lag(sigLast?.createdAt ?? null, FRESHNESS_BANDS.signals),
    // Execution is event-sourced (not DB-observable from the web tier) → unknown/idle.
    execution: { lagSeconds: null, warningSeconds: FRESHNESS_BANDS.execution.warningSeconds, staleSeconds: FRESHNESS_BANDS.execution.staleSeconds },
    // Risk is "active" unless the worker has persisted an ACTIVE risk.disabled protection.
    riskEngineActive: !ruleIds.includes("risk.disabled"),
    killSwitch,
    startupValidated: true,
  };
  return { inputs, state: asState(latest?.state) };
}

export async function getTradingPermissionView(): Promise<TradingPermissionView> {
  const { inputs, state } = await buildLiveInputs();
  const permission = evaluateTradingPermission(inputs, state);
  return { ...permission, state };
}

// ─────────────────────────── Protection (D) ───────────────────────────

export async function getProtectionView(): Promise<ProtectionView> {
  const [rows, killSwitch, latest] = await Promise.all([
    prisma.protectionEvent.findMany({ where: { status: "ACTIVE" }, orderBy: { lastSeen: "desc" } }),
    getKillSwitch(),
    prisma.runtimeStateTransition.findFirst({ orderBy: { enteredAt: "desc" }, select: { state: true } }),
  ]);
  const events = rows.map((r) => ({
    id: r.id,
    ruleId: r.ruleId,
    component: r.component,
    severity: r.severity,
    detail: r.detail,
    firstSeen: r.firstSeen.toISOString(),
    lastSeen: r.lastSeen.toISOString(),
  }));
  const runbooks = applicableRunbooks({
    activeRuleIds: rows.map((r) => r.ruleId as ProtectionRuleId),
    killEngaged: killSwitch.engaged,
    startupFailed: asState(latest?.state) === "FAILED",
  });
  return {
    protectedComponents: [...new Set(rows.map((r) => r.component))],
    events,
    runbooks,
  };
}

// ─────────────────────────── Incident timeline (G) ───────────────────────────

export async function getIncidentTimeline(window: IncidentWindow): Promise<IncidentTimelineView> {
  const since = new Date(Date.now() - WINDOW_MS[window]);
  const [rows, open] = await Promise.all([
    prisma.incident.findMany({
      where: { OR: [{ startedAt: { gte: since } }, { status: "OPEN" }] },
      orderBy: { startedAt: "desc" },
      take: 200,
    }),
    prisma.incident.count({ where: { status: "OPEN" } }),
  ]);
  return {
    window,
    open,
    incidents: rows.map((r) => ({
      id: r.id,
      type: r.type,
      severity: r.severity,
      affectedComponents: (r.affectedComponents as ControlComponent[] | null) ?? [],
      startedAt: r.startedAt.toISOString(),
      endedAt: r.endedAt ? r.endedAt.toISOString() : null,
      durationSec: r.durationSec,
      status: r.status,
      recoveryOutcome: r.recoveryOutcome,
      detail: r.detail,
    })),
  };
}

// ─────────────────────────── Audit trail (H) ───────────────────────────

export async function getAuditTrail(opts: { q?: string; action?: string; limit?: number }): Promise<AuditTrailView> {
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
  const where: Record<string, unknown> = {};
  if (opts.action) where.action = opts.action;
  if (opts.q) {
    where.OR = [
      { actor: { contains: opts.q, mode: "insensitive" } },
      { action: { contains: opts.q, mode: "insensitive" } },
      { reason: { contains: opts.q, mode: "insensitive" } },
    ];
  }
  const [rows, total] = await Promise.all([
    prisma.controlAuditLog.findMany({ where, orderBy: { ts: "desc" }, take: limit }),
    prisma.controlAuditLog.count({ where }),
  ]);
  return {
    total,
    entries: rows.map((r) => ({
      id: r.id,
      ts: r.ts.toISOString(),
      actor: r.actor,
      action: r.action,
      reason: r.reason,
      result: r.result,
      metadata: r.metadata,
    })),
  };
}

// ─────────────────────────── Runbooks (F) ───────────────────────────

export async function getRunbooksView(): Promise<RunbooksView> {
  const protection = await getProtectionView();
  return { all: allRunbooks(), applicable: protection.runbooks };
}

// ─────────────────────────── Recovery (E) ───────────────────────────

export async function getRecoveryView(): Promise<RecoveryView> {
  const [rows, latest] = await Promise.all([
    prisma.protectionEvent.findMany({ where: { status: "ACTIVE" }, select: { component: true } }),
    prisma.runtimeStateTransition.findFirst({ orderBy: { enteredAt: "desc" }, select: { state: true } }),
  ]);
  const components = [...new Set(rows.map((r) => r.component as ControlComponent))].map((component) => ({
    component,
    plan: RECOVERY_PLAN[component] ?? [],
  }));
  return { recovering: asState(latest?.state) === "RECOVERING", state: asState(latest?.state), components };
}
