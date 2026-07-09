/**
 * Phase 11C Stage 1 — strict request-input validation for /api/v1/*.
 *
 * Every helper is pure and fail-closed:
 *  - ABSENT optional input resolves to its documented default;
 *  - PRESENT-but-malformed input is an explicit error (the route answers 400),
 *    never a silent fallback — a silent default would mask client bugs as
 *    normal traffic and let malformed input reach the database layer.
 *
 * Nothing here changes what a well-formed request returns: these are admission
 * checks only, upstream of the (unchanged) read/write handlers.
 */

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

const pass = <T>(value: T): ParseResult<T> => ({ ok: true, value });
const fail = <T>(error: string): ParseResult<T> => ({ ok: false, error });

/**
 * Canonical timestamp format for every /api/v1 response: ISO-8601 UTC with
 * millisecond precision and a `Z` suffix (exactly `Date#toISOString`). Format
 * normalization only — the instant is unchanged.
 */
export function canonicalTimestamp(d: Date = new Date()): string {
  return d.toISOString();
}

/**
 * Optional bounded-integer query param. Absent -> `fallback`; present but not
 * an integer inside [min, max] -> error (no clamping, no silent default).
 */
export function parseBoundedInt(
  raw: string | null,
  name: string,
  min: number,
  max: number,
  fallback: number,
): ParseResult<number> {
  if (raw === null) return pass(fallback);
  const trimmed = raw.trim();
  if (!/^-?\d+$/.test(trimmed)) {
    return fail(`invalid '${name}': expected an integer, got "${raw}"`);
  }
  const n = Number(trimmed);
  if (n < min || n > max) {
    return fail(`invalid '${name}': must be between ${min} and ${max}, got ${n}`);
  }
  return pass(n);
}

/**
 * Optional enum query param. Absent -> `fallback`; present but not one of
 * `allowed` -> error (previously several routes silently coerced to a default).
 */
export function parseEnumParam<T extends string>(
  raw: string | null,
  name: string,
  allowed: ReadonlySet<T> | readonly T[],
  fallback: T,
): ParseResult<T> {
  const set: ReadonlySet<string> = allowed instanceof Set ? allowed : new Set(allowed);
  if (raw === null) return pass(fallback);
  if (!set.has(raw)) {
    return fail(`invalid '${name}': expected one of ${[...set].join(", ")}, got "${raw}"`);
  }
  return pass(raw as T);
}

/**
 * Optional free-text query param (search terms, filters). Absent -> undefined;
 * present but empty/whitespace-only or longer than `maxLen` -> error.
 */
export function parseOptionalString(
  raw: string | null,
  name: string,
  maxLen: number,
): ParseResult<string | undefined> {
  if (raw === null) return pass(undefined);
  const trimmed = raw.trim();
  if (trimmed === "") return fail(`invalid '${name}': must be a non-empty string`);
  if (trimmed.length > maxLen) {
    return fail(`invalid '${name}': must be at most ${maxLen} characters`);
  }
  return pass(trimmed);
}

/**
 * Instrument symbol grammar: leading alphanumeric, then alphanumerics plus
 * `. _ : -` (covers BTC-PERP, BTC_USDC-PERPETUAL, BTC.D, exchange:sym forms).
 * Bounded so a hostile query string can never push arbitrary bytes at Prisma.
 */
const SYMBOL_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,31}$/;
const MAX_SYMBOL_FILTER = 20;

/** Required single-symbol query param (e.g. consensus). */
export function parseRequiredSymbol(
  raw: string | null,
  name: string,
): ParseResult<string> {
  if (raw === null || raw.trim() === "") {
    return fail(`${name} query parameter is required`);
  }
  const sym = raw.trim();
  if (!SYMBOL_RE.test(sym)) {
    return fail(`invalid '${name}': not a valid instrument symbol`);
  }
  return pass(sym);
}

/**
 * Optional comma-separated symbol filter (?symbol=BTC-PERP,ETH-PERP).
 * Absent -> undefined (no filter). Present -> every token must be a valid
 * symbol; empty tokens, an empty list, or more than MAX_SYMBOL_FILTER entries
 * are malformed (previously empty tokens were silently dropped).
 */
export function parseSymbolFilter(
  raw: string | null,
  name: string,
): ParseResult<string[] | undefined> {
  if (raw === null) return pass(undefined);
  const tokens = raw.split(",").map((s) => s.trim());
  if (tokens.length === 0 || tokens.some((t) => t === "")) {
    return fail(`invalid '${name}': expected a comma-separated list of symbols`);
  }
  if (tokens.length > MAX_SYMBOL_FILTER) {
    return fail(`invalid '${name}': at most ${MAX_SYMBOL_FILTER} symbols per request`);
  }
  for (const t of tokens) {
    if (!SYMBOL_RE.test(t)) {
      return fail(`invalid '${name}': "${t}" is not a valid instrument symbol`);
    }
  }
  return pass(tokens);
}

/**
 * Opaque resource/cursor id (row ids, cuids, fixture ids). Bounded charset so
 * a malformed id is a 400 at the edge, not a Prisma error surfaced as a 500.
 */
const RESOURCE_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

/** Required path/route id segment. */
export function parseResourceId(raw: string, name: string): ParseResult<string> {
  if (!RESOURCE_ID_RE.test(raw)) {
    return fail(`invalid '${name}': not a valid resource id`);
  }
  return pass(raw);
}

/** Optional id-cursor query param. Absent -> undefined. */
export function parseCursorId(
  raw: string | null,
  name: string,
): ParseResult<string | undefined> {
  if (raw === null) return pass(undefined);
  if (!RESOURCE_ID_RE.test(raw)) {
    return fail(`invalid '${name}': must be a non-empty id`);
  }
  return pass(raw);
}

/**
 * Strict JSON body reader: the body must parse AND be a plain JSON object
 * (not an array, string, number, or null). Every /api/v1 POST body is an
 * object by contract; anything else is malformed.
 */
export async function readJsonObject(
  req: Request,
): Promise<ParseResult<Record<string, unknown>>> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return fail("invalid JSON body");
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return fail("request body must be a JSON object");
  }
  return pass(body as Record<string, unknown>);
}

/** Required non-empty string body field, length-bounded. */
export function requireStringField(
  body: Record<string, unknown>,
  key: string,
  maxLen: number,
): ParseResult<string> {
  const v = body[key];
  if (typeof v !== "string" || v.trim() === "") {
    return fail(`a non-empty '${key}' is required`);
  }
  if (v.length > maxLen) {
    return fail(`invalid '${key}': must be at most ${maxLen} characters`);
  }
  return pass(v);
}

/**
 * Optional string body field with a default. ABSENT (undefined) -> `fallback`;
 * present but not a non-empty bounded string -> error (previously e.g. a
 * numeric `actor` silently became "operator").
 */
export function optionalStringField(
  body: Record<string, unknown>,
  key: string,
  maxLen: number,
  fallback: string,
): ParseResult<string> {
  const v = body[key];
  if (v === undefined) return pass(fallback);
  if (typeof v !== "string" || v.trim() === "") {
    return fail(`invalid '${key}': must be a non-empty string when provided`);
  }
  if (v.length > maxLen) {
    return fail(`invalid '${key}': must be at most ${maxLen} characters`);
  }
  return pass(v);
}
