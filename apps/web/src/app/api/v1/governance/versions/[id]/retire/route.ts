import { NextResponse } from "next/server";
import {
  GovernanceConflictError,
  GovernanceValidationError,
  retireStrategyVersion,
} from "@/lib/governance-actions";
import { requireOperatorAuth } from "@/lib/operator-auth";

/**
 * POST /api/v1/governance/versions/[id]/retire — retire a strategy version
 * (terminal, audited). Requires `Authorization: Bearer <OPS_CONTROL_TOKEN>`.
 * Body: { actor, reason }. A retired version never resolves as lineage again.
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
  const b = body as { actor?: unknown; reason?: unknown };
  try {
    const data = await retireStrategyVersion({ versionId: id, actor: b?.actor, reason: b?.reason });
    return NextResponse.json({ data, generatedAt: new Date().toISOString() });
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
