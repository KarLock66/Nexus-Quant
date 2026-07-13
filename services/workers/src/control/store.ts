/**
 * Phase 9.7 — control-plane persistence (worker side). Thin Prisma helpers over the
 * five additive tables. The kill switch is a single authoritative row; transitions,
 * protection events, incidents, and the audit log are append/upsert only. The audit
 * log is IMMUTABLE by construction — this module exposes only `appendAudit` (no update
 * or delete path anywhere).
 */

import { prisma } from "@nexus/db";
import type {
  ControlComponent,
  ControlSeverity,
  KillSwitchState,
  ProtectionRuleId,
  RuntimeState,
} from "@nexus/control";
import { admitControlComponents, assertValidRuntimeState } from "./validate.js";

const KILL_SWITCH_ID = "singleton";

// ─────────────────────────── Kill switch ───────────────────────────

export async function getKillSwitch(): Promise<KillSwitchState> {
  const row = await prisma.controlKillSwitch.findUnique({ where: { id: KILL_SWITCH_ID } });
  if (!row) return { engaged: false, actor: null, reason: null, engagedAt: null };
  return {
    engaged: row.engaged,
    actor: row.actor,
    reason: row.reason,
    engagedAt: row.engagedAt ? row.engagedAt.toISOString() : null,
  };
}

export async function engageKillSwitch(actor: string, reason: string): Promise<void> {
  const now = new Date();
  await prisma.controlKillSwitch.upsert({
    where: { id: KILL_SWITCH_ID },
    create: { id: KILL_SWITCH_ID, engaged: true, actor, reason, engagedAt: now },
    update: { engaged: true, actor, reason, engagedAt: now, resumedAt: null, resumedBy: null },
  });
  // The kill switch is ALWAYS audited wherever it is engaged (Section H), independent of
  // the caller (web operator action, worker, or the seal).
  await appendAudit({ actor, action: "KILL", reason, result: "ACCEPTED", metadata: { source: "worker" } });
}

export async function resumeKillSwitch(actor: string, reason: string): Promise<void> {
  const now = new Date();
  await prisma.controlKillSwitch.upsert({
    where: { id: KILL_SWITCH_ID },
    create: { id: KILL_SWITCH_ID, engaged: false, resumedBy: actor, reason, resumedAt: now },
    update: { engaged: false, resumedBy: actor, reason, resumedAt: now },
  });
  await appendAudit({ actor, action: "RESUME", reason, result: "ACCEPTED", metadata: { source: "worker" } });
}

// ─────────────────────────── Runtime state ───────────────────────────

export async function getCurrentState(): Promise<RuntimeState> {
  const row = await prisma.runtimeStateTransition.findFirst({
    orderBy: { enteredAt: "desc" },
    select: { state: true },
  });
  if (!row) return "BOOTING"; // no transitions yet — first boot, not corruption
  assertValidRuntimeState(row.state, "RuntimeStateTransition.state", "MALFORMED_RUNTIME_STATE");
  return row.state;
}

export async function getLatestTransition(): Promise<{
  state: RuntimeState;
  previousState: RuntimeState | null;
  reason: string;
  affectedComponents: ControlComponent[];
  enteredAt: string;
} | null> {
  const row = await prisma.runtimeStateTransition.findFirst({ orderBy: { enteredAt: "desc" } });
  if (!row) return null;
  assertValidRuntimeState(row.state, "RuntimeStateTransition.state", "MALFORMED_STATE_TRANSITION");
  if (row.previousState !== null) {
    assertValidRuntimeState(
      row.previousState,
      "RuntimeStateTransition.previousState",
      "MALFORMED_STATE_TRANSITION",
    );
  }
  return {
    state: row.state,
    previousState: row.previousState,
    reason: row.reason,
    affectedComponents: admitControlComponents(
      row.affectedComponents,
      "RuntimeStateTransition.affectedComponents",
      "MALFORMED_STATE_TRANSITION",
    ),
    enteredAt: row.enteredAt.toISOString(),
  };
}

export async function recordTransition(args: {
  state: RuntimeState;
  previousState: RuntimeState | null;
  reason: string;
  affectedComponents: ControlComponent[];
}): Promise<void> {
  await prisma.runtimeStateTransition.create({
    data: {
      state: args.state,
      previousState: args.previousState,
      reason: args.reason,
      affectedComponents: args.affectedComponents,
    },
  });
}

// ─────────────────────────── Protection events ───────────────────────────

