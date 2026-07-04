import { NextResponse } from "next/server";

/**
 * Phase 11B — hardened response contract for every /api/v1/signals/* endpoint.
 *
 *   {
 *     status: "ok" | "error",
 *     data:   <payload> | null,      // NEVER a partial/blended payload
 *     error:  string | null,         // set IFF status === "error"
 *     meta: {
 *       source: "db" | "pipeline",   // where the truth was read from
 *       timestamp: string,           // response generation time (ISO-8601)
 *       featureHash: string,         // provenance of the newest signal in the
 *                                    // payload; "unavailable" when the payload
 *                                    // carries none (NEVER fabricated)
 *     }
 *   }
 *
 * Rules enforced by construction:
 *  - no partial-success masking: a failure is status:"error" + data:null —
 *    there is no code path that returns real rows blended with fallbacks;
 *  - no silent empty arrays: an empty result is status:"ok" with the true
 *    empty payload, an unreachable backend is status:"error" (HTTP 5xx);
 *  - error responses still carry the full meta block for observability.
 */

export interface SignalApiMeta {
  source: "db" | "pipeline";
  timestamp: string;
  featureHash: string;
  /** Route-specific extensions (e.g. pagination cursor). */
  [key: string]: unknown;
}

export interface SignalApiEnvelope<T> {
  status: "ok" | "error";
  data: T | null;
  error: string | null;
  meta: SignalApiMeta;
}

/** Sentinel for payloads that carry no feature provenance. Never a fake hash. */
export const NO_FEATURE_HASH = "unavailable";

interface MetaInput {
  source?: "db" | "pipeline";
  featureHash?: string | undefined;
  extra?: Record<string, unknown>;
}

function buildMeta(input: MetaInput): SignalApiMeta {
  return {
    source: input.source ?? "db",
    timestamp: new Date().toISOString(),
    featureHash: input.featureHash ?? NO_FEATURE_HASH,
    ...(input.extra ?? {}),
  };
}

/** 200 envelope. `data` is the complete, real payload (possibly truly empty). */
export function signalOk<T>(data: T, meta: MetaInput = {}): NextResponse {
  const body: SignalApiEnvelope<T> = {
    status: "ok",
    data,
    error: null,
    meta: buildMeta(meta),
  };
  return NextResponse.json(body);
}

/** Error envelope: data is null, never partial. */
export function signalError(
  httpStatus: number,
  message: string,
  meta: MetaInput = {},
): NextResponse {
  const body: SignalApiEnvelope<never> = {
    status: "error",
    data: null,
    error: message,
    meta: buildMeta(meta),
  };
  return NextResponse.json(body, { status: httpStatus });
}

/** featureHash of the first item that carries one, else undefined (→ sentinel). */
export function firstFeatureHash(
  items: ReadonlyArray<{ featureHash?: string }> | undefined,
): string | undefined {
  if (!items) return undefined;
  for (const item of items) {
    if (typeof item.featureHash === "string" && item.featureHash.length > 0) {
      return item.featureHash;
    }
  }
  return undefined;
}
