/**
 * Stateless signed operator-session tokens (B1 read gate).
 *
 * A session is a URL-safe, HMAC-SHA256-signed token `<payload>.<sig>` where
 * <payload> is base64url(JSON({ sub, iat, exp })) and <sig> is
 * base64url(HMAC-SHA256(payload, NEXTAUTH_SECRET)). There is NO server-side
 * store — the signature is the proof, so the same value verifies in the Edge
 * middleware (the gate) and in Node route handlers. For that reason everything
 * here uses Web Crypto (`crypto.subtle`) and `btoa`/`atob`, the only HMAC +
 * base64 primitives available in BOTH runtimes.
 *
 * FAIL-CLOSED: with `NEXTAUTH_SECRET` unset, no token can be minted OR verified
 * — `createSession` returns null and `verifySession` returns null, so the gate
 * treats every request as unauthenticated. An unconfigured console admits
 * no-one rather than everyone (mirrors the OPS_CONTROL_TOKEN discipline).
 */

export const SESSION_COOKIE = "nexus_session";

/** Session lifetime — an operator console; re-login after 12h. */
export const SESSION_TTL_SECONDS = 12 * 60 * 60;

export interface SessionClaims {
  /** Authenticated operator identity (registry id). */
  sub: string;
  /** Issued-at (epoch seconds). */
  iat: number;
  /** Expiry (epoch seconds). */
  exp: number;
}

const enc = new TextEncoder();

function secret(): string {
  return (process.env.NEXTAUTH_SECRET ?? "").trim();
}

function b64urlEncode(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(s: string): Uint8Array<ArrayBuffer> {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
  // Back the view with a concrete ArrayBuffer so it satisfies the strict
  // `BufferSource` (ArrayBufferView<ArrayBuffer>) that crypto.subtle.verify wants.
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Import the HMAC key from the secret, or null when unconfigured (fail-closed). */
async function hmacKey(): Promise<CryptoKey | null> {
  const s = secret();
  if (s === "") return null;
  return crypto.subtle.importKey(
    "raw",
    enc.encode(s),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

function nowSeconds(now?: number): number {
  return now ?? Math.floor(Date.now() / 1000);
}

/** Mint a signed session for `sub`. Null when no secret is configured. */
export async function createSession(sub: string, now?: number): Promise<string | null> {
  const key = await hmacKey();
  if (key === null) return null;
  const iat = nowSeconds(now);
  const claims: SessionClaims = { sub, iat, exp: iat + SESSION_TTL_SECONDS };
  const payload = b64urlEncode(enc.encode(JSON.stringify(claims)));
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(payload));
  return `${payload}.${b64urlEncode(new Uint8Array(sig))}`;
}

/**
 * Verify a session token. Returns the claims IFF the signature is valid AND the
 * token is unexpired; null otherwise (bad shape, tampered payload, wrong secret,
 * expired, or no secret configured). Signature check is `crypto.subtle.verify`
 * (constant-time), never a string compare of recomputed digests.
 */
export async function verifySession(
  token: string | undefined | null,
  now?: number,
): Promise<SessionClaims | null> {
  if (!token) return null;
  const dot = token.indexOf(".");
  if (dot <= 0 || dot === token.length - 1) return null;
  const payload = token.slice(0, dot);
  const sigPart = token.slice(dot + 1);
  const key = await hmacKey();
  if (key === null) return null;

  let sigBytes: Uint8Array<ArrayBuffer>;
  let payloadJson: string;
  try {
    sigBytes = b64urlDecode(sigPart);
    payloadJson = new TextDecoder().decode(b64urlDecode(payload));
  } catch {
    return null;
  }

  const ok = await crypto.subtle.verify("HMAC", key, sigBytes, enc.encode(payload));
  if (!ok) return null;

  let claims: SessionClaims;
  try {
    claims = JSON.parse(payloadJson) as SessionClaims;
  } catch {
    return null;
  }
  if (typeof claims.sub !== "string" || claims.sub === "") return null;
  if (typeof claims.exp !== "number" || !Number.isFinite(claims.exp)) return null;
  if (nowSeconds(now) >= claims.exp) return null;
  return claims;
}
