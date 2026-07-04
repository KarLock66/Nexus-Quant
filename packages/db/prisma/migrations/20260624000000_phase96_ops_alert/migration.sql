-- Phase 9.6 — Operations Control Plane.
-- Additive only: a single new "OpsAlert" table for the operator monitoring page
-- (/ops). No existing table, enum, or column is altered. Reuses the existing
-- "RiskSeverity" enum for the severity column.

-- CreateTable
CREATE TABLE "OpsAlert" (
    "id" TEXT NOT NULL,
    "ruleId" TEXT NOT NULL,
    "severity" "RiskSeverity" NOT NULL,
    "message" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "firstSeen" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeen" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),
    "detail" TEXT,

    CONSTRAINT "OpsAlert_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OpsAlert_status_lastSeen_idx" ON "OpsAlert"("status", "lastSeen" DESC);

-- CreateIndex
CREATE INDEX "OpsAlert_ruleId_status_idx" ON "OpsAlert"("ruleId", "status");
