import { NextResponse } from "next/server";
import { getConsensus } from "@/lib/trading-decision";

/**
 * GET /api/v1/signals/consensus?symbol=BTC-PERP — multi-timeframe consensus (Section D)
 * for one symbol, computed only from timeframes that have a persisted FeatureSnapshot.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  const symbol = new URL(request.url).searchParams.get("symbol")?.trim();
  if (!symbol) {
    return NextResponse.json({ error: "symbol query parameter is required" }, { status: 400 });
  }
  try {
    const data = await getConsensus(symbol);
    return NextResponse.json({ data, generatedAt: new Date().toISOString() });
  } catch (err) {
    return NextResponse.json(
      { error: "failed to load consensus", detail: String(err) },
      { status: 500 },
    );
  }
}
