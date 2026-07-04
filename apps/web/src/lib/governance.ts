import { prisma } from "@nexus/db";
import type {
  ApprovalRow,
  AuditRow,
  GovernanceOverview,
  StrategyRow,
  StrategyVersionRow,
} from "./governance-types";

/**
 * Server-only data layer for the Strategy Governance page. Reads real persisted
 * state (Prisma): the Strategy registry with immutable StrategyVersions, the
 * ApprovalRequest queue, and the AuditLog. Nothing is fabricated — the registry
 * is seeded by the demo signal chain; an empty approval queue / audit trail is
 * reported as such rather than filled with placeholder rows.
 */

const APPROVAL_LIMIT = 25;
const AUDIT_LIMIT = 30;

export async function getGovernanceOverview(): Promise<GovernanceOverview> {
  const [strategies, approvals, audit] = await Promise.all([
    prisma.strategy.findMany({
      orderBy: { createdAt: "asc" },
      include: { versions: { orderBy: { version: "desc" } } },
    }),
    prisma.approvalRequest.findMany({ orderBy: { createdAt: "desc" }, take: APPROVAL_LIMIT }),
    prisma.auditLog.findMany({ orderBy: { ts: "desc" }, take: AUDIT_LIMIT }),
  ]);

  const strategyRows: StrategyRow[] = strategies.map((s) => {
    const versions: StrategyVersionRow[] = s.versions.map((v) => ({
      id: v.id,
      version: v.version,
      status: v.status,
      description: v.description,
      hypothesis: v.hypothesis,
      createdAt: v.createdAt.toISOString(),
      createdBy: v.createdBy,
    }));
    return {
      id: s.id,
      name: s.name,
      createdAt: s.createdAt.toISOString(),
      createdBy: s.createdBy,
      versions,
      latestStatus: versions[0]?.status ?? null,
    };
  });

  const approvalRows: ApprovalRow[] = approvals.map((a) => ({
    id: a.id,
    kind: a.kind,
    status: a.status,
    entityType: a.entityType,
    entityId: a.entityId,
    rationale: a.rationale,
    requestedBy: a.requestedBy,
    reviewedBy: a.reviewedBy,
    reviewedAt: a.reviewedAt ? a.reviewedAt.toISOString() : null,
    createdAt: a.createdAt.toISOString(),
  }));

  const auditRows: AuditRow[] = audit.map((l) => ({
    id: l.id,
    ts: l.ts.toISOString(),
    actor: l.actor,
    action: l.action,
    entityType: l.entityType,
    entityId: l.entityId,
    reason: l.reason,
  }));

  return { strategies: strategyRows, approvals: approvalRows, audit: auditRows };
}
