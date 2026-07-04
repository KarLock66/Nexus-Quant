import { NextResponse } from "next/server";
import { getOpportunityBoard } from "@/lib/trading-decision";

/**
 * GET /api/v1/signals/ranking — the opportunity board (Section F): every active
 * TradingDecision deterministically scored and bucketed into Top Long / Top Short /
 * Watchlist / Blocked / Waiting.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  try {
    const data = await getOpportunityBoard();
    return NextResponse.json({ data, generatedAt: new Date().toISOString() });
  } catch (err) {
    return NextResponse.json(
      { error: "failed to load opportunity ranking", detail: String(err) },
      { status: 500 },
    );
  }
}
