/**
 * Batch 6 — login rate limiter. Contracts under test:
 *   - client identity derivation follows the documented XFF trust policy;
 *   - failures below the threshold are allowed, at the threshold limited;
 *   - a successful login resets the client's bucket; clients are independent;
 *   - the global backstop bounds aggregate failures across spoofed identities;
 *   - Redis mode speaks real RESP over TCP and the state is SHARED (verified
 *     against a fake Redis server: counters visible across "instances", keys
 *     hashed, TTLs attached, AUTH sent when the URL carries a password);
 *   - a dead Redis degrades to per-instance memory throttling (never a lockout,
 *     never unbounded).
 */

import net from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  checkLoginAllowed,
  deriveLoginClientId,
  recordLoginFailure,
  recordLoginSuccess,
  resetLoginRateLimitState,
} from "./login-rate-limit";

const RATE_ENV_KEYS = [
  "LOGIN_RATE_LIMIT_MAX_FAILURES",
  "LOGIN_RATE_LIMIT_GLOBAL_MAX_FAILURES",
  "LOGIN_RATE_LIMIT_WINDOW_SECONDS",
  "LOGIN_RATE_LIMIT_TRUST_PROXY",
  "REDIS_URL",
] as const;

function clearRateEnv(): void {
  for (const k of RATE_ENV_KEYS) delete process.env[k];
}

function reqWithXff(xff?: string): Request {
  const headers: Record<string, string> = {};
  if (xff !== undefined) headers["x-forwarded-for"] = xff;
  return new Request("http://localhost:4000/api/v1/auth/login", { method: "POST", headers });
}

beforeEach(() => {
  clearRateEnv();
  resetLoginRateLimitState();
});

