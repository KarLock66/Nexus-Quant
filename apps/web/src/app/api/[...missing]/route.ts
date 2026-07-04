import { NextResponse } from "next/server";

/**
 * Catch-all for unknown /api/* paths. Every real route is a more specific
 * segment and always wins; anything that falls through here gets a JSON 404
 * instead of the HTML not-found page, so API clients never have to parse HTML
 * to learn an endpoint does not exist.
 */
export const dynamic = "force-dynamic";

function notFound(req: Request): NextResponse {
  const { pathname } = new URL(req.url);
  return NextResponse.json(
    { error: "not found", detail: `no API route at ${pathname}` },
    { status: 404 },
  );
}

export const GET = notFound;
export const POST = notFound;
export const PUT = notFound;
export const PATCH = notFound;
export const DELETE = notFound;
export const HEAD = notFound;
