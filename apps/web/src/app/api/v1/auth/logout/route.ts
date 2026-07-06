import { NextResponse } from "next/server";
import { SESSION_COOKIE } from "@/lib/session";

/**
 * POST /api/v1/auth/logout — clear the operator session cookie. Idempotent and
 * intentionally unauthenticated (clearing your own cookie must always succeed,
 * even from an already-expired session), so it is on the middleware allow-list.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST() {
  const res = NextResponse.json({ data: { ok: true }, generatedAt: new Date().toISOString() });
  res.cookies.set(SESSION_COOKIE, "", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  });
  return res;
}
