import { getTradingDecisions } from "@/lib/trading-decision";
import { firstFeatureHash, signalError, signalOk } from "@/lib/api-envelope";
import { parseSymbolFilter } from "@/lib/api-validate";

/**
 * GET /api/v1/signals/decisions — the actionable TradingDecision per active symbol
 * (Section E), derived on-read from the admitted EngineSignal + live runtime state.
 * Optional ?symbol=BTC-PERP,ETH-PERP filter (strictly validated — malformed is a
 * 400, never a silently-narrowed filter). Phase 11B signal envelope.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  const symbols = parseSymbolFilter(
    new URL(request.url).searchParams.get("symbol"),
    "symbol",
  );
  if (!symbols.ok) return signalError(400, symbols.error);
  try {
    const data = await getTradingDecisions(symbols.value);
    return signalOk(data, {
      source: "db",
      featureHash: firstFeatureHash(data.decisions),
    });
  } catch (err) {
    return signalError(500, `failed to load trading decisions: ${String(err)}`);
  }
}
