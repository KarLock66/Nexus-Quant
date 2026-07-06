import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { SESSION_COOKIE, verifySession } from "@/lib/session";

/**
 * GET /api/v1/auth/session — report the current operator identity for the UI
 * (header badge, login-state gate). Requires a valid session (the middleware
 * gate already enforces this); returns 401 when unauthenticated so the client
 * can route to /login.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  const store = await cookies();
  const claims = await verifySession(store.get(SESSION_COOKIE)?.value);
  if (claims === null) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  return NextResponse.json({
    data: { operator: claims.sub, exp: claims.exp },
    generatedAt: new Date().toISOString(),
  });
}
