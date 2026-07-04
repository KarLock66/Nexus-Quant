import { NextResponse } from "next/server";
import { getTradingDecisions } from "@/lib/trading-decision";

/**
 * GET /api/v1/signals/decisions — the actionable TradingDecision per active symbol
 * (Section E), derived on-read from the admitted EngineSignal + live runtime state.
 * Optional ?symbol=BTC-PERP,ETH-PERP filter.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    const raw = new URL(request.url).searchParams.get("symbol");
    const symbols = raw
      ? raw.split(",").map((s) => s.trim()).filter((s) => s.length > 0)
      : undefined;
    const data = await getTradingDecisions(symbols);
    return NextResponse.json({ data, generatedAt: new Date().toISOString() });
  } catch (err) {
    return NextResponse.json(
      { error: "failed to load trading decisions", detail: String(err) },
      { status: 500 },
    );
  }
}
