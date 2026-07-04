import { getLatestSignals } from "@/lib/signals";
import { firstFeatureHash, signalError, signalOk } from "@/lib/api-envelope";

/**
 * GET /api/v1/signals — latest EngineSignal rows (newest first), read from Prisma.
 * Response contract: the Phase 11B signal envelope (see lib/api-envelope.ts) —
 * status/data/error/meta, no partial success, no silent empty-array masking.
 * Query params are validated strictly: a malformed `limit`/`offset` is a 400
 * error envelope, not a silent fallback (a silent default would mask client
 * bugs as normal traffic).
 */
export const dynamic = "force-dynamic";

/**
 * Parse an optional bounded-integer query param. Absent -> `fallback`;
 * present but not an integer in [min, max] -> an error string.
 */
function parseBoundedInt(
  raw: string | null,
  name: string,
  min: number,
  max: number,
  fallback: number,
): number | { error: string } {
  if (raw === null) return fallback;
  const trimmed = raw.trim();
  if (!/^-?\d+$/.test(trimmed)) {
    return { error: `invalid '${name}': expected an integer, got "${raw}"` };
  }
  const n = Number(trimmed);
  if (n < min || n > max) {
    return { error: `invalid '${name}': must be between ${min} and ${max}, got ${n}` };
  }
  return n;
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const limit = parseBoundedInt(url.searchParams.get("limit"), "limit", 1, 200, 50);
  if (typeof limit !== "number") return signalError(400, limit.error);
  // id-cursor (preferred — drift-free) and bounded numeric offset (alternative).
  const offset = parseBoundedInt(url.searchParams.get("offset"), "offset", 0, 100_000, 0);
  if (typeof offset !== "number") return signalError(400, offset.error);
  const cursorRaw = url.searchParams.get("cursor");
  if (cursorRaw !== null && cursorRaw.trim() === "") {
    return signalError(400, "invalid 'cursor': must be a non-empty id");
  }
  const cursor = cursorRaw ?? undefined;

  try {
    const data = await getLatestSignals(limit, cursor, offset);
    // nextCursor is null when the page is short (no more rows to page into).
    const nextCursor = data.length === limit ? data[data.length - 1]!.id : null;
    return signalOk(data, {
      source: "db",
      featureHash: firstFeatureHash(data),
      extra: { nextCursor },
    });
  } catch (err) {
    return signalError(500, `failed to load signals: ${String(err)}`);
  }
}
