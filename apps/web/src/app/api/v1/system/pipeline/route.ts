import { NextResponse } from "next/server";
import { getPipelineStatus } from "@/lib/system-monitoring";

/** GET /api/v1/system/pipeline — ingest → DQ → feature → signal flow state. */
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const data = await getPipelineStatus();
    return NextResponse.json({ data, generatedAt: new Date().toISOString() });
  } catch (err) {
    return NextResponse.json(
      { error: "failed to load pipeline status", detail: String(err) },
      { status: 500 },
    );
  }
}
