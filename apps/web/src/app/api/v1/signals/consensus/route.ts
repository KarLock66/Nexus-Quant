import { getConsensus } from "@/lib/trading-decision";
import { signalError, signalOk } from "@/lib/api-envelope";

/**
 * GET /api/v1/signals/consensus?symbol=BTC-PERP — multi-timeframe consensus (Section D)
 * for one symbol, computed only from timeframes that have a persisted FeatureSnapshot.
 * Phase 11B signal envelope.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  const symbol = new URL(request.url).searchParams.get("symbol")?.trim();
  if (!symbol) {
    return signalError(400, "symbol query parameter is required");
  }
  try {
    const data = await getConsensus(symbol);
    return signalOk(data, { source: "db" });
  } catch (err) {
    return signalError(500, `failed to load consensus: ${String(err)}`);
  }
}