afterEach(() => {
  clearRateEnv();
  resetLoginRateLimitState();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

// ─────────────────── client identity derivation ───────────────────

describe("deriveLoginClientId", () => {
  it("returns 'direct' when no x-forwarded-for header is present", () => {
    expect(deriveLoginClientId(reqWithXff())).toBe("direct");
  });

  it("returns 'direct' for a blank header", () => {
    expect(deriveLoginClientId(reqWithXff("  ,  "))).toBe("direct");
  });

  it("uses the FIRST entry by default (untrusted best-effort key)", () => {
    expect(deriveLoginClientId(reqWithXff("203.0.113.9, 10.0.0.1"))).toBe("203.0.113.9");
  });

  it("uses the LAST entry when LOGIN_RATE_LIMIT_TRUST_PROXY=1 (proxy-attested)", () => {
    process.env.LOGIN_RATE_LIMIT_TRUST_PROXY = "1";
    expect(deriveLoginClientId(reqWithXff("spoofed, 203.0.113.9"))).toBe("203.0.113.9");
  });

  it("trims whitespace and lowercases", () => {
    expect(deriveLoginClientId(reqWithXff("  2001:DB8::1  "))).toBe("2001:db8::1");
  });
});

// ─────────────────── memory mode (no REDIS_URL) ───────────────────

describe("limiter in memory mode", () => {
  beforeEach(() => {
    process.env.LOGIN_RATE_LIMIT_MAX_FAILURES = "3";
  });

  it("allows below the threshold and limits at it", async () => {
    for (let i = 0; i < 2; i++) await recordLoginFailure("1.2.3.4");
    expect((await checkLoginAllowed("1.2.3.4")).limited).toBe(false);

    await recordLoginFailure("1.2.3.4");
    const verdict = await checkLoginAllowed("1.2.3.4");
    expect(verdict.limited).toBe(true);
    expect(verdict.retryAfterSeconds).toBe(900); // default window
  });

  it("a successful login resets the client's failure bucket", async () => {
    for (let i = 0; i < 3; i++) await recordLoginFailure("1.2.3.4");
    expect((await checkLoginAllowed("1.2.3.4")).limited).toBe(true);

    await recordLoginSuccess("1.2.3.4");
    expect((await checkLoginAllowed("1.2.3.4")).limited).toBe(false);
  });

  it("separate clients have independent limits", async () => {
    for (let i = 0; i < 3; i++) await recordLoginFailure("1.2.3.4");
    expect((await checkLoginAllowed("1.2.3.4")).limited).toBe(true);
    expect((await checkLoginAllowed("5.6.7.8")).limited).toBe(false);
  });

  it("the global backstop limits even a never-seen identity (spoof-rotation bound)", async () => {
    process.env.LOGIN_RATE_LIMIT_MAX_FAILURES = "100";
    process.env.LOGIN_RATE_LIMIT_GLOBAL_MAX_FAILURES = "5";
    for (let i = 0; i < 5; i++) await recordLoginFailure(`rotating-${i}`);
    expect((await checkLoginAllowed("fresh-identity")).limited).toBe(true);
  });

  it("global backstop can be disabled with 0", async () => {
    process.env.LOGIN_RATE_LIMIT_MAX_FAILURES = "100";
    process.env.LOGIN_RATE_LIMIT_GLOBAL_MAX_FAILURES = "0";
    for (let i = 0; i < 20; i++) await recordLoginFailure(`rotating-${i}`);
    expect((await checkLoginAllowed("fresh-identity")).limited).toBe(false);
  });

  it("the window expires: attempts are allowed again after WINDOW_SECONDS", async () => {
    vi.useFakeTimers();
    process.env.LOGIN_RATE_LIMIT_WINDOW_SECONDS = "60";
    for (let i = 0; i < 3; i++) await recordLoginFailure("1.2.3.4");
    expect((await checkLoginAllowed("1.2.3.4")).limited).toBe(true);

    vi.advanceTimersByTime(61_000);
    expect((await checkLoginAllowed("1.2.3.4")).limited).toBe(false);
  });
});

// ─────────────────── fake Redis (real RESP over TCP) ───────────────────

interface FakeEntry {
  value: number;
  expiresAt: number | null;
}

interface FakeRedis {
  port: number;
  data: Map<string, FakeEntry>;
  commandLog: string[][];
  close(): Promise<void>;
}

/** Parse as many complete RESP command arrays as the buffer holds. */
function parseRespCommands(buf: Buffer): { commands: string[][]; rest: Buffer } {
  const commands: string[][] = [];
  let off = 0;
  for (;;) {
    const save = off;
    const nl = buf.indexOf("\r\n", off);
    if (nl < 0 || buf[off] !== 0x2a /* '*' */) break;
    const argc = Number(buf.toString("utf8", off + 1, nl));
    off = nl + 2;
    const parts: string[] = [];
    let complete = true;
    for (let i = 0; i < argc; i++) {
      const lnl = buf.indexOf("\r\n", off);
      if (lnl < 0 || buf[off] !== 0x24 /* '$' */) {
        complete = false;
        break;
      }
      const len = Number(buf.toString("utf8", off + 1, lnl));
      const start = lnl + 2;
      if (buf.length < start + len + 2) {
        complete = false;
        break;
      }
      parts.push(buf.toString("utf8", start, start + len));
      off = start + len + 2;
    }
    if (!complete) {
      off = save;
      break;
    }
    commands.push(parts);
  }
  return { commands, rest: buf.subarray(off) };
}

/**
 * Minimal Redis stand-in for the exact command set the limiter uses:
 * AUTH / GET / DEL and the EVAL incr-with-ttl script (executed by semantics,
 * not by running Lua). Shared `data` map = the "shared state" under test.
 */
function startFakeRedis(): Promise<FakeRedis> {
  const data = new Map<string, FakeEntry>();
  const commandLog: string[][] = [];

  const live = (key: string): FakeEntry | null => {
    const e = data.get(key);
    if (!e) return null;
    if (e.expiresAt !== null && e.expiresAt <= Date.now()) {
      data.delete(key);
      return null;
    }
    return e;
  };

  const execute = (cmd: string[]): string => {
    const name = (cmd[0] ?? "").toUpperCase();
    if (name === "AUTH") return "+OK\r\n";
    if (name === "GET") {
      const e = live(cmd[1] ?? "");
      if (!e) return "$-1\r\n";
      const s = String(e.value);
      return `$${s.length}\r\n${s}\r\n`;
    }
    if (name === "DEL") {
      const key = cmd[1] ?? "";
      const had = live(key) !== null;
      data.delete(key);
      return `:${had ? 1 : 0}\r\n`;
    }
    if (name === "EVAL") {
      // [EVAL, script, "1", key, ttlSeconds] — emulate the incr-with-ttl script.
      const key = cmd[3] ?? "";
      const ttl = Number(cmd[4] ?? "0");
      const e = live(key);
      const next = e ? e.value + 1 : 1;
      data.set(key, { value: next, expiresAt: e ? e.expiresAt : Date.now() + ttl * 1_000 });
      return `:${next}\r\n`;
    }
    return "-ERR unknown command\r\n";
  };

  return new Promise((resolve) => {
    const server = net.createServer((socket) => {
      let buf: Buffer = Buffer.alloc(0);
      socket.on("data", (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        const { commands, rest } = parseRespCommands(buf);
        buf = rest;
        for (const cmd of commands) {
          commandLog.push(cmd);
          socket.write(execute(cmd));
        }
      });
      socket.on("error", () => socket.destroy());
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as net.AddressInfo;
      resolve({
        port: address.port,
        data,
        commandLog,
        close: () =>
          new Promise<void>((done) => {
            server.close(() => done());
          }),
      });
    });
  });
}

/** Grab a loopback port with nothing listening on it. */
function closedPort(): Promise<number> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as net.AddressInfo).port;
      server.close(() => resolve(port));
    });
  });
}

