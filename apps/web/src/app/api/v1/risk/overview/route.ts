import { NextResponse } from "next/server";
import { getRiskOverview } from "@/lib/risk-overview";

/** GET /api/v1/risk/overview — current risk mode, hard limits, detector events,
 *  and M9 budgets, read directly from Prisma (SystemRiskState/RiskLimit/RiskEvent/RiskBudget). */
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const data = await getRiskOverview();
    return NextResponse.json({ data, generatedAt: new Date().toISOString() });
  } catch (err) {
    return NextResponse.json(
      { error: "failed to load risk overview", detail: String(err) },
      { status: 500 },
    );
  }
}
