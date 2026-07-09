import { NextResponse } from "next/server";
import {
  checkLoginAllowed,
  deriveLoginClientId,
  recordLoginFailure,
  recordLoginSuccess,
} from "@/lib/login-rate-limit";
import { operatorsConfigured, resolveOperator } from "@/lib/operator-identity";
import { SESSION_COOKIE, SESSION_TTL_SECONDS, createSession } from "@/lib/session";

/**
 * POST /api/v1/auth/login — exchange an operator token for a signed session
 * cookie (B1 read gate + B2 identity). Body: { token: string }.
 *
 * Fail-closed: 503 when no operator identities are configured, 503 when
 * NEXTAUTH_SECRET is unset (can't sign), 401 on an unknown token. On success the
 * response sets an httpOnly, SameSite=Lax session cookie carrying the RESOLVED
 * operator identity — the middleware gate then admits reads/pages, and the
 * mutating routes derive their audit `actor` from this identity (never body).
 *
 * Rate limited (B6): failed exchanges are counted in Redis-shared buckets
 * (per-client + global backstop — see lib/login-rate-limit.ts for the key and
 * trust policy) and, once over the threshold, requests are answered 429 BEFORE
 * the body is parsed or any token compared. Successful logins clear the
 * client's failure bucket, so legitimate operators are unaffected.
 *
 * This is one of the only two unauthenticated API surfaces (see middleware), so
 * its body parse is self-contained rather than depending on the shared request
 * validators.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX_TOKEN_LEN = 4096;

/**
 * Early body-size cap for this unauthenticated surface: reject on the declared
 * Content-Length before `req.json()` ever buffers the payload. Generous vs
 * MAX_TOKEN_LEN — even a 4096-char token fully \uXXXX-escaped (~24 KiB) plus
 * the JSON wrapper fits — so no valid login is falsely rejected. A missing or
 * unparseable header falls through to the parse, where the post-parse
 * MAX_TOKEN_LEN check remains as defense-in-depth.
 */
const MAX_BODY_BYTES = 32 * 1024;

export async function POST(req: Request) {
  const declaredLength = Number(req.headers.get("content-length") ?? "");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    return NextResponse.json({ error: "request body too large" }, { status: 413 });
  }

  const clientId = deriveLoginClientId(req);
  const throttle = await checkLoginAllowed(clientId);
  if (throttle.limited) {
    return NextResponse.json(
      { error: "too many failed login attempts — try again later" },
      { status: 429, headers: { "retry-after": String(throttle.retryAfterSeconds) } },
    );
  }

  if (!operatorsConfigured()) {
    return NextResponse.json(
      { error: "authentication is not configured: no operator identities on the server (fail-closed)" },
      { status: 503 },
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return NextResponse.json({ error: "request body must be a JSON object" }, { status: 400 });
  }
  const token = (body as Record<string, unknown>)["token"];
  if (typeof token !== "string" || token.trim() === "") {
    return NextResponse.json({ error: "a non-empty 'token' is required" }, { status: 400 });
  }
  if (token.length > MAX_TOKEN_LEN) {
    return NextResponse.json({ error: "invalid 'token': too long" }, { status: 400 });
  }

  const operator = resolveOperator(token);
  if (operator === null) {
    await recordLoginFailure(clientId);
    return NextResponse.json({ error: "unauthorized: invalid operator token" }, { status: 401 });
  }

  const session = await createSession(operator.id);
  if (session === null) {
    return NextResponse.json(
      { error: "authentication is not configured: NEXTAUTH_SECRET is unset on the server (fail-closed)" },
      { status: 503 },
    );
  }

  await recordLoginSuccess(clientId);

  const res = NextResponse.json({
    data: { operator: operator.id },
    generatedAt: new Date().toISOString(),
  });
  res.cookies.set(SESSION_COOKIE, session, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_TTL_SECONDS,
  });
  return res;
}
