import { createHash } from "node:crypto";
import net from "node:net";

/**
 * Batch 6 — distributed login rate limiting for POST /api/v1/auth/login.
 *
 * Counts FAILED token exchanges (401s only — malformed bodies and server-side
 * 503s never count) in Redis so the limit is shared across every web instance,
 * and answers "is this client allowed another attempt?" BEFORE the token is
 * ever compared. The constant-time comparison in operator-identity.ts is
 * untouched.
 *
 * Key strategy — two fixed-window buckets, both under one namespace:
 *   nexus:web:login:fail:<sha256(clientId)[0..32]>   per-client failures
 *   nexus:web:login:fail:global                      all failures, any client
 * Client ids are hashed before keying so raw addresses (or attacker-chosen
 * junk in a spoofed header) never become Redis key material. Each bucket is an
 * INCR counter with a TTL equal to the window (set atomically via a Lua EVAL
 * on first increment, so a counter can never be created without an expiry).
 *
 * Client identity — derived from `x-forwarded-for` (XFF):
 *   - Default (LOGIN_RATE_LIMIT_TRUST_PROXY unset): the production compose
 *     topology publishes the web container DIRECTLY (3000:3000, no reverse
 *     proxy), so XFF is client-controlled and MUST NOT be trusted. Next.js
 *     fills it with the real socket address when absent, so honest clients
 *     still land in stable per-address buckets — but an attacker can rotate
 *     the header at will. That is why the GLOBAL bucket exists: spoofed
 *     identities dodge the per-client bucket yet every failure still counts
 *     against the global backstop, so the aggregate guess rate stays bounded
 *     no matter what the header claims. We use the FIRST XFF entry here only
 *     as a best-effort fairness key, never as a security boundary.
 *   - LOGIN_RATE_LIMIT_TRUST_PROXY=1 (explicit opt-in): the deployment has
 *     exactly one trusted reverse proxy in front of the web tier that APPENDS
 *     the socket address it observed to XFF. The LAST entry is therefore
 *     proxy-attested and is used as the client identity.
 *
 * Redis transport — raw RESP over a short-lived TCP socket, exactly like the
 * system-health probe: the web tier deliberately carries no ioredis/node-redis
 * dependency, and the login path needs only GET / DEL / one EVAL. Login is a
 * low-QPS human surface, so a connection per operation is fine.
 *
 * Failure mode — DEGRADE, never lock out, never go unbounded: if REDIS_URL is
 * unset, or Redis is unreachable / times out / errors, the limiter falls back
 * to an in-process counter (logged loudly). Rationale: this console fronts a
 * live trading control plane — an operator MUST be able to log in and reach
 * the kill switch during exactly the kind of incident in which Redis may be
 * down, so failing closed (503 on login) is operationally unacceptable; and
 * silently disabling the limit would drop the brute-force bound. The fallback
 * keeps a per-instance bound (worst case: limit × instance count) and a Redis
 * blip resets the current window — a bounded, documented loss.
 *
 * Tunables (all read per-request so tests and ops can adjust live):
 *   LOGIN_RATE_LIMIT_MAX_FAILURES         per-client failures per window (default 10)
 *   LOGIN_RATE_LIMIT_GLOBAL_MAX_FAILURES  global failures per window (default 50; 0 disables)
 *   LOGIN_RATE_LIMIT_WINDOW_SECONDS       fixed window length (default 900)
 *   LOGIN_RATE_LIMIT_TRUST_PROXY          "1" → trust the LAST XFF entry (see above)
 */

const KEY_PREFIX = "nexus:web:login:fail:";
const GLOBAL_KEY = `${KEY_PREFIX}global`;

const DEFAULT_MAX_FAILURES = 10;
const DEFAULT_GLOBAL_MAX_FAILURES = 50;
const DEFAULT_WINDOW_SECONDS = 900;

/** Hard cap on a Redis round trip so a dead Redis can't stall logins. */
const REDIS_OP_TIMEOUT_MS = 1_500;

/**
 * Atomic INCR-with-TTL: the expiry is set in the same script invocation that
 * creates the counter, so a crash between INCR and EXPIRE can never leave an
 * immortal bucket that locks a client out forever.
 */
const INCR_SCRIPT =
  "local c = redis.call('INCR', KEYS[1]) " +
  "if c == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end " +
  "return c";

export interface LoginThrottleVerdict {
  limited: boolean;
  /** Upper bound — the full window length, not the bucket's remaining TTL. */
  retryAfterSeconds: number;
}

interface ThrottleConfig {
  maxFailures: number;
  globalMaxFailures: number; // 0 = global backstop disabled
  windowSeconds: number;
  trustProxy: boolean;
  redisUrl: string | null;
}

