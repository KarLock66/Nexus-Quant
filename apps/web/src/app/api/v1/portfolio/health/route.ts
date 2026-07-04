import { NextResponse } from "next/server";
import { getPortfolioHealth } from "@/lib/portfolio";

/**
 * GET /api/v1/portfolio/health — the Phase 10C-2A portfolio overall verdict
 * (HEALTHY / CAUTION / RISK / BLOCKED) + the deterministic portfolio warnings. Derived on-read
 * from the served TradingDecision + TradePlan outputs + live control/runtime. ApiEnvelope.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  try {
    const data = await getPortfolioHealth();
    return NextResponse.json({ data, generatedAt: new Date().toISOString() });
  } catch (err) {
    return NextResponse.json(
      { error: "failed to load portfolio health", detail: String(err) },
      { status: 500 },
    );
  }
}
