import { getReadiness } from "@/lib/trade-plan";
import { signalError, signalOk } from "@/lib/api-envelope";

/**
 * GET /api/v1/signals/readiness — the deterministic 0..100 readiness score + action verdict
 * per active symbol (Phase 10C-1), a lightweight subset of the trade-plan payload. Optional
 * ?symbol=BTC-PERP,ETH-PERP filter. Phase 11B signal envelope; readiness rows carry no
 * per-row featureHash, so meta.featureHash is the honest "unavailable" sentinel.
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
    return signalOk(data, { source: "db" });
  } catch (err) {
    return signalError(500, `failed to load readiness: ${String(err)}`);
  }
}
