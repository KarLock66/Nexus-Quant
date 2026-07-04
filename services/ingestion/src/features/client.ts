/**
 * HTTP client for the quant Feature Store endpoint (POST /features/compute).
 *
 * This MIRRORS services/workers/src/features/client.ts — same opaque-hash
 * discipline (the response `featureHash` and `features` vector are carried
 * verbatim, never recomputed/normalized/reserialized in TS). The two are kept
 * in lockstep deliberately; a shared @nexus/feature-store lib is a documented
 * follow-up. Ingestion owns the Exchange→DQ→Features half of the pipeline, so
 * the compute call lives here rather than crossing into the workers app.
 */

import type { Exchange, Timeframe } from "@nexus/core";

export const FEATURE_COMPUTE_TIMEOUT_MS = 15_000;

/** Request submitted to POST /features/compute (snake_case wire form). */
export interface FeatureComputeInput {
  dqReportId: string;
  dqScore: number;
  scope: {
    exchange: Exchange;
    symbol: string;
    timeframe: Timeframe;
    /** Optional point-in-time guard; when set, must equal the last candle ts. */
    ts?: Date;
  };
  featureSet: string;
  version: number;
  marketData: {
    candles: Array<{
      ts: string;
      open: string;
      high: string;
      low: string;
      close: string;
      volume: string;
    }>;
  };
}

/** Decoded response. `featureHash`/`features` are verbatim (opaque). */
export interface FeatureComputeResult {
  featureSet: string;
  version: number;
  asOfTs: string;
  featureHash: string;
  features: Record<string, number>;
  inputCandleCount: number;
  dqReportId: string | null;
  raw: string;
}

/** Raised on 401/403 — a shared-secret misconfiguration. Fail-fast. */
export class FeatureComputeAuthError extends Error {
  readonly status: number;
  constructor(status: number) {
    super(
      `features/compute rejected with HTTP ${status} (auth) — quant service ` +
        `shared-secret misconfigured; failing fast`,
    );
    this.name = "FeatureComputeAuthError";
    this.status = status;
  }
}

/** Raised on any non-auth failure (unreachable / non-2xx / malformed body). */
export class FeatureComputeError extends Error {
  readonly status: number | null;
  readonly code: string;
  constructor(message: string, status: number | null, code: string) {
    super(message);
    this.name = "FeatureComputeError";
    this.status = status;
    this.code = code;
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function decode(raw: string): FeatureComputeResult {
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch (err) {
    throw new FeatureComputeError(
      `malformed response body: ${err instanceof Error ? err.message : String(err)}`,
      200,
      "MALFORMED_RESPONSE",
    );
  }
  if (!isRecord(body)) {
    throw new FeatureComputeError("response is not an object", 200, "MALFORMED_RESPONSE");
  }

  const featureHash = body["featureHash"];
  const features = body["features"];
  const featureSet = body["feature_set"];
  const version = body["version"];
  const asOfTs = body["as_of_ts"];
  const inputCandleCount = body["input_candle_count"];
  const dqReportId = body["dq_report_id"];

  if (typeof featureHash !== "string" || featureHash.length === 0) {
    throw new FeatureComputeError("missing/invalid featureHash", 200, "MALFORMED_RESPONSE");
  }
  if (!isRecord(features)) {
    throw new FeatureComputeError("missing/invalid features", 200, "MALFORMED_RESPONSE");
  }
  if (typeof featureSet !== "string" || typeof version !== "number") {
    throw new FeatureComputeError("missing/invalid feature_set/version", 200, "MALFORMED_RESPONSE");
  }
  if (typeof asOfTs !== "string") {
    throw new FeatureComputeError("missing/invalid as_of_ts", 200, "MALFORMED_RESPONSE");
  }

  return {
    featureSet,
    version,
    asOfTs,
    featureHash,
    features: features as Record<string, number>,
    inputCandleCount: typeof inputCandleCount === "number" ? inputCandleCount : 0,
    dqReportId: typeof dqReportId === "string" ? dqReportId : null,
    raw,
  };
}

export async function computeFeatures(
  deps: { quantBaseUrl: string; sharedSecret?: string },
  input: FeatureComputeInput,
): Promise<FeatureComputeResult> {
  if (deps.quantBaseUrl === "") {
    throw new FeatureComputeError("quantBaseUrl not configured", null, "NOT_CONFIGURED");
  }

  const url = `${deps.quantBaseUrl.replace(/\/+$/, "")}/features/compute`;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (deps.sharedSecret !== undefined && deps.sharedSecret !== "") {
    headers["X-Internal-Secret"] = deps.sharedSecret;
  }

  const scope: Record<string, unknown> = {
    exchange: input.scope.exchange,
    symbol: input.scope.symbol,
    timeframe: input.scope.timeframe,
  };
  if (input.scope.ts !== undefined) scope["ts"] = input.scope.ts.toISOString();

  const body = JSON.stringify({
    scope,
    feature_set: input.featureSet,
    version: input.version,
    market_data: input.marketData,
    dq_score: input.dqScore,
    dq_report_id: input.dqReportId,
  });

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers,
      body,
      signal: AbortSignal.timeout(FEATURE_COMPUTE_TIMEOUT_MS),
    });
  } catch (err) {
    throw new FeatureComputeError(
      `features/compute request failed: ${err instanceof Error ? err.message : String(err)}`,
      null,
      "UNREACHABLE",
    );
  }

  if (res.status === 401 || res.status === 403) {
    throw new FeatureComputeAuthError(res.status);
  }
  if (!res.ok) {
    let detail = "";
    try {
      detail = await res.text();
    } catch {
      // best-effort
    }
    throw new FeatureComputeError(
      `features/compute returned HTTP ${res.status}${detail ? `: ${detail}` : ""}`,
      res.status,
      "NON_OK",
    );
  }

  const raw = await res.text();
  return decode(raw);
}