const SEV: Record<ControlSeverity, "INFO" | "WARNING" | "CRITICAL" | "EMERGENCY"> = {
  INFO: "INFO",
  WARNING: "WARNING",
  CRITICAL: "CRITICAL",
  EMERGENCY: "EMERGENCY",
};

/**
 * Upsert an ACTIVE protection event deduped by ruleId: a rule that keeps firing updates
 * `lastSeen`/`detail`; a new firing inserts. Returns the row id.
 */
export async function upsertProtectionEvent(args: {
  ruleId: ProtectionRuleId;
  component: ControlComponent;
  severity: ControlSeverity;
  detail: string;
  incidentId: string | null;
}): Promise<string> {
  const existing = await prisma.protectionEvent.findFirst({
    where: { ruleId: args.ruleId, status: "ACTIVE" },
    select: { id: true },
  });
  if (existing) {
    await prisma.protectionEvent.update({
      where: { id: existing.id },
      data: { lastSeen: new Date(), detail: args.detail, ...(args.incidentId ? { incidentId: args.incidentId } : {}) },
    });
    return existing.id;
  }
  const created = await prisma.protectionEvent.create({
    data: {
      ruleId: args.ruleId,
      component: args.component,
      severity: SEV[args.severity],
      detail: args.detail,
      status: "ACTIVE",
      ...(args.incidentId ? { incidentId: args.incidentId } : {}),
    },
    select: { id: true },
  });
  return created.id;
}

/** Resolve every ACTIVE protection event whose ruleId is no longer active. */
export async function resolveProtectionEventsExcept(activeRuleIds: ProtectionRuleId[]): Promise<void> {
  await prisma.protectionEvent.updateMany({
    where: { status: "ACTIVE", ruleId: { notIn: activeRuleIds.length ? activeRuleIds : ["__none__"] } },
    data: { status: "RESOLVED", resolvedAt: new Date() },
  });
}

export async function getActiveProtectionEvents(): Promise<
  { id: string; ruleId: string; component: string; severity: string; detail: string | null; firstSeen: string; lastSeen: string }[]
> {
  const rows = await prisma.protectionEvent.findMany({
    where: { status: "ACTIVE" },
    orderBy: { lastSeen: "desc" },
  });
  return rows.map((r) => ({
    id: r.id,
    ruleId: r.ruleId,
    component: r.component,
    severity: r.severity,
    detail: r.detail,
    firstSeen: r.firstSeen.toISOString(),
    lastSeen: r.lastSeen.toISOString(),
  }));
}

// ─────────────────────────── Incidents ───────────────────────────

export async function getOpenIncident(): Promise<{ id: string; affectedComponents: ControlComponent[] } | null> {
  const row = await prisma.incident.findFirst({ where: { status: "OPEN" }, orderBy: { startedAt: "desc" } });
  if (!row) return null;
  return {
    id: row.id,
    affectedComponents: admitControlComponents(
      row.affectedComponents,
      `Incident.affectedComponents (incident ${row.id})`,
      "MALFORMED_INCIDENT",
    ),
  };
}

export async function openIncident(args: {
  type: string;
  severity: ControlSeverity;
  affectedComponents: ControlComponent[];
  detail: string;
}): Promise<string> {
  const created = await prisma.incident.create({
    data: {
      type: args.type,
      severity: SEV[args.severity],
      affectedComponents: args.affectedComponents,
      status: "OPEN",
      detail: args.detail,
    },
    select: { id: true, startedAt: true },
  });
  return created.id;
}

export async function resolveIncident(id: string, outcome: "VERIFIED" | "FAILED" | "MANUAL_RESUME"): Promise<void> {
  const row = await prisma.incident.findUnique({ where: { id }, select: { startedAt: true } });
  const now = new Date();
  const durationSec = row ? Math.max(0, Math.round((now.getTime() - row.startedAt.getTime()) / 1000)) : null;
  await prisma.incident.update({
    where: { id },
    data: { status: "RESOLVED", endedAt: now, durationSec, recoveryOutcome: outcome },
  });
}

// ─────────────────────────── Audit (append-only) ───────────────────────────

export async function appendAudit(args: {
  actor: string;
  action: string;
  reason?: string | null;
  result: string;
  metadata?: unknown;
}): Promise<void> {
  await prisma.controlAuditLog.create({
    data: {
      actor: args.actor,
      action: args.action,
      ...(args.reason ? { reason: args.reason } : {}),
      result: args.result,
      ...(args.metadata !== undefined ? { metadata: args.metadata as object } : {}),
    },
  });
}
