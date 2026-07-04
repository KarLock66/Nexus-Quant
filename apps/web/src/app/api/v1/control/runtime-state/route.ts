import { NextResponse } from "next/server";
import { getRuntimeStateView } from "@/lib/control";

/** GET /api/v1/control/runtime-state — current runtime state + last transition (Section A). */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  try {
    const data = await getRuntimeStateView();
    return NextResponse.json({ data, generatedAt: new Date().toISOString() });
  } catch (err) {
    return NextResponse.json({ error: "failed to load runtime state", detail: String(err) }, { status: 500 });
  }
}
