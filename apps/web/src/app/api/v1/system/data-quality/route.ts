import { NextResponse } from "next/server";
import { getDataQualitySummary } from "@/lib/system-monitoring";

/** GET /api/v1/system/data-quality — DQ score, pass/fail rate, per-stage health, worst checks. */
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const data = await getDataQualitySummary();
    return NextResponse.json({ data, generatedAt: new Date().toISOString() });
  } catch (err) {
    return NextResponse.json(
      { error: "failed to load data quality summary", detail: String(err) },
      { status: 500 },
    );
  }
}
