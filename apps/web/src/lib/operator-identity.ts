import { createHash, timingSafeEqual } from "node:crypto";
import { parseOperatorRegistry } from "./operator-registry";

/**
 * Operator identity registry (B2) — resolves a presented operator token to a
 * SPECIFIC operator identity, so four-eyes and audit `actor` can be bound to an
 * authenticated principal instead of a self-declared client string.
 *
 * Registry PARSING (env formats, legacy OPS_CONTROL_TOKEN fallback, fail-closed
 * rules) lives in lib/operator-registry.ts — the Edge-safe single source of
 * truth. This module adds the Node-only half: hashing the configured tokens and
 * matching a presented token in constant time.
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

/** Hash the parsed registry's tokens for constant-time matching (no cache). */
function loadRegistry(): Registered[] {
  return parseOperatorRegistry().map((e) => ({ id: e.id, tokenHash: sha256(e.token) }));
}

/** True iff at least one operator identity is configured (auth is usable). */
export function operatorsConfigured(): boolean {
  return parseOperatorRegistry().length > 0;
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
