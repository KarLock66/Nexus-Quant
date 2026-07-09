/**
 * Batch 7 — generic 500 envelope for unexpected server errors.
 *
 * Contract: the client receives ONLY { error: <safe message>, correlationId }
 * — never `detail`, never String(err) — while the original error is logged
 * server-side tagged with the SAME correlation id, so a client report joins to
 * the exact server log line.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { internalErrorResponse } from "./api-error";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const spyOnConsoleError = () => vi.spyOn(console, "error").mockImplementation(() => {});
let errorSpy: ReturnType<typeof spyOnConsoleError>;

beforeEach(() => {
  errorSpy = spyOnConsoleError();
});

afterEach(() => {
  errorSpy.mockRestore();
});

describe("internalErrorResponse", () => {
  it("returns 500 with ONLY the safe message and a correlation id", async () => {
    const res = internalErrorResponse(
      "failed to do the thing",
      new Error("connect ECONNREFUSED db-internal.nexus.local:5432"),
    );
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(Object.keys(body).sort()).toEqual(["correlationId", "error"]);
    expect(body.error).toBe("failed to do the thing");
    expect(body.correlationId).toMatch(UUID_RE);
    expect(JSON.stringify(body)).not.toContain("ECONNREFUSED");
    expect(JSON.stringify(body)).not.toContain("db-internal");
  });

  it("logs the ORIGINAL error tagged with the returned correlation id", async () => {
    const original = new Error("prisma P1001 — cannot reach database server");
    const res = internalErrorResponse("safe message", original);
    const { correlationId } = await res.json();
    expect(errorSpy).toHaveBeenCalledTimes(1);
    const call = errorSpy.mock.calls[0] ?? [];
    expect(String(call[0])).toContain(correlationId);
    expect(call[1]).toBe(original);
  });

  it("mints a fresh correlation id per error", async () => {
    const a = await internalErrorResponse("safe", new Error("x")).json();
    const b = await internalErrorResponse("safe", new Error("x")).json();
    expect(a.correlationId).not.toBe(b.correlationId);
  });

  it("never leaks non-Error throwables either", async () => {
    const res = internalErrorResponse("safe", "raw failure password=hunter2");
    const body = await res.json();
    expect(res.status).toBe(500);
    expect(JSON.stringify(body)).not.toContain("hunter2");
  });
});
