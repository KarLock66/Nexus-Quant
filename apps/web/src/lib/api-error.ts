import { NextResponse } from "next/server";

/**
 * Batch 7 — generic 500 envelope for unexpected server errors on the mutating
 * /api/v1 routes (control/kill, control/resume, governance/strategies,
 * governance/approvals/[id], ops/actions).
 *
 * The former `detail: String(err)` leaked internals — Prisma/driver messages,
 * hostnames, ports, schema names, stack fragments — to any authenticated
 * client. An unexpected error now returns ONLY the route's stable safe message
 * plus a fresh correlation id; the ORIGINAL error is logged server-side tagged
 * with the same id, so a client report ("failed to engage kill switch,
 * ref 3f2c…") joins to the exact server log line without the response body
 * revealing anything about the failure itself.
 *
 * Typed client errors (400 validation / 409 governance conflict) never route
 * through here — this is exclusively the catch-all branch for errors the
 * handler did not anticipate.
 */

export interface InternalErrorBody {
  error: string;
  correlationId: string;
}

export function internalErrorResponse(safeMessage: string, err: unknown): NextResponse {
  const correlationId = globalThis.crypto.randomUUID();
  // The one place the real error is preserved — server log only, keyed by id.
  console.error(`[api:500] ${safeMessage} correlationId=${correlationId}`, err);
  const body: InternalErrorBody = { error: safeMessage, correlationId };
  return NextResponse.json(body, { status: 500 });
}
