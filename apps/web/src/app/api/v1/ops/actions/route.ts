import { NextResponse } from "next/server";
import { executeAction, getActionsCatalog } from "@/lib/ops";
import { requireOperatorAuth } from "@/lib/operator-auth";
import type { OperatorActionId } from "@/lib/ops-types";

/**
 * GET  /api/v1/ops/actions — the guarded operator-action catalog (Section D).
 * POST /api/v1/ops/actions — execute a single action: { action: OperatorActionId }.
 * The POST requires `Authorization: Bearer <OPS_CONTROL_TOKEN>` (fail-closed: 503
 * when the server has no token configured, 401 on a bad/missing token).
 *
 * Actions are non-destructive and never mutate the database. Restart actions are
 * refused unless an external control channel is configured.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const VALID_ACTIONS: ReadonlySet<string> = new Set<OperatorActionId>([
  "refreshHealth",
  "rerunHealthChecks",
  "clearStaleStatus",
  "restartIngestion",
  "restartWorkers",
]);

export async function GET() {
  try {
    const data = getActionsCatalog();
    return NextResponse.json({ data, generatedAt: new Date().toISOString() });
  } catch (err) {
    return NextResponse.json(
      { error: "failed to load action catalog", detail: String(err) },
      { status: 500 },
    );
  }
}

export async function POST(req: Request) {
  const denied = requireOperatorAuth(req);
  if (denied) return denied;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const action = (body as { action?: unknown })?.action;
  if (typeof action !== "string" || !VALID_ACTIONS.has(action)) {
    return NextResponse.json(
      { error: `unknown or missing action; expected one of ${[...VALID_ACTIONS].join(", ")}` },
      { status: 400 },
    );
  }
  try {
    const data = await executeAction(action as OperatorActionId);
    // A refused (disabled) action is a valid 200 response carrying ok:false.
    return NextResponse.json({ data, generatedAt: new Date().toISOString() });
  } catch (err) {
    return NextResponse.json(
      { error: "action execution failed", detail: String(err) },
      { status: 500 },
    );
  }
}
