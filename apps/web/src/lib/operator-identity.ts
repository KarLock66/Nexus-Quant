import { createHash, timingSafeEqual } from "node:crypto";

/**
 * Operator identity registry (B2) — resolves a presented operator token to a
 * SPECIFIC operator identity, so four-eyes and audit `actor` can be bound to an
 * authenticated principal instead of a self-declared client string.
 *
 * Configuration (server-only env), first match wins:
 *  - `OPERATORS` as a JSON array: `[{"id":"alice","token":"…"},{"id":"bob","token":"…"}]`
 *  - `OPERATORS` as a compact list: `alice:tok1,bob:tok2`
 *  - legacy fallback: a bare `OPS_CONTROL_TOKEN` becomes the single operator
 *    identity `"operator"` (existing single-token deployments keep working — with
 *    exactly ONE identity, which is why four-eyes correctly stays unsatisfiable
 *    until a second operator is configured).
 *
 * Node-runtime only (uses `node:crypto`): consumed by the auth/login and the
 * mutating route handlers (all `runtime = "nodejs"`), never by the Edge
 * middleware — which only needs to verify the already-issued session cookie.
 */

export interface OperatorIdentity {
  id: string;
}

interface Registered {
  id: string;
  tokenHash: Buffer;
}

function sha256(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

/** Parse the registry from env on each call (env is process-static; no cache). */
function loadRegistry(): Registered[] {
  const raw = (process.env.OPERATORS ?? "").trim();
  const out: Registered[] = [];

  if (raw.startsWith("[")) {
    try {
      const arr: unknown = JSON.parse(raw);
      if (Array.isArray(arr)) {
        for (const e of arr) {
          if (e !== null && typeof e === "object") {
            const id = (e as Record<string, unknown>)["id"];
            const token = (e as Record<string, unknown>)["token"];
            if (typeof id === "string" && typeof token === "string") {
              const tid = id.trim();
              if (tid !== "" && token !== "") out.push({ id: tid, tokenHash: sha256(token) });
            }
          }
        }
      }
    } catch {
      // malformed OPERATORS JSON -> treat as no operators (fail-closed).
    }
  } else if (raw !== "") {
    for (const pair of raw.split(",")) {
      const idx = pair.indexOf(":");
      if (idx <= 0) continue;
      const id = pair.slice(0, idx).trim();
      const token = pair.slice(idx + 1);
      if (id !== "" && token !== "") out.push({ id, tokenHash: sha256(token) });
    }
  }

  if (out.length === 0) {
    const legacy = (process.env.OPS_CONTROL_TOKEN ?? "").trim();
    if (legacy !== "") out.push({ id: "operator", tokenHash: sha256(legacy) });
  }
  return out;
}

/** True iff at least one operator identity is configured (auth is usable). */
export function operatorsConfigured(): boolean {
  return loadRegistry().length > 0;
}

/**
 * Resolve a presented token to its operator identity, or null if it matches no
 * configured operator. Constant-time over SHA-256 digests, and every entry is
 * evaluated (no early return) so the match position never leaks via timing.
 */
export function resolveOperator(token: string): OperatorIdentity | null {
  if (token === "") return null;
  const presented = sha256(token);
  let matched: string | null = null;
  for (const r of loadRegistry()) {
    if (timingSafeEqual(presented, r.tokenHash)) matched = r.id;
  }
  return matched === null ? null : { id: matched };
}
