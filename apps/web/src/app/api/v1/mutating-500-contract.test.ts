/**
 * Batch 7 — generic 500 responses on the five mutating /api/v1 routes
 * (control/kill, control/resume, governance/strategies,
 * governance/approvals/[id], ops/actions).
 *
 * Contract under test:
 *  - an UNEXPECTED server error returns { error: <route's stable safe message>,
 *    correlationId } with status 500 — no `detail`, no String(err), no
 *    fragment of the underlying failure on any field;
 *  - the ORIGINAL error is logged server-side exactly once, tagged with the
 *    SAME correlation id the client received;
 *  - typed client errors keep their existing envelopes: 400 for validation,
 *    409 for governance conflicts (and neither carries a correlation id);
 *  - the success envelope { data, generatedAt } is unchanged.
 *
 * The lib layers (control / governance-actions / ops) and the session guard
 * are mocked: these tests isolate the routes' error-envelope behavior, not the
 * business logic beneath them. Auth behavior itself is out of scope (B1/B2
 * tests cover it) — the guard is stubbed to an authenticated operator.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/operator-auth", () => ({
  requireOperatorSession: vi.fn(),
}));
vi.mock("@/lib/control", () => ({
  engageKill: vi.fn(),
  resumeKill: vi.fn(),
}));
vi.mock("@/lib/governance-actions", () => {
  class GovernanceValidationError extends Error {}
  class GovernanceConflictError extends Error {}
  return {
    GovernanceValidationError,
    GovernanceConflictError,
    registerStrategyVersion: vi.fn(),
    reviewDeployApproval: vi.fn(),
  };
});
vi.mock("@/lib/ops", () => ({
  executeAction: vi.fn(),
  getActionsCatalog: vi.fn(),
}));

import { engageKill, resumeKill } from "@/lib/control";
import {
  GovernanceConflictError,
  GovernanceValidationError,
  registerStrategyVersion,
  reviewDeployApproval,
} from "@/lib/governance-actions";
import { executeAction, getActionsCatalog } from "@/lib/ops";
import { requireOperatorSession } from "@/lib/operator-auth";
import { POST as killPost } from "./control/kill/route";
import { POST as resumePost } from "./control/resume/route";
import { POST as approvalsPost } from "./governance/approvals/[id]/route";
import { POST as strategiesPost } from "./governance/strategies/route";
import { GET as actionsGet, POST as actionsPost } from "./ops/actions/route";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** A hostile-looking internal failure: none of these tokens may reach a client. */
const INTERNAL = new Error(
  "connect ECONNREFUSED db-internal.nexus.local:5432 (schema=nexus_prod)",
);

