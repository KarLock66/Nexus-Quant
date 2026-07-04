import { NextResponse } from "next/server";
import { getQueueMetrics } from "@/lib/system-monitoring";

/** GET /api/v1/system/queues — queue depth, throughput, workers, dead-letter from JobRun. */
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const data = await getQueueMetrics();
    return NextResponse.json({ data, generatedAt: new Date().toISOString() });
  } catch (err) {
    return NextResponse.json(
      { error: "failed to load queue metrics", detail: String(err) },
      { status: 500 },
    );
  }
}
