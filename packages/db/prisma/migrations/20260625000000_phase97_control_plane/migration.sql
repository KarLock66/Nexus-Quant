-- Phase 9.7 — Production Control Plane (WRITE side).
-- Additive only: five new tables for the operator control plane (/control). No
-- existing table, enum, or column is altered. The "severity" columns reuse the
-- existing "RiskSeverity" enum; state/status columns are TEXT with canonical values
-- owned by the @nexus/control package (mirrors the Phase 9.6 OpsAlert precedent).

-- CreateTable: global kill switch (single authoritative row, id = 'singleton').
CREATE TABLE "ControlKillSwitch" (
    "id" TEXT NOT NULL,
    "engaged" BOOLEAN NOT NULL DEFAULT false,
    "actor" TEXT,
    "reason" TEXT,
    "engagedAt" TIMESTAMP(3),
    "resumedBy" TEXT,
    "resumedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ControlKillSwitch_pkey" PRIMARY KEY ("id")
);

-- CreateTable: runtime state machine transitions (append-only).
CREATE TABLE "RuntimeStateTransition" (
    "id" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "previousState" TEXT,
    "reason" TEXT NOT NULL,
    "affectedComponents" JSONB NOT NULL,
    "enteredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RuntimeStateTransition_pkey" PRIMARY KEY ("id")
);

-- CreateTable: protection events (deduped by ruleId while ACTIVE).
CREATE TABLE "ProtectionEvent" (
    "id" TEXT NOT NULL,
    "ruleId" TEXT NOT NULL,
    "component" TEXT NOT NULL,
    "severity" "RiskSeverity" NOT NULL,
    "detail" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "firstSeen" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeen" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),
    "incidentId" TEXT,

    CONSTRAINT "ProtectionEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable: incident timeline.
CREATE TABLE "Incident" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "severity" "RiskSeverity" NOT NULL,
    "affectedComponents" JSONB NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),
    "durationSec" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "recoveryOutcome" TEXT,
    "detail" TEXT,

    CONSTRAINT "Incident_pkey" PRIMARY KEY ("id")
);

-- CreateTable: immutable operational audit trail (append-only).
CREATE TABLE "ControlAuditLog" (
    "id" TEXT NOT NULL,
    "ts" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actor" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "reason" TEXT,
    "result" TEXT NOT NULL,
    "metadata" JSONB,

    CONSTRAINT "ControlAuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RuntimeStateTransition_enteredAt_idx" ON "RuntimeStateTransition"("enteredAt" DESC);
CREATE INDEX "ProtectionEvent_status_lastSeen_idx" ON "ProtectionEvent"("status", "lastSeen" DESC);
CREATE INDEX "ProtectionEvent_ruleId_status_idx" ON "ProtectionEvent"("ruleId", "status");
CREATE INDEX "Incident_status_startedAt_idx" ON "Incident"("status", "startedAt" DESC);
CREATE INDEX "Incident_startedAt_idx" ON "Incident"("startedAt" DESC);
CREATE INDEX "ControlAuditLog_ts_idx" ON "ControlAuditLog"("ts" DESC);
CREATE INDEX "ControlAuditLog_action_ts_idx" ON "ControlAuditLog"("action", "ts" DESC);
