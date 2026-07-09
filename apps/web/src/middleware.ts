import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { isRegisteredOperatorId } from "@/lib/operator-registry";
import { SESSION_COOKIE, verifySession } from "@/lib/session";

/**
 * Fail-closed authentication gate for the operator console (B1).
 *
 * Every `/api/v1/*` request and every dashboard page must carry a valid signed
 * session cookie (see lib/session.ts). Unauthenticated:
 *   - API  -> 401 JSON (machine-readable; the poll/command clients surface it)
 *   - page -> 302 redirect to /login?next=<path>
 *
 * B4 — membership re-check on the READ path: a session outlives registry edits
 * by up to its TTL (12h), so a valid signature alone is not enough. The subject
 * must ALSO still be present in the operator registry (lib/operator-registry.ts,
 * Edge-safe by design — pure env parsing, no node:crypto). A de-registered
 * operator's live session is treated exactly like an unauthenticated request:
 * API -> 401, page -> login redirect. Mirrors the B3 check on the mutation path
 * (lib/operator-auth.ts).
 *
 * The login/logout endpoints and the /login page are the only unauthenticated
 * surfaces (you must be able to reach them to obtain a session). The session is
 * verified with Web Crypto so this runs in the Edge middleware runtime.
 *
 * Before this gate, every read route (portfolio, risk, signals, governance,
 * audit, control state) answered with no auth at all — a full read of live
 * trading state to anyone who could reach the web tier.
 */

const PUBLIC_API = new Set(["/api/v1/auth/login", "/api/v1/auth/logout"]);

function unauthenticatedApi(): NextResponse {
  return NextResponse.json(
    {
      status: "error",
      data: null,
      error: "unauthenticated: a valid operator session is required",
      meta: {
        source: "db",
        timestamp: new Date().toISOString(),
        featureHash: "unavailable",
      },
    },
    { status: 401 },
  );
}

export async function middleware(req: NextRequest): Promise<NextResponse> {
  const { pathname } = req.nextUrl;
  const isApi = pathname.startsWith("/api/");
  if (isApi && PUBLIC_API.has(pathname)) return NextResponse.next();

  const claims = await verifySession(req.cookies.get(SESSION_COOKIE)?.value);
  if (claims !== null && isRegisteredOperatorId(claims.sub)) return NextResponse.next();

  if (isApi) return unauthenticatedApi();

  const url = req.nextUrl.clone();
  url.pathname = "/login";
  url.search = "";
  url.searchParams.set("next", pathname);
  return NextResponse.redirect(url);
}

export const config = {
  // Gate the API surface and every dashboard page. Excluded: the /login page,
  // Next internals, and static assets (the login page's own chunks live under
  // /_next/static, so they must stay reachable while logged out).
  matcher: [
    "/api/v1/:path*",
    "/((?!api|_next/static|_next/image|favicon.ico|icon.svg|login).*)",
  ],
};
