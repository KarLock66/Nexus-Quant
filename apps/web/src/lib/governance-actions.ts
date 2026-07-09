import { prisma } from "@nexus/db";

/**
 * Strategy Governance actions — the PRODUCTION register → approve → activate
 * path (Final production completion). Closes the "no production
 * strategy-registration path" blocker: StrategyVersion rows are no longer
 * creatable only by this governed path — an operator registers a DRAFT
 * version (mandatory governance fields, fail-closed validation), a SECOND
 * operator approves the deployment (four-eyes), and activation is what the
 * workers' `resolvePersistedLineage` (newest ACTIVE version) picks up.
 *
 * Discipline:
 *  - FAIL-CLOSED validation: every mandatory governance field must be present
 *    and well-formed or the request is refused; nothing is defaulted for the
 *    caller.
 *  - Approval-first: registration NEVER activates; it creates a PENDING
 *    DEPLOY_APPROVAL. Only an explicit approve (by a different actor than the
 *    requester) transitions DRAFT → ACTIVE.
 *  - Single-active-per-strategy: activation PAUSES any other ACTIVE version of
 *    the same strategy in the same transaction, so lineage resolution is
 *    deterministic (exactly one ACTIVE per strategy).
 *  - Immutable audit: every state change writes AuditLog rows (before/after)
 *    inside the SAME transaction — no unaudited transition can commit.
 *  - Demo separation: `system:demo` / `demo:*` actors are refused — the
 *    production governance path can never mint demo-lineage rows.
 */

// ── Errors (mapped to HTTP statuses by the routes) ───────────────────────────

/** Malformed / missing input → 400. */
export class GovernanceValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GovernanceValidationError";
  }
}

/** Legal input in an illegal state (already reviewed, wrong status…) → 409. */
export class GovernanceConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GovernanceConflictError";
  }
}

/**
 * True when `err` is a Postgres unique-constraint violation for the single-ACTIVE
 * partial index (`StrategyVersion_strategyId_active_key`), surfaced by Prisma as
 * a P2002 known-request error. Two approvals that race to activate different
 * versions of the same strategy both pass the application-level "pause others"
 * check against a pre-commit snapshot; the database is the final arbiter and
 * fails the loser here. We match on the P2002 code and, when Prisma reports it,
 * the index name in `meta.target` — but the code alone is dispositive because the
 * only unique constraint an activation UPDATE can touch is this one (it never
 * changes `strategyId`/`version`, the other unique key).
 */
function isSingleActiveConflict(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as { code?: unknown; meta?: { target?: unknown } };
  if (e.code !== "P2002") return false;
  const target = e.meta?.target;
  if (typeof target === "string") return target.includes("active");
  if (Array.isArray(target)) return target.some((t) => String(t).includes("active"));
  // Prisma does not always populate meta.target for raw partial indexes — the
  // P2002 code during activation is conclusive on its own.
  return true;
}

// ── Client seam (injected in tests; the real Prisma client in routes) ────────

/** The minimal transactional surface these actions need (subset of PrismaClient). */
export interface GovernanceDb {
  $transaction<T>(fn: (tx: GovernanceTx) => Promise<T>): Promise<T>;
}

export interface GovernanceTx {
  strategy: {
    findUnique(args: { where: { name: string } }): Promise<{ id: string } | null>;
    create(args: {
      data: { name: string; createdBy: string };
    }): Promise<{ id: string }>;
  };
  strategyVersion: {
    findUnique(args: {
      where: { id: string };
    }): Promise<{ id: string; strategyId: string; version: number; status: string } | null>;
    findFirst(args: {
      where: { strategyId: string };
      orderBy: { version: "desc" };
    }): Promise<{ version: number } | null>;
    findMany(args: {
      where: { strategyId: string; status: string; id?: { not: string } };
    }): Promise<{ id: string; version: number }[]>;
    create(args: { data: Record<string, unknown> }): Promise<{ id: string; version: number }>;
    update(args: {
      where: { id: string };
      data: { status: string };
    }): Promise<{ id: string; status: string }>;
  };
  approvalRequest: {
    findUnique(args: { where: { id: string } }): Promise<{
      id: string;
      kind: string;
      status: string;
      entityType: string;
      entityId: string;
      requestedBy: string;
    } | null>;
    create(args: { data: Record<string, unknown> }): Promise<{ id: string }>;
    update(args: {
      where: { id: string };
      data: Record<string, unknown>;
    }): Promise<{ id: string }>;
  };
  auditLog: {
    create(args: { data: Record<string, unknown> }): Promise<unknown>;
  };
}

