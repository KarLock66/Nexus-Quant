import { NextResponse } from "next/server";
import { getTradePlans } from "@/lib/trade-plan";

/**
 * GET /api/v1/signals/trade-plan — the actionable TradePlan per active symbol (Phase 10C-1):
 * decision summary, execution checklist, risk checklist, invalidation triggers and readiness,
 * derived on-read from the served TradingDecision + live runtime state. Optional
 * ?symbol=BTC-PERP,ETH-PERP filter. ApiEnvelope only.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    const raw = new URL(request.url).searchParams.get("symbol");
    const symbols = raw
      ? raw.split(",").map((s) => s.trim()).filter((s) => s.length > 0)
      : undefined;
    const data = await getTradePlans(symbols);
    return NextResponse.json({ data, generatedAt: new Date().toISOString() });
  } catch (err) {
    return NextResponse.json(
      { error: "failed to load trade plans", detail: String(err) },
      { status: 500 },
    );
  }
}
