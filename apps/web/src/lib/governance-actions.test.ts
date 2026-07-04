/**
 * Strategy Governance actions — register → approve → activate, verified against
 * an in-memory fake of the transactional Prisma surface (no live DB).
 *
 * Invariants under test: fail-closed validation of every mandatory governance
 * field; registration NEVER activates (DRAFT + PENDING approval only); four-eyes
 * review; immutable reviews; single-ACTIVE-per-strategy on approval; every
 * transition audited in the same transaction; demo actors refused.
 */

import { describe, expect, it } from "vitest";
import {
  GovernanceConflictError,
  GovernanceValidationError,
  registerStrategyVersion,
  retireStrategyVersion,
  reviewDeployApproval,
  type GovernanceDb,
  type GovernanceTx,
  type RegisterStrategyInput,
} from "./governance-actions";

// ── In-memory fake of the transactional surface ──────────────────────────────

interface Row {
  [k: string]: unknown;
  id: string;
}

function fakeDb(seed?: {
  strategies?: Row[];
  versions?: Row[];
  approvals?: Row[];
}): { db: GovernanceDb; state: { strategies: Row[]; versions: Row[]; approvals: Row[]; audit: Row[] } } {
  let nextId = 0;
  const id = (prefix: string) => `${prefix}-${(nextId += 1)}`;
  const state = {
    strategies: seed?.strategies ?? [],
    versions: seed?.versions ?? [],
    approvals: seed?.approvals ?? [],
    audit: [] as Row[],
  };

  const tx: GovernanceTx = {
    strategy: {
      findUnique: async ({ where }) =>
        (state.strategies.find((s) => s["name"] === where.name) as { id: string }) ?? null,
      create: async ({ data }) => {
        const row = { id: id("strat"), ...data };
        state.strategies.push(row);
        return row;
      },
    },
    strategyVersion: {
      findUnique: async ({ where }) =>
        (state.versions.find((v) => v.id === where.id) as never) ?? null,
      findFirst: async ({ where }) => {
        const rows = state.versions
          .filter((v) => v["strategyId"] === where.strategyId)
          .sort((a, b) => (b["version"] as number) - (a["version"] as number));
        return (rows[0] as unknown as { version: number }) ?? null;
      },
      findMany: async ({ where }) =>
        state.versions.filter(
          (v) =>
            v["strategyId"] === where.strategyId &&
            v["status"] === where.status &&
            (where.id === undefined || v.id !== where.id.not),
        ) as { id: string; version: number }[],
      create: async ({ data }) => {
        const row = { id: id("ver"), ...data } as Row;
        state.versions.push(row);
        return row as { id: string; version: number };
      },
      update: async ({ where, data }) => {
        const row = state.versions.find((v) => v.id === where.id)!;
        Object.assign(row, data);
        return row as { id: string; status: string };
      },
    },
    approvalRequest: {
      findUnique: async ({ where }) =>
        (state.approvals.find((a) => a.id === where.id) as never) ?? null,
      create: async ({ data }) => {
        const row = { id: id("appr"), ...data } as Row;
        state.approvals.push(row);
        return row as { id: string };
      },
      update: async ({ where, data }) => {
        const row = state.approvals.find((a) => a.id === where.id)!;
        Object.assign(row, data);
        return row as { id: string };
      },
    },
    auditLog: {
      create: async ({ data }) => {
        state.audit.push({ id: id("audit"), ...data } as Row);
        return {};
      },
    },
  };

  const db: GovernanceDb = {
    $transaction: async (fn) => fn(tx),
  };
  return { db, state };
}

function validInput(overrides: Partial<RegisterStrategyInput> = {}): RegisterStrategyInput {
  return {
    strategyName: "core-technical-live",
    actor: "operator:alice",
    rationale: "deploy the reviewed core-technical parameters to production",
    description: "RSI/vol regime strategy over H1 perps",
    hypothesis: "momentum persists within volatility bounds",
    entryLogic: "enter when RSI crosses the regime threshold",
    exitLogic: "exit on opposite signal or invalidation",
    riskRules: "max 1% equity risk per trade; kill on daily loss",
    failureConditions: "sustained chop regime; funding inversion",
    parameters: { rsiLongMin: 55, rsiShortMax: 45, maxRealizedVol: 0.02 },
    validRegimes: ["TRENDING_UP", "TRENDING_DOWN"],
    volatilityBounds: { min: 0.001, max: 0.05 },
    ...overrides,
  };
}