const db = (): GovernanceDb => prisma as unknown as GovernanceDb;

// ── Validation helpers (fail-closed) ─────────────────────────────────────────

function requireText(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new GovernanceValidationError(`'${field}' is required and must be a non-empty string`);
  }
  return value.trim();
}

function requireActor(value: unknown, field = "actor"): string {
  const actor = requireText(value, field);
  if (actor === "system:demo" || actor.toLowerCase().startsWith("demo")) {
    throw new GovernanceValidationError(
      `'${field}' must be a real operator identity — demo actors are refused on the production governance path`,
    );
  }
  return actor;
}

// ── Register (DRAFT + PENDING approval; never activates) ─────────────────────

export interface RegisterStrategyInput {
  strategyName: unknown;
  actor: unknown;
  rationale: unknown;
  description: unknown;
  hypothesis: unknown;
  entryLogic: unknown;
  exitLogic: unknown;
  riskRules: unknown;
  failureConditions: unknown;
  parameters: unknown;
  validRegimes: unknown;
  volatilityBounds: unknown;
}

export interface RegisteredStrategyVersion {
  strategyId: string;
  strategyCreated: boolean;
  versionId: string;
  version: number;
  status: "DRAFT";
  approvalRequestId: string;
}

export async function registerStrategyVersion(
  input: RegisterStrategyInput,
  client: GovernanceDb = db(),
): Promise<RegisteredStrategyVersion> {
  const strategyName = requireText(input.strategyName, "strategyName");
  const actor = requireActor(input.actor);
  const rationale = requireText(input.rationale, "rationale");
  const description = requireText(input.description, "description");
  const hypothesis = requireText(input.hypothesis, "hypothesis");
  const entryLogic = requireText(input.entryLogic, "entryLogic");
  const exitLogic = requireText(input.exitLogic, "exitLogic");
  const riskRules = requireText(input.riskRules, "riskRules");
  const failureConditions = requireText(input.failureConditions, "failureConditions");

  const parameters = input.parameters;
  if (typeof parameters !== "object" || parameters === null || Array.isArray(parameters)) {
    throw new GovernanceValidationError("'parameters' must be a JSON object of typed parameters");
  }
  const validRegimes = input.validRegimes;
  if (
    !Array.isArray(validRegimes) ||
    validRegimes.length === 0 ||
    !validRegimes.every((r) => typeof r === "string" && r.trim() !== "")
  ) {
    throw new GovernanceValidationError(
      "'validRegimes' must be a non-empty array of market-regime names",
    );
  }
  const vb = input.volatilityBounds as { min?: unknown; max?: unknown } | null;
  const vbMin = typeof vb?.min === "number" && Number.isFinite(vb.min) ? vb.min : null;
  const vbMax = typeof vb?.max === "number" && Number.isFinite(vb.max) ? vb.max : null;
  if (vbMin === null || vbMax === null || vbMin < 0 || !(vbMin < vbMax)) {
    throw new GovernanceValidationError(
      "'volatilityBounds' must be { min, max } with 0 <= min < max",
    );
  }

  return client.$transaction(async (tx) => {
    const existing = await tx.strategy.findUnique({ where: { name: strategyName } });
    const strategy =
      existing ?? (await tx.strategy.create({ data: { name: strategyName, createdBy: actor } }));
    if (existing === null) {
      await tx.auditLog.create({
        data: {
          actor,
          action: "CREATE",
          entityType: "Strategy",
          entityId: strategy.id,
          after: { name: strategyName },
          reason: rationale,
        },
      });
    }

    const latest = await tx.strategyVersion.findFirst({
      where: { strategyId: strategy.id },
      orderBy: { version: "desc" },
    });
    const nextVersion = (latest?.version ?? 0) + 1;

    const version = await tx.strategyVersion.create({
      data: {
        strategyId: strategy.id,
        version: nextVersion,
        status: "DRAFT",
        description,
        hypothesis,
        entryLogic,
        exitLogic,
        riskRules,
        failureConditions,
        parameters,
        validRegimes,
        volatilityBounds: { min: vbMin, max: vbMax },
        createdBy: actor,
      },
    });

    const approval = await tx.approvalRequest.create({
      data: {
        kind: "DEPLOY_APPROVAL",
        status: "PENDING",
        entityType: "StrategyVersion",
        entityId: version.id,
        payload: { strategyId: strategy.id, strategyName, version: nextVersion },
        rationale,
        requestedBy: actor,
      },
    });

    await tx.auditLog.create({
      data: {
        actor,
        action: "CREATE",
        entityType: "StrategyVersion",
        entityId: version.id,
        after: { strategyId: strategy.id, version: nextVersion, status: "DRAFT" },
        reason: rationale,
        requestId: approval.id,
      },
    });

    return {
      strategyId: strategy.id,
      strategyCreated: existing === null,
      versionId: version.id,
      version: nextVersion,
      status: "DRAFT" as const,
      approvalRequestId: approval.id,
    };
  });
}

