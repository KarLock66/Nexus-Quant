import { NextResponse } from "next/server";
import { getIncidentTimeline } from "@/lib/control";
import type { IncidentWindow } from "@/lib/control-types";

/** GET /api/v1/control/incidents?window=1h|24h|7d|30d — incident timeline (Section G). */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const WINDOWS: ReadonlySet<string> = new Set<IncidentWindow>(["1h", "24h", "7d", "30d"]);

export async function GET(req: Request) {
  try {
    const raw = new URL(req.url).searchParams.get("window") ?? "24h";
    const window = (WINDOWS.has(raw) ? raw : "24h") as IncidentWindow;
    const data = await getIncidentTimeline(window);
    return NextResponse.json({ data, generatedAt: new Date().toISOString() });
  } catch (err) {
    return NextResponse.json({ error: "failed to load incident timeline", detail: String(err) }, { status: 500 });
  }
}
