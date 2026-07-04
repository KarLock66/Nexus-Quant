import { getTradingDecisions } from "@/lib/trading-decision";
import { firstFeatureHash, signalError, signalOk } from "@/lib/api-envelope";

/**
 * GET /api/v1/signals/decisions — the actionable TradingDecision per active symbol
 * (Section E), derived on-read from the admitted EngineSignal + live runtime state.
 * Optional ?symbol=BTC-PERP,ETH-PERP filter. Phase 11B signal envelope.
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
    return signalOk(data, {
      source: "db",
      featureHash: firstFeatureHash(data.decisions),
    });
  } catch (err) {
    return signalError(500, `failed to load trading decisions: ${String(err)}`);
  }
}
