import { NextResponse } from "next/server";
import { getTradingPermissionView } from "@/lib/control";

/** GET /api/v1/control/permission — live canTrade() verdict + itemized reasons (Section B). */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  try {
    const data = await getTradingPermissionView();
    return NextResponse.json({ data, generatedAt: new Date().toISOString() });
  } catch (err) {
    return NextResponse.json({ error: "failed to evaluate trading permission", detail: String(err) }, { status: 500 });
  }
}
