import { getConsensus } from "@/lib/trading-decision";
import { signalError, signalOk } from "@/lib/api-envelope";
import { parseRequiredSymbol } from "@/lib/api-validate";

/**
 * GET /api/v1/signals/consensus?symbol=BTC-PERP — multi-timeframe consensus (Section D)
 * for one symbol, computed only from timeframes that have a persisted FeatureSnapshot.
 * Phase 11B signal envelope.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  const symbol = parseRequiredSymbol(
    new URL(request.url).searchParams.get("symbol"),
    "symbol",
  );
  if (!symbol.ok) return signalError(400, symbol.error);
  try {
    const data = await getConsensus(symbol.value);
    return signalOk(data, { source: "db" });
  } catch (err) {
    return signalError(500, `failed to load consensus: ${String(err)}`);
  }
}
