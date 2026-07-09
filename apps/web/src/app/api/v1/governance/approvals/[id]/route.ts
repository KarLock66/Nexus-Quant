import { NextResponse } from "next/server";
import {
  GovernanceConflictError,
  GovernanceValidationError,
  reviewDeployApproval,
} from "@/lib/governance-actions";
import { internalErrorResponse } from "@/lib/api-error";
import { requireOperatorSession } from "@/lib/operator-auth";
import { canonicalTimestamp, parseResourceId, readJsonObject } from "@/lib/api-validate";

/**
 * POST /api/v1/governance/approvals/[id] — review a PENDING strategy deploy
 * approval. Requires a valid operator session (B1 middleware + in-handler check).
 *
 * Body: { action: "approve" | "reject", note? }. Four-eyes enforced against the
 * AUTHENTICATED reviewer identity (B2): the reviewer must differ from the
 * requester, and `actor` is the session identity — a self-declared body.actor can
 * no longer impersonate a second operator to self-approve. Approve transitions
 * the version DRAFT → ACTIVE and PAUSES any other ACTIVE version of the same
 * strategy in the same transaction (single deterministic ACTIVE per strategy —
 * what the workers' lineage resolution consumes). Reviews are immutable — a
 * decided request cannot be re-reviewed.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireOperatorSession();
  if (auth instanceof NextResponse) return auth;
  const { id } = await ctx.params;
  const approvalId = parseResourceId(id, "id");
  if (!approvalId.ok) return NextResponse.json({ error: approvalId.error }, { status: 400 });
  const body = await readJsonObject(req);
  if (!body.ok) return NextResponse.json({ error: body.error }, { status: 400 });
  try {
    const data = await reviewDeployApproval({
      approvalId: approvalId.value,
      action: body.value["action"],
      actor: auth.operatorId,
      note: body.value["note"],
    });
    return NextResponse.json({ data, generatedAt: canonicalTimestamp() });
  } catch (err) {
    if (err instanceof GovernanceValidationError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    if (err instanceof GovernanceConflictError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    // Batch 7: generic 500 — the real error stays in the server log, keyed by
    // the returned correlation id.
    return internalErrorResponse("failed to review approval", err);
  }
}
