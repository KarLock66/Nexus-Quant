/**
 * Stage-B statistical DQ client — calls the Python quant service
 * (POST {quantBaseUrl}/dq/statistical) and returns its checks.
 *
 * Failure taxonomy (P1) — a Stage-B fault is no longer collapsed into one
 * undifferentiated 15-pt deduction:
 *  - DATA  : HTTP 200 + valid checks (statistical findings) -> normal scoring.
 *  - INFRA : unconfigured / unreachable / timeout / 5xx / other-4xx / malformed
 *            -> fail-closed `stage_b_unavailable` check (passed=false,
 *            deduction=15) tagged category="INFRA"; the pipeline emits
 *            SYSTEM_HEALTH_DEGRADED (WARN). Stage B down still costs 15 points,
 *            but is now machine-distinguishable from genuine data corruption.
 *  - AUTH  : 401/403 (shared-secret misconfig) -> FAIL-FAST: throws
 *            StageBAuthError (no silent slow-burn of FAILED reports). The
 *            pipeline emits SYSTEM_HEALTH_DEGRADED (CRITICAL).
 *
 * Intentionally self-contained (no ../lib imports): minimal local JSON logger.
 */

import type { NormalizedCandle } from "../connectors/types.js";
import type { StageBFailureCategory, StructuralCheck } from "./checks.js";

export const STAGE_B_TIMEOUT_MS = 10_000;
export const STAGE_B_UNAVAILABLE_DEDUCTION = 15;

/**
 * Raised when the quant service rejects the request with 401/403 — a shared-
 * secret misconfiguration, which is neither data nor transient infra. Thrown
 * (fail-fast) instead of degrading to a deduction so the config error is loud
 * and immediate rather than a silent stream of FAILED reports.
 */
export class StageBAuthError extends Error {
  readonly status: number;

  constructor(status: number) {
    super(
      `statistical checks rejected with HTTP ${status} (auth) — quant service ` +
        `shared-secret misconfigured; failing fast`,
    );
    this.name = "StageBAuthError";
    this.status = status;
  }
}

function logWarn(message: string, fields: Record<string, unknown>): void {
  try {
    console.warn(
      JSON.stringify({
        level: "warn",
        ts: new Date().toISOString(),
        module: "ingestion.dq.stage-b-client",
        message,
        ...fields,
      }),
    );
  } catch {
    // logging must never throw
  }
}

function stageBUnavailable(
  reason: string,
  category: StageBFailureCategory,
): StructuralCheck {
  return {
    check: "stage_b_unavailable",
    passed: false,
    deduction: STAGE_B_UNAVAILABLE_DEDUCTION,
    detail: `statistical checks unavailable (fail-closed): ${reason}`,
    category,
  };
}

function isStructuralCheck(value: unknown): value is StructuralCheck {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v["check"] === "string" &&
    typeof v["passed"] === "boolean" &&
    typeof v["deduction"] === "number" &&
    Number.isFinite(v["deduction"]) &&
    typeof v["detail"] === "string"
  );
}

function parseStageBResponse(payload: unknown): StructuralCheck[] | null {
  // Accept either a bare array or an envelope { checks: [...] }.
  const arr = Array.isArray(payload)
    ? payload
    : typeof payload === "object" &&
        payload !== null &&
        Array.isArray((payload as Record<string, unknown>)["checks"])
      ? ((payload as Record<string, unknown>)["checks"] as unknown[])
      : null;
  if (arr === null) return null;
  if (!arr.every(isStructuralCheck)) return null;
  return arr;
}

export async function fetchStageBChecks(
  deps: { quantBaseUrl: string | null; sharedSecret?: string },
  candles: NormalizedCandle[],
): Promise<StructuralCheck[]> {
  if (deps.quantBaseUrl === null || deps.quantBaseUrl === "") {
    logWarn("quantBaseUrl not configured; applying stage_b_unavailable (INFRA)", {
      candleCount: candles.length,
    });
    return [stageBUnavailable("quantBaseUrl not configured", "INFRA")];
  }

  const url = `${deps.quantBaseUrl.replace(/\/+$/, "")}/dq/statistical`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (deps.sharedSecret !== undefined && deps.sharedSecret !== "") {
    headers["X-Internal-Secret"] = deps.sharedSecret;
  }

  const body = JSON.stringify({
    candles: candles.map((c) => ({
      ts: c.ts.toISOString(),
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
      volume: c.volume,
    })),
    referenceCloses: null,
  });

  try {
    const res = await fetch(url, {
      method: "POST",
      headers,
      body,
      signal: AbortSignal.timeout(STAGE_B_TIMEOUT_MS),
    });
    if (res.status === 401 || res.status === 403) {
      // AUTH: a shared-secret misconfig — fail fast, never a silent deduction.
      logWarn("stage B rejected auth; failing fast (AUTH)", {
        url,
        status: res.status,
      });
      throw new StageBAuthError(res.status);
    }
    if (!res.ok) {
      logWarn("stage B returned non-OK status (INFRA)", { url, status: res.status });
      return [stageBUnavailable(`HTTP ${res.status}`, "INFRA")];
    }
    const payload: unknown = await res.json();
    const checks = parseStageBResponse(payload);
    if (checks === null) {
      logWarn("stage B response malformed (INFRA)", { url });
      return [stageBUnavailable("malformed response payload", "INFRA")];
    }
    return checks;
  } catch (err) {
    // AUTH is fail-fast: propagate it rather than absorbing into a deduction.
    if (err instanceof StageBAuthError) throw err;
    const reason = err instanceof Error ? err.message : String(err);
    logWarn("stage B request failed (INFRA)", { url, error: reason });
    return [stageBUnavailable(reason, "INFRA")];
  }
}
