import { NextResponse } from "next/server";
import { getAuditTrail } from "@/lib/control";

/** GET /api/v1/control/audit?q=&action=&limit= — searchable immutable audit trail (Section H). */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: Request) {
  try {
    const sp = new URL(req.url).searchParams;
    const q = sp.get("q") ?? undefined;
    const action = sp.get("action") ?? undefined;
    const limitRaw = sp.get("limit");
    const limit = limitRaw ? Number.parseInt(limitRaw, 10) : undefined;
    const data = await getAuditTrail({
      ...(q ? { q } : {}),
      ...(action ? { action } : {}),
      ...(limit && Number.isFinite(limit) ? { limit } : {}),
    });
    return NextResponse.json({ data, generatedAt: new Date().toISOString() });
  } catch (err) {
    return NextResponse.json({ error: "failed to load audit trail", detail: String(err) }, { status: 500 });
  }
}
