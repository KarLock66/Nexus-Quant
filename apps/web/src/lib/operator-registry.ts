/**
 * Operator registry parsing (B3) — the single source of truth for turning the
 * operator-registry environment configuration into `{ id, token }` entries.
 *
 * EDGE-SAFE by design: pure string/JSON parsing over `process.env`, with no
 * `node:crypto` (or any Node-only) import, so BOTH runtimes can share it — the
 * Edge middleware as well as Node route handlers. Token *matching* (SHA-256 +
 * constant-time compare) stays Node-only in lib/operator-identity.ts, which
 * consumes this parser.
 *
 * Configuration (server-only env), first match wins:
 *  - `OPERATORS` as a JSON array: `[{"id":"alice","token":"…"},{"id":"bob","token":"…"}]`
 *  - `OPERATORS` as a compact list: `alice:tok1,bob:tok2`
 *  - legacy fallback: a bare `OPS_CONTROL_TOKEN` becomes the single operator
 *    identity `"operator"` (existing single-token deployments keep working — with
 *    exactly ONE identity, which is why four-eyes correctly stays unsatisfiable
 *    until a second operator is configured).
 *
 * Malformed configuration parses to an EMPTY registry (fail-closed): nothing is
 * registered, so nothing authenticates.
 */

export interface OperatorRegistryEntry {
  /** Operator identity — the audit `actor` and four-eyes principal. */
  id: string;
  /** The operator's bearer token, verbatim from configuration (never logged). */
  token: string;
}

/** Parse the registry from env on each call (env is process-static; no cache). */
export function parseOperatorRegistry(): OperatorRegistryEntry[] {
  const raw = (process.env.OPERATORS ?? "").trim();
  const out: OperatorRegistryEntry[] = [];

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
              if (tid !== "" && token !== "") out.push({ id: tid, token });
            }
          }
        }
      }
    } catch {
      // malformed OPERATORS JSON -> contributes no entries (fail-closed).
    }
  } else if (raw !== "") {
    for (const pair of raw.split(",")) {
      const idx = pair.indexOf(":");
      if (idx <= 0) continue;
      const id = pair.slice(0, idx).trim();
      const token = pair.slice(idx + 1);
      if (id !== "" && token !== "") out.push({ id, token });
    }
  }

  if (out.length === 0) {
    const legacy = (process.env.OPS_CONTROL_TOKEN ?? "").trim();
    if (legacy !== "") out.push({ id: "operator", token: legacy });
  }
  return out;
}

/**
 * True iff `id` is a CURRENTLY-registered operator identity. A session outlives
 * registry edits by up to its TTL, so the mutation path re-checks membership of
 * the already-authenticated session subject: a de-registered operator's live
 * session must stop authorizing mutations immediately, not at cookie expiry.
 * Plain equality — ids are public principals, not secret material, so a timing-
 * safe compare is not required here.
 */
export function isRegisteredOperatorId(id: string): boolean {
  if (id === "") return false;
  return parseOperatorRegistry().some((e) => e.id === id);
}
