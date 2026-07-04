import { NextResponse } from "next/server";
import { getAlerts } from "@/lib/ops-alerts";

/** GET /api/v1/ops/alerts — evaluate + persist monitoring alerts (Section E). */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  try {
    const data = await getAlerts();
    return NextResponse.json({ data, generatedAt: new Date().toISOString() });
  } catch (err) {
    return NextResponse.json(
      { error: "failed to evaluate alerts", detail: String(err) },
      { status: 500 },
    );
  }
}
