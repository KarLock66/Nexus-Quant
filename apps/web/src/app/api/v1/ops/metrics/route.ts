import { NextResponse } from "next/server";
import { getRuntimeMetrics } from "@/lib/ops";

/** GET /api/v1/ops/metrics — runtime throughput / queue / risk metrics (Section F). */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  try {
    const data = await getRuntimeMetrics();
    return NextResponse.json({ data, generatedAt: new Date().toISOString() });
  } catch (err) {
    return NextResponse.json(
      { error: "failed to load runtime metrics", detail: String(err) },
      { status: 500 },
    );
  }
}