function positiveIntFromEnv(name: string, fallback: number, allowZero = false): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || (n === 0 && !allowZero)) return fallback;
  return n;
}

function readConfig(): ThrottleConfig {
  const redisUrl = process.env.REDIS_URL;
  return {
    maxFailures: positiveIntFromEnv("LOGIN_RATE_LIMIT_MAX_FAILURES", DEFAULT_MAX_FAILURES),
    globalMaxFailures: positiveIntFromEnv(
      "LOGIN_RATE_LIMIT_GLOBAL_MAX_FAILURES",
      DEFAULT_GLOBAL_MAX_FAILURES,
      true,
    ),
    windowSeconds: positiveIntFromEnv("LOGIN_RATE_LIMIT_WINDOW_SECONDS", DEFAULT_WINDOW_SECONDS),
    trustProxy: process.env.LOGIN_RATE_LIMIT_TRUST_PROXY === "1",
    redisUrl: redisUrl && redisUrl.trim() !== "" ? redisUrl : null,
  };
}

// ─────────────────── client identity ───────────────────

/**
 * Derive the rate-limit identity for a login request (see module header for
 * the trust policy). Returns "direct" when no XFF header is present at all.
 */
export function deriveLoginClientId(req: Request): string {
  const header = req.headers.get("x-forwarded-for");
  if (!header) return "direct";
  const entries = header
    .split(",")
    .map((e) => e.trim())
    .filter((e) => e !== "");
  if (entries.length === 0) return "direct";
  const picked = (readConfig().trustProxy ? entries[entries.length - 1] : entries[0]) ?? "direct";
  // Bound the hash input; a spoofed header can be arbitrarily weird.
  return picked.slice(0, 256).toLowerCase();
}

function clientKey(clientId: string): string {
  return KEY_PREFIX + createHash("sha256").update(clientId, "utf8").digest("hex").slice(0, 32);
}

function bucketKeys(clientId: string, cfg: ThrottleConfig): string[] {
  const keys = [clientKey(clientId)];
  if (cfg.globalMaxFailures > 0) keys.push(GLOBAL_KEY);
  return keys;
}

// ─────────────────── in-process fallback store ───────────────────

/** Cap so an attacker rotating identities during a Redis outage can't balloon memory. */
const MEMORY_MAX_BUCKETS = 10_000;

const memoryBuckets = new Map<string, { count: number; resetAt: number }>();

function memoryGet(key: string): number {
  const entry = memoryBuckets.get(key);
  if (!entry) return 0;
  if (entry.resetAt <= Date.now()) {
    memoryBuckets.delete(key);
    return 0;
  }
  return entry.count;
}

function memoryIncr(key: string, windowSeconds: number): void {
  const now = Date.now();
  const entry = memoryBuckets.get(key);
  if (entry && entry.resetAt > now) {
    entry.count += 1;
    return;
  }
  if (memoryBuckets.size >= MEMORY_MAX_BUCKETS) {
    for (const [k, e] of memoryBuckets) {
      if (e.resetAt <= now) memoryBuckets.delete(k);
    }
    // Still saturated after pruning: drop the oldest bucket rather than grow.
    if (memoryBuckets.size >= MEMORY_MAX_BUCKETS) {
      const oldest = memoryBuckets.keys().next();
      if (!oldest.done) memoryBuckets.delete(oldest.value);
    }
  }
  memoryBuckets.set(key, { count: 1, resetAt: now + windowSeconds * 1_000 });
}

/** Test hook: drop all in-process counters so suites stay hermetic. */
export function resetLoginRateLimitState(): void {
  memoryBuckets.clear();
}

// ─────────────────── raw RESP transport ───────────────────

type RedisReply =
  | { kind: "status"; value: string }
  | { kind: "error"; value: string }
  | { kind: "int"; value: number }
  | { kind: "bulk"; value: string | null };

function encodeCommand(parts: string[]): string {
  let out = `*${parts.length}\r\n`;
  for (const p of parts) out += `$${Buffer.byteLength(p, "utf8")}\r\n${p}\r\n`;
  return out;
}

/**
 * Parse exactly `expected` replies from the start of `buf`. Returns null while
 * the buffer is still incomplete; throws on a protocol shape we don't speak
 * (callers treat that as "Redis unavailable").
 */