const jsonPost = (body: unknown): Request =>
  new Request("http://test.local/api/v1/x", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

const approvalCtx = (id: string) => ({ params: Promise.resolve({ id }) });

const spyOnConsoleError = () => vi.spyOn(console, "error").mockImplementation(() => {});
let errorSpy: ReturnType<typeof spyOnConsoleError>;

beforeEach(() => {
  vi.resetAllMocks();
  errorSpy = spyOnConsoleError();
  vi.mocked(requireOperatorSession).mockResolvedValue({ operatorId: "op-alice" });
});

afterEach(() => {
  errorSpy.mockRestore();
});

describe("unexpected error → generic 500 + correlation id (all five routes)", () => {
  const CASES = [
    {
      name: "POST /control/kill",
      safeMessage: "failed to engage kill switch",
      arrange: () => vi.mocked(engageKill).mockRejectedValue(INTERNAL),
      invoke: () => killPost(jsonPost({ reason: "test reason" })),
    },
    {
      name: "POST /control/resume",
      safeMessage: "failed to resume",
      arrange: () => vi.mocked(resumeKill).mockRejectedValue(INTERNAL),
      invoke: () => resumePost(jsonPost({ reason: "test reason" })),
    },
    {
      name: "POST /governance/strategies",
      safeMessage: "failed to register strategy version",
      arrange: () => vi.mocked(registerStrategyVersion).mockRejectedValue(INTERNAL),
      invoke: () => strategiesPost(jsonPost({ strategyName: "s1" })),
    },
    {
      name: "POST /governance/approvals/[id]",
      safeMessage: "failed to review approval",
      arrange: () => vi.mocked(reviewDeployApproval).mockRejectedValue(INTERNAL),
      invoke: () => approvalsPost(jsonPost({ action: "approve" }), approvalCtx("appr_1")),
    },
    {
      name: "GET /ops/actions",
      safeMessage: "failed to load action catalog",
      arrange: () =>
        vi.mocked(getActionsCatalog).mockImplementation(() => {
          throw INTERNAL;
        }),
      invoke: () => actionsGet(),
    },
    {
      name: "POST /ops/actions",
      safeMessage: "action execution failed",
      arrange: () => vi.mocked(executeAction).mockRejectedValue(INTERNAL),
      invoke: () => actionsPost(jsonPost({ action: "refreshHealth" })),
    },
  ] as const;

  it.each(CASES)("$name", async ({ safeMessage, arrange, invoke }) => {
    arrange();
    const res = await invoke();
    expect(res.status).toBe(500);
    const body = await res.json();

    // Generic safe envelope: stable message + fresh correlation id, no detail.
    expect(body.error).toBe(safeMessage);
    expect(body.correlationId).toMatch(UUID_RE);
    expect(body.detail).toBeUndefined();
    // No fragment of the internal failure on ANY field.
    const raw = JSON.stringify(body);
    expect(raw).not.toContain("ECONNREFUSED");
    expect(raw).not.toContain("db-internal");
    expect(raw).not.toContain("nexus_prod");

    // The original error is logged exactly once, tagged with the SAME id.
    expect(errorSpy).toHaveBeenCalledTimes(1);
    const call = errorSpy.mock.calls[0] ?? [];
    expect(String(call[0])).toContain(body.correlationId);
    expect(call[1]).toBe(INTERNAL);
  });
});

describe("typed client errors are unchanged (no correlation id, nothing logged)", () => {
  it("kill: missing reason → 400 with the validation message", async () => {
    const res = await killPost(jsonPost({}));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "a non-empty 'reason' is required" });
    expect(vi.mocked(engageKill)).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("resume: malformed JSON body → 400 'invalid JSON body'", async () => {
    const res = await resumePost(jsonPost("{ not json"));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid JSON body" });
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("strategies: GovernanceValidationError → 400 with the error's own message", async () => {
    vi.mocked(registerStrategyVersion).mockRejectedValue(
      new GovernanceValidationError("rationale is required"),
    );
    const res = await strategiesPost(jsonPost({ strategyName: "s1" }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "rationale is required" });
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("strategies: GovernanceConflictError → 409 with the error's own message", async () => {
    vi.mocked(registerStrategyVersion).mockRejectedValue(
      new GovernanceConflictError("identical version already pending"),
    );
    const res = await strategiesPost(jsonPost({ strategyName: "s1" }));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "identical version already pending" });
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("approvals: GovernanceValidationError → 400, GovernanceConflictError → 409", async () => {
    vi.mocked(reviewDeployApproval).mockRejectedValue(
      new GovernanceValidationError("action must be approve or reject"),
    );
    const bad = await approvalsPost(jsonPost({ action: "??" }), approvalCtx("appr_1"));
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: "action must be approve or reject" });

    vi.mocked(reviewDeployApproval).mockRejectedValue(
      new GovernanceConflictError("approval already decided"),
    );
    const conflict = await approvalsPost(jsonPost({ action: "approve" }), approvalCtx("appr_1"));
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toEqual({ error: "approval already decided" });
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("approvals: malformed id → 400 before the governance layer is reached", async () => {
    const res = await approvalsPost(jsonPost({ action: "approve" }), approvalCtx("bad id!"));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("invalid 'id'");
    expect(vi.mocked(reviewDeployApproval)).not.toHaveBeenCalled();
  });

  it("ops/actions: unknown action → 400 listing the valid actions", async () => {
    const res = await actionsPost(jsonPost({ action: "dropTables" }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("unknown or missing action");
    expect(body.correlationId).toBeUndefined();
    expect(vi.mocked(executeAction)).not.toHaveBeenCalled();
  });
});

describe("success envelope unchanged", () => {
  it("kill: 200 with { data, generatedAt } and nothing logged", async () => {
    const payload = { engaged: true } as never;
    vi.mocked(engageKill).mockResolvedValue(payload);
    const res = await killPost(jsonPost({ reason: "quarterly drill" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual({ engaged: true });
    expect(typeof body.generatedAt).toBe("string");
    expect(body.correlationId).toBeUndefined();
    expect(vi.mocked(engageKill)).toHaveBeenCalledWith("op-alice", "quarterly drill");
    expect(errorSpy).not.toHaveBeenCalled();
  });
});
