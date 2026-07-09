import { NextResponse } from "next/server";
import { resumeKill } from "@/lib/control";
import { internalErrorResponse } from "@/lib/api-error";
import { requireOperatorSession } from "@/lib/operator-auth";
import {
  canonicalTimestamp,
  readJsonObject,
  requireStringField,
} from "@/lib/api-validate";

/**
 * POST /api/v1/control/resume — disengage the global kill switch (Section C). The
 * runtime never auto-resumes a manual kill — only this explicit operator action clears
 * it. Requires a valid operator session (B1 middleware + in-handler check); the audit
 * `actor` is the AUTHENTICATED operator identity, never a client-supplied value (B2).
 * Body: { reason: string } — same rules as /control/kill. Records an immutable audit
 * entry.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: Request) {
  const auth = await requireOperatorSession();
  if (auth instanceof NextResponse) return auth;
  const body = await readJsonObject(req);
  if (!body.ok) return NextResponse.json({ error: body.error }, { status: 400 });
  const reason = requireStringField(body.value, "reason", 2000);
  if (!reason.ok) return NextResponse.json({ error: reason.error }, { status: 400 });
  try {
    const data = await resumeKill(auth.operatorId, reason.value);
    return NextResponse.json({ data, generatedAt: canonicalTimestamp() });
  } catch (err) {
    // Batch 7: generic 500 — the real error stays in the server log, keyed by
    // the returned correlation id.
    return internalErrorResponse("failed to resume", err);
  }
}
