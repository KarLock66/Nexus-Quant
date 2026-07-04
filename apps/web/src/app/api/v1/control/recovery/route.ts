import { NextResponse } from "next/server";
import { getRecoveryView } from "@/lib/control";

/** GET /api/v1/control/recovery — recovery status for protected components (Section E). */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  try {
    const data = await getRecoveryView();
    return NextResponse.json({ data, generatedAt: new Date().toISOString() });
  } catch (err) {
    return NextResponse.json({ error: "failed to load recovery status", detail: String(err) }, { status: 500 });
  }
}
