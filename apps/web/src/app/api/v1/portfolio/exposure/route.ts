import { NextResponse } from "next/server";
import { getPortfolioExposure } from "@/lib/portfolio";

/**
 * GET /api/v1/portfolio/exposure — the Phase 10C-2A portfolio book sliced every documented way
 * (by symbol / side / regime / state / confidence / risk) plus the deterministic risk-heat
 * score. Derived on-read from the served TradingDecision + TradePlan outputs. ApiEnvelope.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  try {
    const data = await getPortfolioExposure();
    return NextResponse.json({ data, generatedAt: new Date().toISOString() });
  } catch (err) {
    return NextResponse.json(
      { error: "failed to load portfolio exposure", detail: String(err) },
      { status: 500 },
    );
  }
}
