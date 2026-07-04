import { NextResponse } from "next/server";
import { getServiceHealth } from "@/lib/system-monitoring";

/** GET /api/v1/system/health — service health (DB, Redis, quant, workers, API). */
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const data = await getServiceHealth();
    return NextResponse.json({ data, generatedAt: new Date().toISOString() });
  } catch (err) {
    return NextResponse.json(
      { error: "failed to load service health", detail: String(err) },
      { status: 500 },
    );
  }
}
