import { NextResponse } from "next/server";
import { getSystemHealth } from "@/lib/system-health";

/** GET /api/v1/ops/health — aggregated platform health (Section A). */
export const dynamic = "force-dynamic";
export const runtime = "nodejs"; // node:net Redis probe + Prisma

export async function GET() {
  try {
    const data = await getSystemHealth();
    return NextResponse.json({ data, generatedAt: new Date().toISOString() });
  } catch (err) {
    return NextResponse.json(
      { error: "failed to aggregate system health", detail: String(err) },
      { status: 500 },
    );
  }
}
