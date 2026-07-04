import { NextResponse } from "next/server";
import { getConnectorStatus } from "@/lib/system-monitoring";

/** GET /api/v1/system/connectors — per-exchange connector liveness from MarketCandle freshness. */
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const data = await getConnectorStatus();
    return NextResponse.json({ data, generatedAt: new Date().toISOString() });
  } catch (err) {
    return NextResponse.json(
      { error: "failed to load connector status", detail: String(err) },
      { status: 500 },
    );
  }
}
