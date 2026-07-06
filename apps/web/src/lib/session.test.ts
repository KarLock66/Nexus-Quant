/**
 * B1 — signed operator-session tokens. Contract: a token minted with the
 * configured secret verifies and yields its claims; a tampered payload, wrong
 * secret, expired, or malformed token verifies to null; with no secret nothing
 * can be minted or verified (fail-closed).
 */

import { afterEach, describe, expect, it } from "vitest";
import { SESSION_TTL_SECONDS, createSession, verifySession } from "./session";

const SECRET = "test-secret-value";

afterEach(() => {
  delete process.env.NEXTAUTH_SECRET;
});

describe("session", () => {
  it("round-trips a valid session and returns its claims", async () => {
    process.env.NEXTAUTH_SECRET = SECRET;
    const token = await createSession("alice", 1_000);
    expect(token).not.toBeNull();
    const claims = await verifySession(token, 1_001);
    expect(claims).not.toBeNull();
    expect(claims!.sub).toBe("alice");
    expect(claims!.iat).toBe(1_000);
    expect(claims!.exp).toBe(1_000 + SESSION_TTL_SECONDS);
  });

  it("rejects an expired token", async () => {
    process.env.NEXTAUTH_SECRET = SECRET;
    const token = await createSession("alice", 1_000);
    expect(await verifySession(token, 1_000 + SESSION_TTL_SECONDS)).toBeNull();
    expect(await verifySession(token, 1_000 + SESSION_TTL_SECONDS + 1)).toBeNull();
  });

  it("rejects a tampered payload", async () => {
    process.env.NEXTAUTH_SECRET = SECRET;
    const token = (await createSession("alice", 1_000))!;
    const [, sig] = token.split(".");
    // Forge a different subject with the original signature.
    const forgedPayload = Buffer.from(JSON.stringify({ sub: "attacker", iat: 1_000, exp: 9_999_999_999 }))
      .toString("base64url");
    expect(await verifySession(`${forgedPayload}.${sig}`, 1_001)).toBeNull();
  });

  it("rejects a token signed with a different secret", async () => {
    process.env.NEXTAUTH_SECRET = SECRET;
    const token = await createSession("alice", 1_000);
    process.env.NEXTAUTH_SECRET = "a-different-secret";
    expect(await verifySession(token, 1_001)).toBeNull();
  });

  it("rejects malformed tokens", async () => {
    process.env.NEXTAUTH_SECRET = SECRET;
    expect(await verifySession(undefined, 1_001)).toBeNull();
    expect(await verifySession("", 1_001)).toBeNull();
    expect(await verifySession("no-dot", 1_001)).toBeNull();
    expect(await verifySession(".sig", 1_001)).toBeNull();
    expect(await verifySession("payload.", 1_001)).toBeNull();
  });

  it("fails closed with no secret configured (mint and verify both null)", async () => {
    delete process.env.NEXTAUTH_SECRET;
    expect(await createSession("alice", 1_000)).toBeNull();
    // Even a token that WOULD be valid under a secret cannot verify without one.
    process.env.NEXTAUTH_SECRET = SECRET;
    const token = await createSession("alice", 1_000);
    delete process.env.NEXTAUTH_SECRET;
    expect(await verifySession(token, 1_001)).toBeNull();
  });
});
