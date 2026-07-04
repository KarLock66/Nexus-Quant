import { NextResponse } from "next/server";
import { getReadiness } from "@/lib/trade-plan";

/**
 * GET /api/v1/signals/readiness — the deterministic 0..100 readiness score + action verdict
 * per active symbol (Phase 10C-1), a lightweight subset of the trade-plan payload. Optional
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
    const data = await getReadiness(symbols);
    return NextResponse.json({ data, generatedAt: new Date().toISOString() });
  } catch (err) {
    return NextResponse.json(
      { error: "failed to load readiness", detail: String(err) },
      { status: 500 },
    );
  }
}
