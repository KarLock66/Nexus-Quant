import { NextResponse } from "next/server";
import {
  GovernanceConflictError,
  GovernanceValidationError,
  reviewDeployApproval,
} from "@/lib/governance-actions";
import { requireOperatorAuth } from "@/lib/operator-auth";

/**
 * POST /api/v1/governance/approvals/[id] — review a PENDING strategy deploy
 * approval. Requires `Authorization: Bearer <OPS_CONTROL_TOKEN>`.
 *
 * Body: { action: "approve" | "reject", actor, note? }. Four-eyes enforced:
 * the reviewer must differ from the requester. Approve transitions the version
 * DRAFT → ACTIVE and PAUSES any other ACTIVE version of the same strategy in
 * the same transaction (single deterministic ACTIVE per strategy — what the
 * workers' lineage resolution consumes). Reviews are immutable — a decided
 * request cannot be re-reviewed.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const denied = requireOperatorAuth(req);
  if (denied) return denied;
  const { id } = await ctx.params;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const b = body as { action?: unknown; actor?: unknown; note?: unknown };
  try {
    const data = await reviewDeployApproval({
      approvalId: id,
      action: b?.action,
      actor: b?.actor,
      note: b?.note,
    });
    return NextResponse.json({ data, generatedAt: new Date().toISOString() });
  } catch (err) {
    if (err instanceof GovernanceValidationError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    if (err instanceof GovernanceConflictError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    return NextResponse.json(
      { error: "failed to review approval", detail: String(err) },
      { status: 500 },
    );
  }
}
