import { NextResponse } from "next/server";
import { getGovernanceOverview } from "@/lib/governance";

/** GET /api/v1/governance/overview — strategy registry, approval queue, and audit
 *  trail read directly from Prisma (Strategy/StrategyVersion/ApprovalRequest/AuditLog). */
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const data = await getGovernanceOverview();
    return NextResponse.json({ data, generatedAt: new Date().toISOString() });
  } catch (err) {
    return NextResponse.json(
      { error: "failed to load governance overview", detail: String(err) },
      { status: 500 },
    );
  }
}
