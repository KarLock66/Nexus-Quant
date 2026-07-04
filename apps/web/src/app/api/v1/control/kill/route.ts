import { NextResponse } from "next/server";
import { engageKill } from "@/lib/control";
import { requireOperatorAuth } from "@/lib/operator-auth";

/**
 * POST /api/v1/control/kill — engage the global kill switch (Section C).
 * Requires `Authorization: Bearer <OPS_CONTROL_TOKEN>` (fail-closed: refused with
 * 503 when the server has no token configured, 401 on a bad/missing token).
 * Body: { actor?: string, reason: string }. The worker's control gate reads this row
 * every evaluation and blocks all execution while engaged. Records who/when/reason +
 * an immutable audit entry.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: Request) {
  const denied = requireOperatorAuth(req);
  if (denied) return denied;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const reason = (body as { reason?: unknown })?.reason;
  const actorRaw = (body as { actor?: unknown })?.actor;
  if (typeof reason !== "string" || reason.trim() === "") {
    return NextResponse.json({ error: "a non-empty 'reason' is required" }, { status: 400 });
  }
  const actor = typeof actorRaw === "string" && actorRaw.trim() !== "" ? actorRaw : "operator";
  try {
    const data = await engageKill(actor, reason);
    return NextResponse.json({ data, generatedAt: new Date().toISOString() });
  } catch (err) {
    return NextResponse.json({ error: "failed to engage kill switch", detail: String(err) }, { status: 500 });
  }
}
