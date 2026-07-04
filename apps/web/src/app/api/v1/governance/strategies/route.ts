import { NextResponse } from "next/server";
import {
  GovernanceConflictError,
  GovernanceValidationError,
  registerStrategyVersion,
  type RegisterStrategyInput,
} from "@/lib/governance-actions";
import { requireOperatorAuth } from "@/lib/operator-auth";

/**
 * POST /api/v1/governance/strategies — register a strategy version (production
 * governance path). Requires `Authorization: Bearer <OPS_CONTROL_TOKEN>`
 * (fail-closed: 503 with no token configured, 401 on a bad token).
 *
 * Body: { strategyName, actor, rationale, description, hypothesis, entryLogic,
 * exitLogic, riskRules, failureConditions, parameters, validRegimes,
 * volatilityBounds } — ALL mandatory (fail-closed validation). Creates the
 * Strategy (find-or-create by name), an immutable DRAFT StrategyVersion, a
 * PENDING DEPLOY_APPROVAL request, and audit rows — it NEVER activates;
 * activation requires a second actor's approval (four-eyes).
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: Request) {
  const denied = requireOperatorAuth(req);
  if (denied) return denied;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  try {
    const data = await registerStrategyVersion(body as RegisterStrategyInput);
    return NextResponse.json(
      { data, generatedAt: new Date().toISOString() },
      { status: 201 },
    );
  } catch (err) {
    if (err instanceof GovernanceValidationError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    if (err instanceof GovernanceConflictError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    return NextResponse.json(
      { error: "failed to register strategy version", detail: String(err) },
      { status: 500 },
    );
  }
}
