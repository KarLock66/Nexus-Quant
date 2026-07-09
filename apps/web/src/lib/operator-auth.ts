import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { isRegisteredOperatorId } from "@/lib/operator-registry";
import { SESSION_COOKIE, verifySession } from "@/lib/session";

/**
 * Identity guard for the MUTATING control-plane / governance routes (B2).
 *
 * The B1 middleware already requires a valid operator session to reach any
 * /api/v1/* route; this re-verifies that session IN-HANDLER (defense in depth)
 * and returns the AUTHENTICATED operator identity. Mutations use that identity
 * as their audit `actor` and four-eyes principal, replacing the former
 * self-declared `body.actor` — a client string that let one caller attribute an
 * action to any name and approve their own strategy deployment (defeating
 * separation of duties).
 *
 * The session was minted at /login from a specific operator's token (see
 * lib/operator-identity.ts), so `operatorId` is an authenticated principal, not
 * a claim. Distinct operators hold distinct tokens -> distinct identities ->
 * four-eyes is real.
 *
 * B3 — membership re-check: a session outlives registry edits by up to its TTL
 * (12h), so a valid signature alone is not enough on the mutation path. The
 * subject must ALSO still be present in the operator registry (Edge-safe parse,
 * lib/operator-registry.ts); a de-registered operator's live session gets 403
 * immediately instead of mutating until cookie expiry.
 *
 * Usage (first lines of every mutating handler):
 *   const auth = await requireOperatorSession();
 *   if (auth instanceof NextResponse) return auth;
 *   // auth.operatorId is the authenticated actor
 */

export interface OperatorAuth {
  operatorId: string;
}

export async function requireOperatorSession(): Promise<OperatorAuth | NextResponse> {
  const store = await cookies();
  const claims = await verifySession(store.get(SESSION_COOKIE)?.value);
  if (claims === null) {
    return NextResponse.json(
      { error: "unauthenticated: a valid operator session is required" },
      { status: 401 },
    );
  }
  if (!isRegisteredOperatorId(claims.sub)) {
    return NextResponse.json(
      { error: "forbidden: operator is no longer registered" },
      { status: 403 },
    );
  }
  return { operatorId: claims.sub };
}
