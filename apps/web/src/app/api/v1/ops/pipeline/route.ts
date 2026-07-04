import { NextResponse } from "next/server";
import { getOpsPipeline } from "@/lib/ops";

/** GET /api/v1/ops/pipeline — 8-stage pipeline status (Section C). */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  try {
    const data = await getOpsPipeline();
    return NextResponse.json({ data, generatedAt: new Date().toISOString() });
  } catch (err) {
    return NextResponse.json(
      { error: "failed to load pipeline status", detail: String(err) },
      { status: 500 },
    );
  }
}
