import { NextResponse } from "next/server";
import {
  GovernanceConflictError,
  GovernanceValidationError,
  retireStrategyVersion,
} from "@/lib/governance-actions";
import { requireOperatorSession } from "@/lib/operator-auth";
import { canonicalTimestamp, parseResourceId, readJsonObject } from "@/lib/api-validate";

/**
 * POST /api/v1/governance/versions/[id]/retire — retire a strategy version
 * (terminal, audited). Requires a valid operator session (B1 middleware +
 * in-handler check); the audit `actor` is the AUTHENTICATED operator identity,
 * never a client-supplied value (B2). Body: { reason }. A retired version never
 * resolves as lineage again.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireOperatorSession();
  if (auth instanceof NextResponse) return auth;
  const { id } = await ctx.params;
  const versionId = parseResourceId(id, "id");
  if (!versionId.ok) return NextResponse.json({ error: versionId.error }, { status: 400 });
  const body = await readJsonObject(req);
  if (!body.ok) return NextResponse.json({ error: body.error }, { status: 400 });
  try {
    const data = await retireStrategyVersion({
      versionId: versionId.value,
      actor: auth.operatorId,
      reason: body.value["reason"],
    });
    return NextResponse.json({ data, generatedAt: canonicalTimestamp() });
  } catch (err) {
    if (err instanceof GovernanceValidationError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    if (err instanceof GovernanceConflictError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    return NextResponse.json(
      { error: "failed to retire strategy version", detail: String(err) },
      { status: 500 },
    );
  }
}
