/**
 * B4 — operator membership re-validation on the read path (Edge middleware).
 * Contract: a valid session whose subject is still registered passes through; a
 * valid session whose subject was de-registered is treated exactly like an
 * unauthenticated request (API -> 401 envelope, page -> /login redirect); the
 * legacy single-operator identity keeps working; the public auth endpoints stay
 * reachable without a session.
 */

import { NextRequest } from "next/server";
import { afterEach, describe, expect, it } from "vitest";
import { SESSION_COOKIE, createSession } from "@/lib/session";
import { middleware } from "./middleware";

const SECRET = "test-secret-value";

function makeRequest(path: string, sessionToken?: string): NextRequest {
  return new NextRequest(`http://localhost:4000${path}`, {
    headers: sessionToken === undefined ? {} : { cookie: `${SESSION_COOKIE}=${sessionToken}` },
  });
}

async function sessionFor(sub: string): Promise<string> {
  const token = await createSession(sub);
  expect(token).not.toBeNull();
  return token!;
}

function expectPassThrough(res: Response): void {
  // NextResponse.next() marks the response for the router to continue.
  expect(res.headers.get("x-middleware-next")).toBe("1");
}

function expectLoginRedirect(res: Response, nextPath: string): void {
  expect(res.status).toBeGreaterThanOrEqual(300);
  expect(res.status).toBeLessThan(400);
  const location = new URL(res.headers.get("location")!);
  expect(location.pathname).toBe("/login");
  expect(location.searchParams.get("next")).toBe(nextPath);
}

afterEach(() => {
  delete process.env.NEXTAUTH_SECRET;
  delete process.env.OPERATORS;
  delete process.env.OPS_CONTROL_TOKEN;
});

describe("middleware auth gate", () => {
  it("lets a registered operator through on API and page routes", async () => {
    process.env.NEXTAUTH_SECRET = SECRET;
    process.env.OPERATORS = "alice:tok-alice,bob:tok-bob";
    const token = await sessionFor("alice");
    expectPassThrough(await middleware(makeRequest("/api/v1/signals", token)));
    expectPassThrough(await middleware(makeRequest("/", token)));
  });

  it("returns the 401 envelope on API routes for a de-registered operator", async () => {
    process.env.NEXTAUTH_SECRET = SECRET;
    process.env.OPERATORS = "alice:tok-alice,bob:tok-bob";
    const token = await sessionFor("alice");
    expectPassThrough(await middleware(makeRequest("/api/v1/signals", token)));

    // Operator removed AFTER login: the cookie is still cryptographically
    // valid, but reads must stop immediately (not at cookie expiry).
    process.env.OPERATORS = "bob:tok-bob";
    const res = await middleware(makeRequest("/api/v1/signals", token));
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.status).toBe("error");
    expect(body.data).toBeNull();
    expect(body.error).toContain("unauthenticated");
  });

  it("redirects page routes to /login for a de-registered operator", async () => {
    process.env.NEXTAUTH_SECRET = SECRET;
    process.env.OPERATORS = "alice:tok-alice";
    const token = await sessionFor("alice");
    process.env.OPERATORS = "bob:tok-bob";
    expectLoginRedirect(await middleware(makeRequest("/", token)), "/");
  });

  it("keeps the legacy single-operator identity working (OPS_CONTROL_TOKEN)", async () => {
    process.env.NEXTAUTH_SECRET = SECRET;
    process.env.OPS_CONTROL_TOKEN = "legacy-shared";
    const token = await sessionFor("operator");
    expectPassThrough(await middleware(makeRequest("/api/v1/portfolio", token)));
    expectPassThrough(await middleware(makeRequest("/", token)));
  });

  it("revokes a legacy 'operator' session after migrating to a named registry", async () => {
    process.env.NEXTAUTH_SECRET = SECRET;
    process.env.OPS_CONTROL_TOKEN = "legacy-shared";
    const token = await sessionFor("operator");

    process.env.OPERATORS = "alice:tok-alice";
    expect((await middleware(makeRequest("/api/v1/signals", token))).status).toBe(401);
    expectLoginRedirect(await middleware(makeRequest("/", token)), "/");
  });

  it("still rejects requests with no session at all (B1 behavior preserved)", async () => {
    process.env.NEXTAUTH_SECRET = SECRET;
    process.env.OPERATORS = "alice:tok-alice";
    expect((await middleware(makeRequest("/api/v1/signals"))).status).toBe(401);
    expectLoginRedirect(await middleware(makeRequest("/governance")), "/governance");
  });

  it("keeps the public auth endpoints reachable without a session", async () => {
    process.env.NEXTAUTH_SECRET = SECRET;
    process.env.OPERATORS = "alice:tok-alice";
    expectPassThrough(await middleware(makeRequest("/api/v1/auth/login")));
    expectPassThrough(await middleware(makeRequest("/api/v1/auth/logout")));
  });
});
