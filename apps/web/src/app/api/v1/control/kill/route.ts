import { NextResponse } from "next/server";
import { engageKill } from "@/lib/control";
import { internalErrorResponse } from "@/lib/api-error";
import { requireOperatorSession } from "@/lib/operator-auth";
import {
  canonicalTimestamp,
  readJsonObject,
  requireStringField,
} from "@/lib/api-validate";

/**
 * POST /api/v1/control/kill — engage the global kill switch (Section C).
 * Requires a valid operator session (B1 middleware + in-handler check); the
 * audit `actor` is the AUTHENTICATED operator identity, never a client-supplied
 * value (B2). Body: { reason: string } — the body must be a JSON object and
 * `reason` a non-empty bounded string. The worker's control gate reads this row
 * every evaluation and blocks all execution while engaged. Records who/when/
 * reason + an immutable audit entry.
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
    const data = await engageKill(auth.operatorId, reason.value);
    return NextResponse.json({ data, generatedAt: canonicalTimestamp() });
  } catch (err) {
    // Batch 7: generic 500 — the real error stays in the server log, keyed by
    // the returned correlation id.
    return internalErrorResponse("failed to engage kill switch", err);
  }
}
