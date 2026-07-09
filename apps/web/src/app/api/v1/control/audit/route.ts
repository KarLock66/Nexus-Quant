import { NextResponse } from "next/server";
import { getAuditTrail } from "@/lib/control";
import { canonicalTimestamp, parseBoundedInt, parseOptionalString } from "@/lib/api-validate";

/**
 * GET /api/v1/control/audit?q=&action=&limit= — searchable immutable audit trail
 * (Section H). Query params are validated strictly (Phase 11C): a malformed
 * `limit`/`q`/`action` is a 400, not a silently-ignored filter.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: Request) {
  const sp = new URL(req.url).searchParams;
  const q = parseOptionalString(sp.get("q"), "q", 200);
  if (!q.ok) return NextResponse.json({ error: q.error }, { status: 400 });
  const action = parseOptionalString(sp.get("action"), "action", 200);
  if (!action.ok) return NextResponse.json({ error: action.error }, { status: 400 });
  // 100 is the lib default; 500 the lib's hard cap — same effective range as before.
  const limit = parseBoundedInt(sp.get("limit"), "limit", 1, 500, 100);
  if (!limit.ok) return NextResponse.json({ error: limit.error }, { status: 400 });

  try {
    const data = await getAuditTrail({
      ...(q.value !== undefined ? { q: q.value } : {}),
      ...(action.value !== undefined ? { action: action.value } : {}),
      limit: limit.value,
    });
    return NextResponse.json({ data, generatedAt: canonicalTimestamp() });
  } catch (err) {
    return NextResponse.json({ error: "failed to load audit trail", detail: String(err) }, { status: 500 });
  }
}
