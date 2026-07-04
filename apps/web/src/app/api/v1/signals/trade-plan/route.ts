import { getTradePlans } from "@/lib/trade-plan";
import { firstFeatureHash, signalError, signalOk } from "@/lib/api-envelope";

/**
 * GET /api/v1/signals/trade-plan — the actionable TradePlan per active symbol (Phase 10C-1):
 * decision summary, execution checklist, risk checklist, invalidation triggers and readiness,
 * derived on-read from the served TradingDecision + live runtime state. Optional
 * ?symbol=BTC-PERP,ETH-PERP filter. Phase 11B signal envelope.
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
    return signalOk(data, {
      source: "db",
      featureHash: firstFeatureHash(
        data.plans as ReadonlyArray<{ featureHash?: string }>,
      ),
    });
  } catch (err) {
    return signalError(500, `failed to load trade plans: ${String(err)}`);
  }
}
