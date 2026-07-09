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

// ── Single-ACTIVE DB invariant (partial unique index — Batch 8) ───────────────
//
// The application already pauses other ACTIVE versions before activating, but two
// approvals racing to activate different versions of the same strategy can both
// read the pre-activation snapshot and both attempt to activate. Postgres'
// partial unique index `StrategyVersion(strategyId) WHERE status = 'ACTIVE'` is
// the final arbiter: the losing UPDATE raises a unique violation (Prisma P2002),
// which governance-actions maps to a clean GovernanceConflictError (→ 409).
//
// The fake below ENFORCES that index the way Postgres would (a version may become
// ACTIVE only if no other ACTIVE version exists for the same strategy) and rolls
// back the transaction's writes on any throw. Two hooks model concurrency:
//   • onPauseRead — a barrier, so both racers read the same pre-activation view;
//   • staleActiveRead — forces the pause-read to return an MVCC-stale snapshot,
//     reproducing a losing transaction whose read predates the winner's commit.

/** A Prisma-shaped unique-constraint violation for the single-ACTIVE index. */
function prismaUniqueViolation(): Error {
  return Object.assign(new Error("\nUnique constraint failed on the fields"), {
    code: "P2002",
    meta: { target: "StrategyVersion_strategyId_active_key" },
  });
}

