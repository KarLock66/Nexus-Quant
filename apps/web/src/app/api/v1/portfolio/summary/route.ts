import { NextResponse } from "next/server";
import { getPortfolioSummary } from "@/lib/portfolio";

/**
 * GET /api/v1/portfolio/summary — the Phase 10C-2A portfolio top-line: exposure, trade counts,
 * capital/risk used + remaining, overall status, plus statistics and capital allocation. Derived
 * on-read from the served TradingDecision + TradePlan outputs (consumed verbatim). ApiEnvelope.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  try {
    const data = await getPortfolioSummary();
    return NextResponse.json({ data, generatedAt: new Date().toISOString() });
  } catch (err) {
    return NextResponse.json(
      { error: "failed to load portfolio summary", detail: String(err) },
      { status: 500 },
    );
  }
}