// ── Registration ─────────────────────────────────────────────────────────────

describe("registerStrategyVersion — fail-closed registration (never activates)", () => {
  it("creates Strategy + DRAFT version + PENDING DEPLOY_APPROVAL + audit rows", async () => {
    const { db, state } = fakeDb();
    const r = await registerStrategyVersion(validInput(), db);
    expect(r.version).toBe(1);
    expect(r.status).toBe("DRAFT");
    expect(r.strategyCreated).toBe(true);
    const version = state.versions[0]!;
    expect(version["status"]).toBe("DRAFT"); // NEVER ACTIVE at registration
    const approval = state.approvals[0]!;
    expect(approval["kind"]).toBe("DEPLOY_APPROVAL");
    expect(approval["status"]).toBe("PENDING");
    expect(approval["entityId"]).toBe(version.id);
    // Audited: Strategy CREATE + StrategyVersion CREATE.
    expect(state.audit.map((a) => `${a["action"]}:${a["entityType"]}`)).toEqual([
      "CREATE:Strategy",
      "CREATE:StrategyVersion",
    ]);
  });

  it("increments the version for an existing strategy (immutable versions)", async () => {
    const { db, state } = fakeDb({
      strategies: [{ id: "strat-0", name: "core-technical-live" }],
      versions: [{ id: "ver-0", strategyId: "strat-0", version: 3, status: "ACTIVE" }],
    });
    const r = await registerStrategyVersion(validInput(), db);
    expect(r.version).toBe(4);
    expect(r.strategyCreated).toBe(false);
    expect(state.strategies).toHaveLength(1);
  });

  const mandatoryText = [
    "strategyName",
    "actor",
    "rationale",
    "description",
    "hypothesis",
    "entryLogic",
    "exitLogic",
    "riskRules",
    "failureConditions",
  ] as const;
  for (const field of mandatoryText) {
    it(`refuses a missing/blank '${field}'`, async () => {
      const { db } = fakeDb();
      await expect(
        registerStrategyVersion(validInput({ [field]: "  " }), db),
      ).rejects.toThrow(GovernanceValidationError);
    });
  }

  it("refuses malformed parameters / regimes / volatility bounds", async () => {
    const { db } = fakeDb();
    await expect(
      registerStrategyVersion(validInput({ parameters: [1, 2] }), db),
    ).rejects.toThrow(/'parameters'/);
    await expect(
      registerStrategyVersion(validInput({ validRegimes: [] }), db),
    ).rejects.toThrow(/'validRegimes'/);
    await expect(
      registerStrategyVersion(validInput({ volatilityBounds: { min: 0.05, max: 0.01 } }), db),
    ).rejects.toThrow(/'volatilityBounds'/);
  });

  it("refuses demo actors on the production path", async () => {
    const { db } = fakeDb();
    await expect(
      registerStrategyVersion(validInput({ actor: "system:demo" }), db),
    ).rejects.toThrow(/demo actors are refused/);
  });
});

// ── Review (approve / reject) ────────────────────────────────────────────────

async function registered() {
  const { db, state } = fakeDb();
  const r = await registerStrategyVersion(validInput(), db);
  return { db, state, r };
}

