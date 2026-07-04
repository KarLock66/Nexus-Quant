import { NextResponse } from "next/server";
import { getRunbooksView } from "@/lib/control";

/** GET /api/v1/control/runbooks — operator runbook catalog + applicable runbooks (Section F). */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  try {
    const data = await getRunbooksView();
    return NextResponse.json({ data, generatedAt: new Date().toISOString() });
  } catch (err) {
    return NextResponse.json({ error: "failed to load runbooks", detail: String(err) }, { status: 500 });
  }
}
