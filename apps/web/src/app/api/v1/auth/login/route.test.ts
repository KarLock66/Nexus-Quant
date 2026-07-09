/**
 * Batch 5 — login request body cap. Contract: a request declaring an oversized
 * Content-Length is rejected 413 BEFORE the body is parsed; a normal login
 * (with or without a Content-Length header) is unaffected; malformed JSON,
 * oversized tokens, and unknown tokens keep their existing envelopes.
 *
 * Batch 6 — login rate limiting. Contract: repeated FAILED token exchanges
 * trip a 429 (checked before any token is compared), a successful login below
 * the limit works and resets the client's bucket, and distinct clients are
 * throttled independently. These route tests run the limiter in its in-process
 * mode (REDIS_URL cleared); the Redis wire protocol and shared-state behavior
 * are covered in lib/login-rate-limit.test.ts.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetLoginRateLimitState } from "@/lib/login-rate-limit";
import { SESSION_COOKIE } from "@/lib/session";
import { POST } from "./route";

const SECRET = "test-secret-value";
const URL = "http://localhost:4000/api/v1/auth/login";

function configureAuth(): void {
  process.env.NEXTAUTH_SECRET = SECRET;
  process.env.OPERATORS = "alice:tok-alice";
}

function loginRequest(body: string, headers: Record<string, string> = {}): Request {
  return new Request(URL, { method: "POST", body, headers });
}

beforeEach(() => {
  // Hermetic: a developer/CI REDIS_URL must not leak real Redis I/O into these
  // tests, and every test starts with clean in-process throttle state.
  delete process.env.REDIS_URL;
  resetLoginRateLimitState();
});

afterEach(() => {
  delete process.env.NEXTAUTH_SECRET;
  delete process.env.OPERATORS;
  delete process.env.OPS_CONTROL_TOKEN;
  delete process.env.LOGIN_RATE_LIMIT_MAX_FAILURES;
  delete process.env.LOGIN_RATE_LIMIT_GLOBAL_MAX_FAILURES;
  delete process.env.LOGIN_RATE_LIMIT_WINDOW_SECONDS;
  delete process.env.LOGIN_RATE_LIMIT_TRUST_PROXY;
  resetLoginRateLimitState();
});

describe("POST /api/v1/auth/login body cap", () => {
  it("rejects an oversized Content-Length with 413 before parsing the body", async () => {
    configureAuth();
    // The declared length is what must trigger rejection — the body here is a
    // stream that throws if anything tries to read it, proving the guard runs
    // before `req.json()`.
    const poison = new ReadableStream<Uint8Array>({
      pull() {
        throw new Error("body was read: the size guard did not reject first");
      },
    });
    const req = new Request(URL, {
      method: "POST",
      body: poison,
      headers: { "content-length": String(1024 * 1024) },
      // @ts-expect-error duplex is required by undici for stream bodies but not in lib.dom types
      duplex: "half",
    });
    const res = await POST(req);
    expect(res.status).toBe(413);
    expect((await res.json()).error).toContain("too large");
  });

  it("rejects a Content-Length just over the cap and accepts one at the cap", async () => {
    configureAuth();
    const over = await POST(
      loginRequest(JSON.stringify({ token: "tok-alice" }), { "content-length": String(32 * 1024 + 1) }),
    );
    expect(over.status).toBe(413);

    // At (not over) the cap the request proceeds to normal auth.
    const at = await POST(
      loginRequest(JSON.stringify({ token: "tok-alice" }), { "content-length": String(32 * 1024) }),
    );
    expect(at.status).toBe(200);
  });

  it("accepts a normal login and sets the session cookie", async () => {
    configureAuth();
    const res = await POST(loginRequest(JSON.stringify({ token: "tok-alice" })));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.operator).toBe("alice");
    expect(res.headers.get("set-cookie")).toContain(SESSION_COOKIE);
  });

  it("does not break a valid login when Content-Length is absent", async () => {
    configureAuth();
    // A programmatic Request does not carry a Content-Length header — assert
    // that precondition, then that login still succeeds.
    const req = loginRequest(JSON.stringify({ token: "tok-alice" }));
    expect(req.headers.get("content-length")).toBeNull();
    const res = await POST(req);
    expect(res.status).toBe(200);
  });

  it("ignores an unparseable Content-Length (falls through to normal handling)", async () => {
    configureAuth();
    const res = await POST(
      loginRequest(JSON.stringify({ token: "tok-alice" }), { "content-length": "not-a-number" }),
    );
    expect(res.status).toBe(200);
  });

  it("keeps the malformed-JSON 400 envelope unchanged", async () => {
    configureAuth();
    const res = await POST(loginRequest("{ not json"));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid JSON body");
  });

  it("keeps the post-parse MAX_TOKEN_LEN check as defense-in-depth", async () => {
    configureAuth();
    // 5000 chars is over MAX_TOKEN_LEN (4096) but the whole body is well under
    // MAX_BODY_BYTES, so it must reach and trip the post-parse check.
    const res = await POST(loginRequest(JSON.stringify({ token: "x".repeat(5000) })));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("too long");
  });

  it("keeps the 401 envelope for an unknown token", async () => {
    configureAuth();
    const res = await POST(loginRequest(JSON.stringify({ token: "tok-wrong" })));
    expect(res.status).toBe(401);
    expect((await res.json()).error).toContain("invalid operator token");
  });

  it("keeps the fail-closed 503 when no operators are configured", async () => {
    const res = await POST(loginRequest(JSON.stringify({ token: "tok-alice" })));
    expect(res.status).toBe(503);
    expect((await res.json()).error).toContain("no operator identities");
  });
});

describe("POST /api/v1/auth/login rate limiting", () => {
  beforeEach(() => {
    configureAuth();
    process.env.LOGIN_RATE_LIMIT_MAX_FAILURES = "3";
  });

  it("repeated failed logins trigger 429 with a safe envelope and Retry-After", async () => {
    for (let i = 0; i < 3; i++) {
      const res = await POST(loginRequest(JSON.stringify({ token: "tok-wrong" })));
      expect(res.status).toBe(401);
    }
    const limited = await POST(loginRequest(JSON.stringify({ token: "tok-wrong" })));
    expect(limited.status).toBe(429);
    // Safe envelope: the standard { error } shape, no infrastructure detail.
    expect(await limited.json()).toEqual({
      error: "too many failed login attempts — try again later",
    });
    expect(limited.headers.get("retry-after")).toBe("900");
  });

  it("throttles BEFORE authentication: even a valid token is refused once limited", async () => {
    for (let i = 0; i < 3; i++) {
      await POST(loginRequest(JSON.stringify({ token: "tok-wrong" })));
    }
    const res = await POST(loginRequest(JSON.stringify({ token: "tok-alice" })));
    expect(res.status).toBe(429);
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("successful login below the limit still works and resets the failure count", async () => {
    for (let i = 0; i < 2; i++) {
      await POST(loginRequest(JSON.stringify({ token: "tok-wrong" })));
    }
    const ok = await POST(loginRequest(JSON.stringify({ token: "tok-alice" })));
    expect(ok.status).toBe(200);
    expect((await ok.json()).data.operator).toBe("alice");

    // Reset proof: three MORE failures fit before the next 429 — without the
    // reset the first of these would already have been throttled.
    for (let i = 0; i < 3; i++) {
      const res = await POST(loginRequest(JSON.stringify({ token: "tok-wrong" })));
      expect(res.status).toBe(401);
    }
    const limited = await POST(loginRequest(JSON.stringify({ token: "tok-wrong" })));
    expect(limited.status).toBe(429);
  });

  it("separate clients have independent limits", async () => {
    process.env.LOGIN_RATE_LIMIT_TRUST_PROXY = "1";
    const asClient = (ip: string, token: string) =>
      POST(loginRequest(JSON.stringify({ token }), { "x-forwarded-for": ip }));

    for (let i = 0; i < 3; i++) await asClient("203.0.113.9", "tok-wrong");
    expect((await asClient("203.0.113.9", "tok-alice")).status).toBe(429);
    // The neighbor is untouched and can still log in.
    expect((await asClient("198.51.100.7", "tok-alice")).status).toBe(200);
  });

  it("malformed requests do not count toward the failure limit", async () => {
    for (let i = 0; i < 5; i++) {
      expect((await POST(loginRequest("{ not json"))).status).toBe(400);
    }
    expect((await POST(loginRequest(JSON.stringify({ token: "tok-alice" })))).status).toBe(200);
  });
});