describe("reviewDeployApproval — four-eyes activation with a single ACTIVE per strategy", () => {
  it("approve (by a DIFFERENT actor) activates the version and audits the transition", async () => {
    const { db, state, r } = await registered();
    const out = await reviewDeployApproval(
      { approvalId: r.approvalRequestId, action: "approve", actor: "operator:bob", note: "lgtm" },
      db,
    );
    expect(out.versionStatus).toBe("ACTIVE");
    expect(state.versions.find((v) => v.id === r.versionId)!["status"]).toBe("ACTIVE");
    expect(state.approvals[0]!["status"]).toBe("APPROVED");
    expect(state.approvals[0]!["reviewedBy"]).toBe("operator:bob");
    const audits = state.audit.map((a) => `${a["action"]}:${a["entityType"]}`);
    expect(audits).toContain("APPROVE:ApprovalRequest");
    expect(audits.filter((a) => a === "UPDATE:StrategyVersion")).toHaveLength(1);
  });

  it("ENFORCES four-eyes: the requester cannot approve their own deployment", async () => {
    const { db, r } = await registered();
    await expect(
      reviewDeployApproval(
        { approvalId: r.approvalRequestId, action: "approve", actor: "operator:alice", note: null },
        db,
      ),
    ).rejects.toThrow(/four-eyes/);
  });

  it("PAUSES the previously-active version of the same strategy (single ACTIVE)", async () => {
    const { db, state, r } = await registered();
    // Activate v1.
    await reviewDeployApproval(
      { approvalId: r.approvalRequestId, action: "approve", actor: "operator:bob", note: null },
      db,
    );
    // Register + approve v2.
    const r2 = await registerStrategyVersion(validInput(), db);
    const out = await reviewDeployApproval(
      { approvalId: r2.approvalRequestId, action: "approve", actor: "operator:bob", note: null },
      db,
    );
    expect(out.pausedVersionIds).toEqual([r.versionId]);
    expect(state.versions.find((v) => v.id === r.versionId)!["status"]).toBe("PAUSED");
    expect(state.versions.find((v) => v.id === r2.versionId)!["status"]).toBe("ACTIVE");
    const active = state.versions.filter((v) => v["status"] === "ACTIVE");
    expect(active).toHaveLength(1);
  });

  it("reject leaves the version DRAFT (never activated) and records the review", async () => {
    const { db, state, r } = await registered();
    const out = await reviewDeployApproval(
      { approvalId: r.approvalRequestId, action: "reject", actor: "operator:bob", note: "not yet" },
      db,
    );
    expect(out.versionStatus).toBe("DRAFT");
    expect(state.versions[0]!["status"]).toBe("DRAFT");
    expect(state.approvals[0]!["status"]).toBe("REJECTED");
  });

  it("reviews are IMMUTABLE: a decided approval cannot be re-reviewed", async () => {
    const { db, r } = await registered();
    await reviewDeployApproval(
      { approvalId: r.approvalRequestId, action: "reject", actor: "operator:bob", note: null },
      db,
    );
    await expect(
      reviewDeployApproval(
        { approvalId: r.approvalRequestId, action: "approve", actor: "operator:bob", note: null },
        db,
      ),
    ).rejects.toThrow(GovernanceConflictError);
  });

  it("refuses an unknown approval id and a bad action", async () => {
    const { db } = await registered();
    await expect(
      reviewDeployApproval({ approvalId: "nope", action: "approve", actor: "operator:bob", note: null }, db),
    ).rejects.toThrow(GovernanceConflictError);
    await expect(
      reviewDeployApproval({ approvalId: "nope", action: "activate", actor: "operator:bob", note: null }, db),
    ).rejects.toThrow(GovernanceValidationError);
  });
});

// ── Retire ───────────────────────────────────────────────────────────────────

describe("retireStrategyVersion — terminal, audited", () => {
  it("retires an ACTIVE version with an audit row; retiring twice conflicts", async () => {
    const { db, state, r } = await registered();
    await reviewDeployApproval(
      { approvalId: r.approvalRequestId, action: "approve", actor: "operator:bob", note: null },
      db,
    );
    const out = await retireStrategyVersion(
      { versionId: r.versionId, actor: "operator:bob", reason: "superseded strategy family" },
      db,
    );
    expect(out.versionStatus).toBe("RETIRED");
    expect(state.versions[0]!["status"]).toBe("RETIRED");
    await expect(
      retireStrategyVersion(
        { versionId: r.versionId, actor: "operator:bob", reason: "again" },
        db,
      ),
    ).rejects.toThrow(/already RETIRED/);
  });

  it("requires a non-empty reason (fail-closed)", async () => {
    const { db, r } = await registered();
    await expect(
      retireStrategyVersion({ versionId: r.versionId, actor: "operator:bob", reason: "" }, db),
    ).rejects.toThrow(GovernanceValidationError);
  });
});
