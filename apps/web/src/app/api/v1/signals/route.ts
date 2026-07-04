import { NextResponse } from "next/server";
import { getLatestSignals } from "@/lib/signals";

/**
 * GET /api/v1/signals — latest EngineSignal rows (newest first), read from Prisma.
 * Query params are validated strictly: a malformed `limit`/`offset` is a 400, not
 * a silent fallback (a silent default would mask client bugs as normal traffic).
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
  if (typeof limit !== "number") return NextResponse.json(limit, { status: 400 });
  // id-cursor (preferred — drift-free) and bounded numeric offset (alternative).
  const offset = parseBoundedInt(url.searchParams.get("offset"), "offset", 0, 100_000, 0);
  if (typeof offset !== "number") return NextResponse.json(offset, { status: 400 });
  const cursorRaw = url.searchParams.get("cursor");
  if (cursorRaw !== null && cursorRaw.trim() === "") {
    return NextResponse.json({ error: "invalid 'cursor': must be a non-empty id" }, { status: 400 });
  }
  const cursor = cursorRaw ?? undefined;

  try {
    const data = await getLatestSignals(limit, cursor, offset);
    // nextCursor is null when the page is short (no more rows to page into).
    const nextCursor = data.length === limit ? data[data.length - 1]!.id : null;
    return NextResponse.json({ data, nextCursor });
  } catch (err) {
    return NextResponse.json(
      { error: "failed to load signals", detail: String(err) },
      { status: 500 },
    );
  }
}
