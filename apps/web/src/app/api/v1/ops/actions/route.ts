import { NextResponse } from "next/server";
import { executeAction, getActionsCatalog } from "@/lib/ops";
import { internalErrorResponse } from "@/lib/api-error";
import { requireOperatorSession } from "@/lib/operator-auth";
import type { OperatorActionId } from "@/lib/ops-types";
import { canonicalTimestamp, readJsonObject } from "@/lib/api-validate";

/**
 * GET  /api/v1/ops/actions — the guarded operator-action catalog (Section D).
 * POST /api/v1/ops/actions — execute a single action: { action: OperatorActionId }.
 * The POST requires a valid operator session (B1 middleware + in-handler check).
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
    return NextResponse.json({ data, generatedAt: canonicalTimestamp() });
  } catch (err) {
    // Batch 7: generic 500 — the real error stays in the server log, keyed by
    // the returned correlation id.
    return internalErrorResponse("failed to load action catalog", err);
  }
}

export async function POST(req: Request) {
  const auth = await requireOperatorSession();
  if (auth instanceof NextResponse) return auth;
  const body = await readJsonObject(req);
  if (!body.ok) return NextResponse.json({ error: body.error }, { status: 400 });
  const action = body.value["action"];
  if (typeof action !== "string" || !VALID_ACTIONS.has(action)) {
    return NextResponse.json(
      { error: `unknown or missing action; expected one of ${[...VALID_ACTIONS].join(", ")}` },
      { status: 400 },
    );
  }
  try {
    const data = await executeAction(action as OperatorActionId);
    // A refused (disabled) action is a valid 200 response carrying ok:false.
    return NextResponse.json({ data, generatedAt: canonicalTimestamp() });
  } catch (err) {
    // Batch 7: generic 500 — the real error stays in the server log, keyed by
    // the returned correlation id.
    return internalErrorResponse("action execution failed", err);
  }
}
