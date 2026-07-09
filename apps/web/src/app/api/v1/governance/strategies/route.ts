import { NextResponse } from "next/server";
import {
  GovernanceConflictError,
  GovernanceValidationError,
  registerStrategyVersion,
  type RegisterStrategyInput,
} from "@/lib/governance-actions";
import { internalErrorResponse } from "@/lib/api-error";
import { requireOperatorSession } from "@/lib/operator-auth";
import { canonicalTimestamp, readJsonObject } from "@/lib/api-validate";

/**
 * POST /api/v1/governance/strategies — register a strategy version (production
 * governance path). Requires a valid operator session (B1 middleware +
 * in-handler check).
 *
 * Body: { strategyName, rationale, description, hypothesis, entryLogic,
 * exitLogic, riskRules, failureConditions, parameters, validRegimes,
 * volatilityBounds } — ALL mandatory (fail-closed validation). The requesting
 * `actor` is the AUTHENTICATED operator identity (B2), so a version's requester
 * is bound to a real principal and cannot be spoofed to satisfy four-eyes at
 * approval time. Creates the Strategy (find-or-create by name), an immutable
 * DRAFT StrategyVersion, a PENDING DEPLOY_APPROVAL request, and audit rows — it
 * NEVER activates; activation requires a DIFFERENT operator's approval.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: Request) {
  const auth = await requireOperatorSession();
  if (auth instanceof NextResponse) return auth;
  const body = await readJsonObject(req);
  if (!body.ok) return NextResponse.json({ error: body.error }, { status: 400 });
  try {
    const data = await registerStrategyVersion({
      ...(body.value as unknown as RegisterStrategyInput),
      actor: auth.operatorId,
    });
    return NextResponse.json(
      { data, generatedAt: canonicalTimestamp() },
      { status: 201 },
    );
  } catch (err) {
    if (err instanceof GovernanceValidationError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    if (err instanceof GovernanceConflictError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    // Batch 7: generic 500 — the real error stays in the server log, keyed by
    // the returned correlation id.
    return internalErrorResponse("failed to register strategy version", err);
  }
}
