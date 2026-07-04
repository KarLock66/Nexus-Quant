import { NextResponse } from "next/server";
import { getProtectionView } from "@/lib/control";

/** GET /api/v1/control/protection — active protection events + protected components (Section D). */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  try {
    const data = await getProtectionView();
    return NextResponse.json({ data, generatedAt: new Date().toISOString() });
  } catch (err) {
    return NextResponse.json({ error: "failed to load protection state", detail: String(err) }, { status: 500 });
  }
}