function enforcingFakeDb(
  seed: { strategies?: Row[]; versions?: Row[]; approvals?: Row[] },
  hooks: { onPauseRead?: () => Promise<void> | void; staleActiveRead?: () => Row[] | null } = {},
): {
  db: GovernanceDb;
  state: { strategies: Row[]; versions: Row[]; approvals: Row[]; audit: Row[] };
} {
  let nextId = 0;
  const id = (prefix: string) => `${prefix}-${(nextId += 1)}`;
  const state = {
    strategies: seed.strategies ?? [],
    versions: seed.versions ?? [],
    approvals: seed.approvals ?? [],
    audit: [] as Row[],
  };

  // A fresh tx per $transaction, each with its OWN row-level undo log. Rollback
  // reverts only this transaction's writes — never a concurrent winner's — which
  // is what makes the race test faithful (whole-state snapshot restore would
  // clobber the winner's committed activation).
  function makeTx(undo: Array<() => void>): GovernanceTx {
    const removeFrom = (arr: Row[], row: Row) => () => {
      const i = arr.indexOf(row);
      if (i >= 0) arr.splice(i, 1);
    };
    const restore = (row: Row, data: Record<string, unknown>) => {
      const prev: Record<string, unknown> = {};
      for (const k of Object.keys(data)) prev[k] = row[k];
      return () => Object.assign(row, prev);
    };
    return {
      strategy: {
        findUnique: async ({ where }) =>
          (state.strategies.find((s) => s["name"] === where.name) as { id: string }) ?? null,
        create: async ({ data }) => {
          const row = { id: id("strat"), ...data };
          state.strategies.push(row);
          undo.push(removeFrom(state.strategies, row));
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
        findMany: async ({ where }) => {
          if (where.status === "ACTIVE") {
            await hooks.onPauseRead?.();
            const stale = hooks.staleActiveRead?.();
            if (stale != null) return stale as { id: string; version: number }[];
          }
          return state.versions.filter(
            (v) =>
              v["strategyId"] === where.strategyId &&
              v["status"] === where.status &&
              (where.id === undefined || v.id !== where.id.not),
          ) as { id: string; version: number }[];
        },
        create: async ({ data }) => {
          const row = { id: id("ver"), ...data } as Row;
          state.versions.push(row);
          undo.push(removeFrom(state.versions, row));
          return row as { id: string; version: number };
        },
        update: async ({ where, data }) => {
          const row = state.versions.find((v) => v.id === where.id)!;
          // Enforce the partial unique index atomically (no await between the
          // conflict check and the mutation), exactly as Postgres would.
          if (data.status === "ACTIVE") {
            const conflict = state.versions.find(
              (v) =>
                v.id !== row.id &&
                v["strategyId"] === row["strategyId"] &&
                v["status"] === "ACTIVE",
            );
            if (conflict) throw prismaUniqueViolation();
          }
          undo.push(restore(row, data));
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
          undo.push(removeFrom(state.approvals, row));
          return row as { id: string };
        },
        update: async ({ where, data }) => {
          const row = state.approvals.find((a) => a.id === where.id)!;
          undo.push(restore(row, data));
          Object.assign(row, data);
          return row as { id: string };
        },
      },
      auditLog: {
        create: async ({ data }) => {
          const row = { id: id("audit"), ...data } as Row;
          state.audit.push(row);
          undo.push(removeFrom(state.audit, row));
          return {};
        },
      },
    };
  }

  const db: GovernanceDb = {
    $transaction: async (fn) => {
      const undo: Array<() => void> = [];
      try {
        return await fn(makeTx(undo));
      } catch (err) {
        for (let i = undo.length - 1; i >= 0; i -= 1) undo[i]!();
        throw err;
      }
    },
  };
  return { db, state };
}

/** Release both racers only once N have arrived at the pause-read. */
function barrier(n: number): () => Promise<void> {
  let arrived = 0;
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  return () => {
    arrived += 1;
    if (arrived >= n) release();
    return gate;
  };
}

describe("single-ACTIVE DB invariant — activation conflict mapping (Batch 8)", () => {
  const seedActiveStrategy = () => ({
    strategies: [{ id: "strat-0", name: "core-technical-live" }],
    versions: [
      { id: "ver-1", strategyId: "strat-0", version: 1, status: "DRAFT", createdBy: "operator:alice" },
      { id: "ver-2", strategyId: "strat-0", version: 2, status: "DRAFT", createdBy: "operator:alice" },
    ],
    approvals: [
      {
        id: "appr-1",
        kind: "DEPLOY_APPROVAL",
        status: "PENDING",
        entityType: "StrategyVersion",
        entityId: "ver-1",
        requestedBy: "operator:alice",
      },
      {
        id: "appr-2",
        kind: "DEPLOY_APPROVAL",
        status: "PENDING",
        entityType: "StrategyVersion",
        entityId: "ver-2",
        requestedBy: "operator:alice",
      },
    ],
  });

  it("keeps exactly one ACTIVE across pause-then-activate with the index enforced", async () => {
    const { db, state } = enforcingFakeDb(seedActiveStrategy());
    // Activate v1.
    const out1 = await reviewDeployApproval(
      { approvalId: "appr-1", action: "approve", actor: "operator:bob", note: null },
      db,
    );
    expect(out1.versionStatus).toBe("ACTIVE");
    expect(state.versions.filter((v) => v["status"] === "ACTIVE")).toHaveLength(1);
    // Approve v2 → pauses v1, activates v2, still exactly one ACTIVE (the index
    // never trips because the pause happens first, in-transaction).
    const out2 = await reviewDeployApproval(
      { approvalId: "appr-2", action: "approve", actor: "operator:bob", note: null },
      db,
    );
    expect(out2.pausedVersionIds).toEqual(["ver-1"]);
    expect(state.versions.find((v) => v.id === "ver-1")!["status"]).toBe("PAUSED");
    expect(state.versions.find((v) => v.id === "ver-2")!["status"]).toBe("ACTIVE");
    expect(state.versions.filter((v) => v["status"] === "ACTIVE")).toHaveLength(1);
  });

  it("concurrent approvals of two versions → exactly one ACTIVE; the loser gets a clean 409", async () => {
    const gate = barrier(2);
    const { db, state } = enforcingFakeDb(seedActiveStrategy(), { onPauseRead: gate });

    const results = await Promise.allSettled([
      reviewDeployApproval(
        { approvalId: "appr-1", action: "approve", actor: "operator:bob", note: null },
        db,
      ),
      reviewDeployApproval(
        { approvalId: "appr-2", action: "approve", actor: "operator:carol", note: null },
        db,
      ),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter(
      (r): r is PromiseRejectedResult => r.status === "rejected",
    );
    // The DB index admits exactly one winner; the loser is rejected.
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    // Losing failure is the governance conflict, NOT a raw database error.
    expect(rejected[0]!.reason).toBeInstanceOf(GovernanceConflictError);
    expect(String(rejected[0]!.reason.message)).not.toMatch(/P2002|Unique constraint|prisma/i);
    // Invariant holds at the data layer: one and only one ACTIVE version.
    expect(state.versions.filter((v) => v["status"] === "ACTIVE")).toHaveLength(1);
  });

  it("losing activation maps to GovernanceConflictError and rolls back with NO partial state", async () => {
    // Winner already committed: v1 ACTIVE. The loser (approving v2) reads an
    // MVCC-stale snapshot (no ACTIVE yet), so it does not pause v1 and its
    // activation UPDATE trips the index.
    const seed = seedActiveStrategy();
    seed.versions[0]!["status"] = "ACTIVE"; // v1 already ACTIVE (winner)
    seed.approvals[0]!["status"] = "APPROVED";
    const { db, state } = enforcingFakeDb(seed, { staleActiveRead: () => [] });

    await expect(
      reviewDeployApproval(
        { approvalId: "appr-2", action: "approve", actor: "operator:carol", note: null },
        db,
      ),
    ).rejects.toBeInstanceOf(GovernanceConflictError);

    // Rolled back cleanly: v2 stays DRAFT, its approval stays PENDING, v1 remains
    // the sole ACTIVE — no half-applied activation.
    expect(state.versions.find((v) => v.id === "ver-2")!["status"]).toBe("DRAFT");
    expect(state.approvals.find((a) => a.id === "appr-2")!["status"]).toBe("PENDING");
    const active = state.versions.filter((v) => v["status"] === "ACTIVE");
    expect(active).toHaveLength(1);
    expect(active[0]!.id).toBe("ver-1");
  });

  it("a non-racing approve is unaffected by the index (existing flow unchanged)", async () => {
    // Same enforcing index, no concurrency: behaves identically to the plain path.
    const { db, state } = enforcingFakeDb({
      strategies: [{ id: "strat-0", name: "core-technical-live" }],
      versions: [
        { id: "ver-1", strategyId: "strat-0", version: 1, status: "DRAFT", createdBy: "operator:alice" },
      ],
      approvals: [
        {
          id: "appr-1",
          kind: "DEPLOY_APPROVAL",
          status: "PENDING",
          entityType: "StrategyVersion",
          entityId: "ver-1",
          requestedBy: "operator:alice",
        },
      ],
    });
    const out = await reviewDeployApproval(
      { approvalId: "appr-1", action: "approve", actor: "operator:bob", note: "lgtm" },
      db,
    );
    expect(out.versionStatus).toBe("ACTIVE");
    expect(out.pausedVersionIds).toEqual([]);
    expect(state.approvals[0]!["status"]).toBe("APPROVED");
    expect(state.audit.some((a) => a["action"] === "APPROVE")).toBe(true);
  });
});
