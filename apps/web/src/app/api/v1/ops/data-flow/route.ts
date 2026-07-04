import { NextResponse } from "next/server";
import { getDataFlowMonitor } from "@/lib/ops";

/** GET /api/v1/ops/data-flow — live data-flow freshness per stream (Section B). */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  try {
    const data = await getDataFlowMonitor();
    return NextResponse.json({ data, generatedAt: new Date().toISOString() });
  } catch (err) {
    return NextResponse.json(
      { error: "failed to load data-flow monitor", detail: String(err) },
      { status: 500 },
    );
  }
}