describe("limiter in Redis mode", () => {
  let fake: FakeRedis;

  beforeEach(async () => {
    fake = await startFakeRedis();
    process.env.REDIS_URL = `redis://127.0.0.1:${fake.port}`;
    process.env.LOGIN_RATE_LIMIT_MAX_FAILURES = "3";
  });

  afterEach(async () => {
    await fake.close();
  });

  it("shares state: failures recorded by one instance limit the client on another", async () => {
    for (let i = 0; i < 3; i++) await recordLoginFailure("203.0.113.9");

    // Wipe the in-process store — the ONLY place the counts can now live is
    // the fake Redis, exactly as for a second web instance with cold memory.
    resetLoginRateLimitState();
    expect((await checkLoginAllowed("203.0.113.9")).limited).toBe(true);
    expect((await checkLoginAllowed("198.51.100.7")).limited).toBe(false);
  });

  it("stores counters under hashed keys with a TTL, in the login namespace", async () => {
    await recordLoginFailure("203.0.113.9");
    const keys = [...fake.data.keys()];
    // per-client bucket + global backstop
    expect(keys).toHaveLength(2);
    for (const key of keys) {
      expect(key.startsWith("nexus:web:login:fail:")).toBe(true);
      expect(key).not.toContain("203.0.113.9");
    }
    for (const entry of fake.data.values()) {
      expect(entry.value).toBe(1);
      expect(entry.expiresAt).not.toBeNull();
      // default window: 900s from now (generous tolerance)
      expect(entry.expiresAt! - Date.now()).toBeGreaterThan(890_000);
      expect(entry.expiresAt! - Date.now()).toBeLessThanOrEqual(900_000);
    }
  });

  it("a successful login deletes the client bucket in Redis but keeps the global one", async () => {
    for (let i = 0; i < 2; i++) await recordLoginFailure("203.0.113.9");
    expect(fake.data.size).toBe(2);

    await recordLoginSuccess("203.0.113.9");
    expect(fake.data.size).toBe(1);
    expect([...fake.data.keys()]).toEqual(["nexus:web:login:fail:global"]);
    expect((await checkLoginAllowed("203.0.113.9")).limited).toBe(false);
  });

  it("sends AUTH first when the URL carries a password", async () => {
    process.env.REDIS_URL = `redis://:s3cret@127.0.0.1:${fake.port}`;
    await recordLoginFailure("203.0.113.9");
    const auth = fake.commandLog.find((c) => (c[0] ?? "").toUpperCase() === "AUTH");
    expect(auth).toEqual(["AUTH", "s3cret"]);
    // and the failure still landed
    expect(fake.data.size).toBe(2);
  });

  it("degrades to per-instance memory throttling when Redis is unreachable", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    process.env.REDIS_URL = `redis://127.0.0.1:${await closedPort()}`;

    // No lockout: the check itself still answers (degraded, not fail-closed)…
    expect((await checkLoginAllowed("203.0.113.9")).limited).toBe(false);
    // …and no unbounded bypass: memory still enforces the threshold.
    for (let i = 0; i < 3; i++) await recordLoginFailure("203.0.113.9");
    expect((await checkLoginAllowed("203.0.113.9")).limited).toBe(true);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("degraded"));
  });
});