function parseReplies(buf: Buffer, expected: number): RedisReply[] | null {
  const replies: RedisReply[] = [];
  let off = 0;
  while (replies.length < expected) {
    const nl = buf.indexOf("\r\n", off);
    if (nl < 0) return null;
    const typeByte = buf[off];
    if (typeByte === undefined) return null;
    const type = String.fromCharCode(typeByte);
    const line = buf.toString("utf8", off + 1, nl);
    off = nl + 2;
    if (type === "+") replies.push({ kind: "status", value: line });
    else if (type === "-") replies.push({ kind: "error", value: line });
    else if (type === ":") replies.push({ kind: "int", value: Number(line) });
    else if (type === "$") {
      const len = Number(line);
      if (len === -1) {
        replies.push({ kind: "bulk", value: null });
      } else {
        if (buf.length < off + len + 2) return null;
        replies.push({ kind: "bulk", value: buf.toString("utf8", off, off + len) });
        off += len + 2;
      }
    } else {
      throw new Error(`unexpected RESP reply type "${type}"`);
    }
  }
  return replies;
}

/**
 * Open a short-lived connection, pipeline `commands` (prefixed with AUTH when
 * the URL carries a password), and return one reply per command. Resolves null
 * on ANY failure — connect error, timeout, auth rejection, error reply — so
 * the caller can degrade to the in-process store. Never rejects.
 */
function sendRedisCommands(url: string, commands: string[][]): Promise<RedisReply[] | null> {
  let host = "127.0.0.1";
  let port = 6379;
  let password: string | undefined;
  try {
    const u = new URL(url);
    if (u.hostname) host = u.hostname;
    if (u.port) port = Number(u.port);
    if (u.password) password = decodeURIComponent(u.password);
  } catch {
    return Promise.resolve(null);
  }

  const wire = password ? [["AUTH", password], ...commands] : commands;
  const expected = wire.length;
  const payload = wire.map(encodeCommand).join("");

  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    let buf = Buffer.alloc(0);
    const finish = (replies: RedisReply[] | null) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(replies);
    };
    socket.setTimeout(REDIS_OP_TIMEOUT_MS);
    socket.setNoDelay(true);
    socket.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      let replies: RedisReply[] | null;
      try {
        replies = parseReplies(buf, expected);
      } catch {
        finish(null);
        return;
      }
      if (replies === null) return; // incomplete — keep buffering
      if (replies.some((r) => r.kind === "error")) {
        finish(null);
        return;
      }
      finish(password ? replies.slice(1) : replies);
    });
    socket.on("timeout", () => finish(null));
    socket.on("error", () => finish(null));
    socket.on("close", () => finish(null));
    socket.connect(port, host, () => {
      socket.write(payload);
    });
  });
}

function logDegraded(op: string): void {
  console.error(
    `[login-rate-limit] redis unavailable during ${op} — degraded to per-instance in-memory throttling`,
  );
}

// ─────────────────── the limiter ───────────────────

/**
 * Is this client allowed another login attempt right now? Called BEFORE the
 * request body is parsed or any token compared, so throttled traffic never
 * reaches the authentication path.
 */
export async function checkLoginAllowed(clientId: string): Promise<LoginThrottleVerdict> {
  const cfg = readConfig();
  const keys = bucketKeys(clientId, cfg);

  let counts: number[] | null = null;
  if (cfg.redisUrl) {
    const replies = await sendRedisCommands(
      cfg.redisUrl,
      keys.map((k) => ["GET", k]),
    );
    if (replies === null) {
      logDegraded("check");
    } else {
      counts = replies.map((r) => (r.kind === "bulk" && r.value !== null ? Number(r.value) || 0 : 0));
    }
  }
  if (counts === null) counts = keys.map((k) => memoryGet(k));

  const clientCount = counts[0] ?? 0;
  const globalCount = counts[1] ?? 0;
  const limited =
    clientCount >= cfg.maxFailures ||
    (cfg.globalMaxFailures > 0 && globalCount >= cfg.globalMaxFailures);
  return { limited, retryAfterSeconds: cfg.windowSeconds };
}

/** Record a failed token exchange (401) against the client and global buckets. */
export async function recordLoginFailure(clientId: string): Promise<void> {
  const cfg = readConfig();
  const keys = bucketKeys(clientId, cfg);

  if (cfg.redisUrl) {
    const replies = await sendRedisCommands(
      cfg.redisUrl,
      keys.map((k) => ["EVAL", INCR_SCRIPT, "1", k, String(cfg.windowSeconds)]),
    );
    if (replies !== null) return;
    logDegraded("failure record");
  }
  for (const k of keys) memoryIncr(k, cfg.windowSeconds);
}

/**
 * A successful login clears the client's failure bucket so a legitimate
 * operator's earlier typos never accumulate toward a lockout. The global
 * bucket is left alone — it counts failures only and expires on its own.
 */
export async function recordLoginSuccess(clientId: string): Promise<void> {
  const cfg = readConfig();
  const key = clientKey(clientId);

  if (cfg.redisUrl) {
    const replies = await sendRedisCommands(cfg.redisUrl, [["DEL", key]]);
    if (replies !== null) return;
    logDegraded("success reset");
  }
  memoryBuckets.delete(key);
}
