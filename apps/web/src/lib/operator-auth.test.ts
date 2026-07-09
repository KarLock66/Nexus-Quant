/**
 * B3 — operator membership re-validation on the mutation path. Contract:
 * requireOperatorSession() returns the authenticated operator ONLY while that
 * operator is still present in the registry. No/invalid session -> 401; a
 * cryptographically valid session whose subject was since de-registered -> 403
 * (a registry edit revokes live sessions immediately, not at cookie expiry).
 */

import { NextResponse } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { requireOperatorSession } from "./operator-auth";
import { SESSION_COOKIE, createSession } from "./session";

const cookieJar = vi.hoisted(() => ({ value: undefined as string | undefined }));

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      name === SESSION_COOKIE && cookieJar.value !== undefined
        ? { name, value: cookieJar.value }
        : undefined,
  }),
}));

const SECRET = "test-secret-value";

async function loginAs(sub: string): Promise<void> {
  const token = await createSession(sub);
  expect(token).not.toBeNull();
  cookieJar.value = token!;
}

afterEach(() => {
  cookieJar.value = undefined;
  delete process.env.NEXTAUTH_SECRET;
  delete process.env.OPERATORS;
  delete process.env.OPS_CONTROL_TOKEN;
});

describe("requireOperatorSession", () => {
  it("returns 401 when no session cookie is present", async () => {
    process.env.NEXTAUTH_SECRET = SECRET;
    process.env.OPERATORS = "alice:tok-alice";
    const auth = await requireOperatorSession();
    expect(auth).toBeInstanceOf(NextResponse);
    expect((auth as NextResponse).status).toBe(401);
  });

  it("returns the authenticated operator while it is still registered", async () => {
    process.env.NEXTAUTH_SECRET = SECRET;
    process.env.OPERATORS = "alice:tok-alice,bob:tok-bob";
    await loginAs("alice");
    expect(await requireOperatorSession()).toEqual({ operatorId: "alice" });
  });

  it("returns 403 for a valid session whose operator was de-registered", async () => {
    process.env.NEXTAUTH_SECRET = SECRET;
    process.env.OPERATORS = "alice:tok-alice,bob:tok-bob";
    await loginAs("alice");
    expect(await requireOperatorSession()).toEqual({ operatorId: "alice" });

    // Operator removed from the registry AFTER login: the cookie is still
    // cryptographically valid, but mutations must stop immediately.
    process.env.OPERATORS = "bob:tok-bob";
    const auth = await requireOperatorSession();
    expect(auth).toBeInstanceOf(NextResponse);
    expect((auth as NextResponse).status).toBe(403);
  });

  it("keeps the legacy single-operator identity working (OPS_CONTROL_TOKEN)", async () => {
    process.env.NEXTAUTH_SECRET = SECRET;
    process.env.OPS_CONTROL_TOKEN = "legacy-shared";
    await loginAs("operator");
    expect(await requireOperatorSession()).toEqual({ operatorId: "operator" });
  });

  it("returns 403 for a legacy 'operator' session after migrating to a named registry", async () => {
    process.env.NEXTAUTH_SECRET = SECRET;
    process.env.OPS_CONTROL_TOKEN = "legacy-shared";
    await loginAs("operator");

    process.env.OPERATORS = "alice:tok-alice";
    const auth = await requireOperatorSession();
    expect(auth).toBeInstanceOf(NextResponse);
    expect((auth as NextResponse).status).toBe(403);
  });

  it("returns 403 when the registry becomes empty (fail-closed)", async () => {
    process.env.NEXTAUTH_SECRET = SECRET;
    process.env.OPERATORS = "alice:tok-alice";
    await loginAs("alice");

    delete process.env.OPERATORS;
    const auth = await requireOperatorSession();
    expect(auth).toBeInstanceOf(NextResponse);
    expect((auth as NextResponse).status).toBe(403);
  });
});
