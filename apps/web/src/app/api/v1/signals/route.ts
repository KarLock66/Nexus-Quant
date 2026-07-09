import { getLatestSignals } from "@/lib/signals";
import { firstFeatureHash, signalError, signalOk } from "@/lib/api-envelope";
import { parseBoundedInt, parseCursorId } from "@/lib/api-validate";

/**
 * GET /api/v1/signals — latest EngineSignal rows (newest first), read from Prisma.
 * Response contract: the Phase 11B signal envelope (see lib/api-envelope.ts) —
 * status/data/error/meta, no partial success, no silent empty-array masking.
 * Query params are validated strictly (lib/api-validate.ts): a malformed
 * `limit`/`offset`/`cursor` is a 400 error envelope, not a silent fallback
 * (a silent default would mask client bugs as normal traffic).
 */
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const limit = parseBoundedInt(url.searchParams.get("limit"), "limit", 1, 200, 50);
  if (!limit.ok) return signalError(400, limit.error);
  // id-cursor (preferred — drift-free) and bounded numeric offset (alternative).
  const offset = parseBoundedInt(url.searchParams.get("offset"), "offset", 0, 100_000, 0);
  if (!offset.ok) return signalError(400, offset.error);
  const cursor = parseCursorId(url.searchParams.get("cursor"), "cursor");
  if (!cursor.ok) return signalError(400, cursor.error);

  try {
    const data = await getLatestSignals(limit.value, cursor.value, offset.value);
    // nextCursor is null when the page is short (no more rows to page into).
    const nextCursor = data.length === limit.value ? data[data.length - 1]!.id : null;
    return signalOk(data, {
      source: "db",
      featureHash: firstFeatureHash(data),
      extra: { nextCursor },
    });
  } catch (err) {
    return signalError(500, `failed to load signals: ${String(err)}`);
  }
}
