/**
 * Wire types for the Strategy Governance page.
 *
 * Pure types only — NO runtime imports (keeps Prisma out of the browser bundle).
 * Sourced from real tables: Strategy, StrategyVersion, ApprovalRequest, AuditLog.
 * The strategy registry is laid down by the demo signal chain; the approval queue
 * and audit trail stay empty until governance actions occur (explicit empty state).
 */

export interface StrategyVersionRow {
  id: string;
  version: number;
  status: string; // StrategyStatus: DRAFT | ACTIVE | RETIRED | ...
  description: string;
  hypothesis: string;
  createdAt: string; // ISO
  createdBy: string;
}

export interface StrategyRow {
  id: string;
  name: string;
  createdAt: string; // ISO
  createdBy: string;
  versions: StrategyVersionRow[]; // newest version first
  latestStatus: string | null;
}

export interface ApprovalRow {
  id: string;
  kind: string; // ApprovalKind
  status: string; // PENDING | APPROVED | REJECTED | WITHDRAWN
  entityType: string;
  entityId: string;
  rationale: string;
  requestedBy: string;
  reviewedBy: string | null;
  reviewedAt: string | null;
  createdAt: string; // ISO
}

export interface AuditRow {
  id: string;
  ts: string; // ISO
  actor: string;
  action: string; // CREATE | UPDATE | APPROVE | MODE_CHANGE | ...
  entityType: string;
  entityId: string;
  reason: string | null;
}

/** Composite payload for GET /api/v1/governance/overview. */
export interface GovernanceOverview {
  strategies: StrategyRow[];
  approvals: ApprovalRow[]; // newest first (empty until an approval is raised)
  audit: AuditRow[]; // newest first (empty until an audited action occurs)
}
