import { NextResponse } from "next/server";
import { getDashboardOverview } from "@/lib/dashboard";

/** GET /api/v1/dashboard/overview — portfolio-overview composite (risk mode, signal
 *  activity, latest portfolio snapshot, strategy registry, data quality), from Prisma. */
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const data = await getDashboardOverview();
    return NextResponse.json({ data, generatedAt: new Date().toISOString() });
  } catch (err) {
    return NextResponse.json(
      { error: "failed to load dashboard overview", detail: String(err) },
      { status: 500 },
    );
  }
}
