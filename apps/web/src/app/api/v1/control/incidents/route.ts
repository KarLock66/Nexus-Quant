import { NextResponse } from "next/server";
import { getIncidentTimeline } from "@/lib/control";
import type { IncidentWindow } from "@/lib/control-types";
import { canonicalTimestamp, parseEnumParam } from "@/lib/api-validate";

/**
 * GET /api/v1/control/incidents?window=1h|24h|7d|30d — incident timeline (Section G).
 * `window` is validated strictly (Phase 11C): absent defaults to 24h, but an
 * unknown value is a 400 — not a silent coercion to the default.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const WINDOWS: readonly IncidentWindow[] = ["1h", "24h", "7d", "30d"];

export async function GET(req: Request) {
  const window = parseEnumParam(
    new URL(req.url).searchParams.get("window"),
    "window",
    WINDOWS,
    "24h",
  );
  if (!window.ok) return NextResponse.json({ error: window.error }, { status: 400 });
  try {
    const data = await getIncidentTimeline(window.value);
    return NextResponse.json({ data, generatedAt: canonicalTimestamp() });
  } catch (err) {
    return NextResponse.json({ error: "failed to load incident timeline", detail: String(err) }, { status: 500 });
  }
}