// ── Review (approve → ACTIVE with single-active invariant; reject) ───────────

export interface ReviewApprovalInput {
  approvalId: string;
  action: unknown;
  actor: unknown;
  note: unknown;
}

export interface ReviewedApproval {
  approvalRequestId: string;
  action: "approve" | "reject";
  versionId: string;
  versionStatus: string;
  pausedVersionIds: string[];
}

export async function reviewDeployApproval(
  input: ReviewApprovalInput,
  client: GovernanceDb = db(),
): Promise<ReviewedApproval> {
  const action = input.action;
  if (action !== "approve" && action !== "reject") {
    throw new GovernanceValidationError("'action' must be \"approve\" or \"reject\"");
  }
  const actor = requireActor(input.actor);
  const note =
    input.note === undefined || input.note === null ? null : requireText(input.note, "note");

  try {
    return await client.$transaction(async (tx) => {
      const approval = await tx.approvalRequest.findUnique({ where: { id: input.approvalId } });
      if (approval === null) {
        throw new GovernanceConflictError(`approval request ${input.approvalId} does not exist`);
      }
      if (approval.status !== "PENDING") {
        throw new GovernanceConflictError(
          `approval request ${approval.id} is already ${approval.status} — reviews are immutable`,
        );
      }
      if (approval.kind !== "DEPLOY_APPROVAL" || approval.entityType !== "StrategyVersion") {
        throw new GovernanceConflictError(
          `approval request ${approval.id} is ${approval.kind}/${approval.entityType}, not a strategy deploy approval`,
        );
      }
      // Four-eyes: the reviewer must not be the requester.
      if (approval.requestedBy === actor) {
        throw new GovernanceConflictError(
          "four-eyes violation: the requesting actor cannot review their own deployment",
        );
      }

      const version = await tx.strategyVersion.findUnique({ where: { id: approval.entityId } });
      if (version === null) {
        throw new GovernanceConflictError(
          `strategy version ${approval.entityId} referenced by the approval no longer exists`,
        );
      }
      if (version.status !== "DRAFT" && version.status !== "PENDING_DEPLOY_APPROVAL") {
        throw new GovernanceConflictError(
          `strategy version ${version.id} is ${version.status} — only DRAFT/PENDING_DEPLOY_APPROVAL can be reviewed`,
        );
      }

      const reviewedAt = new Date();
      await tx.approvalRequest.update({
        where: { id: approval.id },
        data: {
          status: action === "approve" ? "APPROVED" : "REJECTED",
          reviewedBy: actor,
          reviewedAt,
          reviewNote: note,
        },
      });
      await tx.auditLog.create({
        data: {
          actor,
          action: action === "approve" ? "APPROVE" : "REJECT",
          entityType: "ApprovalRequest",
          entityId: approval.id,
          before: { status: "PENDING" },
          after: { status: action === "approve" ? "APPROVED" : "REJECTED" },
          reason: note,
          requestId: approval.id,
        },
      });

      if (action === "reject") {
        // A rejected deployment leaves the version in DRAFT (it never activated).
        return {
          approvalRequestId: approval.id,
          action,
          versionId: version.id,
          versionStatus: version.status,
          pausedVersionIds: [],
        };
      }

      // Single-active-per-strategy: pause every OTHER active version first, in the
      // same transaction, each with its own audit row. The DB partial unique index
      // (StrategyVersion_strategyId_active_key) is the final arbiter — if a
      // concurrent approval activated another version against a snapshot this
      // transaction never saw, the activation UPDATE below raises P2002 and the
      // whole transaction (including this approval decision) rolls back.
      const otherActive = await tx.strategyVersion.findMany({
        where: { strategyId: version.strategyId, status: "ACTIVE", id: { not: version.id } },
      });
      for (const other of otherActive) {
        await tx.strategyVersion.update({ where: { id: other.id }, data: { status: "PAUSED" } });
        await tx.auditLog.create({
          data: {
            actor,
            action: "UPDATE",
            entityType: "StrategyVersion",
            entityId: other.id,
            before: { status: "ACTIVE" },
            after: { status: "PAUSED" },
            reason: `superseded by activation of version ${version.version} (approval ${approval.id})`,
            requestId: approval.id,
          },
        });
      }

      await tx.strategyVersion.update({ where: { id: version.id }, data: { status: "ACTIVE" } });
      await tx.auditLog.create({
        data: {
          actor,
          action: "UPDATE",
          entityType: "StrategyVersion",
          entityId: version.id,
          before: { status: version.status },
          after: { status: "ACTIVE" },
          reason: note ?? `deployment approved (approval ${approval.id})`,
          requestId: approval.id,
        },
      });

      return {
        approvalRequestId: approval.id,
        action,
        versionId: version.id,
        versionStatus: "ACTIVE",
        pausedVersionIds: otherActive.map((v) => v.id),
      };
    });
  } catch (err) {
    // A concurrent activation won the race: the DB rejected this one with the
    // single-ACTIVE unique violation. Map it into the existing governance
    // conflict path (→ 409) and never leak the raw database error.
    if (isSingleActiveConflict(err)) {
      throw new GovernanceConflictError(
        "another version of this strategy was activated concurrently — this activation was rolled back; re-review to supersede the now-active version",
      );
    }
    throw err;
  }
}

// ── Retire (terminal, audited) ───────────────────────────────────────────────

export interface RetireVersionInput {
  versionId: string;
  actor: unknown;
  reason: unknown;
}

export async function retireStrategyVersion(
  input: RetireVersionInput,
  client: GovernanceDb = db(),
): Promise<{ versionId: string; versionStatus: "RETIRED" }> {
  const actor = requireActor(input.actor);
  const reason = requireText(input.reason, "reason");

  return client.$transaction(async (tx) => {
    const version = await tx.strategyVersion.findUnique({ where: { id: input.versionId } });
    if (version === null) {
      throw new GovernanceConflictError(`strategy version ${input.versionId} does not exist`);
    }
    if (version.status === "RETIRED") {
      throw new GovernanceConflictError(`strategy version ${version.id} is already RETIRED`);
    }
    await tx.strategyVersion.update({ where: { id: version.id }, data: { status: "RETIRED" } });
    await tx.auditLog.create({
      data: {
        actor,
        action: "UPDATE",
        entityType: "StrategyVersion",
        entityId: version.id,
        before: { status: version.status },
        after: { status: "RETIRED" },
        reason,
      },
    });
    return { versionId: version.id, versionStatus: "RETIRED" as const };
  });
}
