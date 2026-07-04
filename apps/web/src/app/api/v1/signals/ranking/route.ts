import { getOpportunityBoard } from "@/lib/trading-decision";
import { signalError, signalOk } from "@/lib/api-envelope";

/**
 * GET /api/v1/signals/ranking — the opportunity board (Section F): every active
 * TradingDecision deterministically scored and bucketed into Top Long / Top Short /
 * Watchlist / Blocked / Waiting. Phase 11B signal envelope; the ranked rows carry
 * no per-row featureHash, so meta.featureHash is the honest "unavailable" sentinel.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  try {
    const data = await getOpportunityBoard();
    return signalOk(data, { source: "db" });
  } catch (err) {
    return signalError(500, `failed to load opportunity ranking: ${String(err)}`);
  }
}
