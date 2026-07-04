/**
 * M5 Stage-A structural DQ gateway — public module surface.
 *
 * Pipeline: checkCandleBatch (Stage A) -> fetchStageBChecks (Python quant,
 * fail-closed) -> scoreChecks -> one persisted DataQualityReport row.
 * Hard floor: PASSED iff score >= 90 (MIN_DATA_QUALITY_SCORE).
 */

import type { PrismaClient } from "@nexus/db";
import type { Exchange, Timeframe } from "@nexus/core";
import type { NormalizedCandle } from "../connectors/types.js";
import { checkCandleBatch } from "./checks.js";
import type { StructuralCheck } from "./checks.js";
import { scoreChecks } from "./score.js";
import { computeDatasetHash } from "./hash.js";
import { fetchStageBChecks } from "./stage-b-client.js";

export type { StructuralCheck } from "./checks.js";
export {
  CHECK_WEIGHTS,
  checkCandleBatch,
  checkSchemaConformance,
  checkDuplicates,
  checkTimestampMonotonic,
  checkGaps,
} from "./checks.js";
export { scoreChecks } from "./score.js";
export { computeDatasetHash } from "./hash.js";
export { TIMEFRAME_MS, detectCandleGaps } from "./gaps.js";
export type { CandleGap } from "./gaps.js";
export {
  fetchStageBChecks,
  STAGE_B_TIMEOUT_MS,
  STAGE_B_UNAVAILABLE_DEDUCTION,
  StageBAuthError,
} from "./stage-b-client.js";

function logJson(
  level: "info" | "error",
  message: string,
  fields: Record<string, unknown>,
): void {
  try {
    const line = JSON.stringify({
      level,
      ts: new Date().toISOString(),
      module: "ingestion.dq",
      message,
      ...fields,
    });
    if (level === "error") console.error(line);
    else console.log(line);
  } catch {
    // logging must never throw
  }
}

/**
 * Run Stage A + Stage B over a candle batch, score the merged checks, persist
 * one DataQualityReport row, and return its identity + verdict.
 *
 * Persistence failures are logged and rethrown (fail-closed: callers must not
 * proceed as if a report exists).
 */
export async function validateAndReport(
  deps: {
    prisma: PrismaClient;
    quantBaseUrl: string | null;
    sharedSecret?: string;
  },
  scope: {
    exchange: Exchange;
    symbol: string;
    timeframe: Timeframe;
    from: Date;
    to: Date;
  },
  candles: NormalizedCandle[],
): Promise<{
  id: string;
  score: number;
  status: "PASSED" | "FAILED";
  datasetHash: string;
  /**
   * Present only when Stage B failed for an INFRA reason (fail-closed report was
   * still written). The pipeline layer turns this into a SYSTEM_HEALTH_DEGRADED
   * (WARN) event. AUTH failures never reach here — they throw StageBAuthError.
   */
  stageBHealth?: { category: "INFRA"; detail: string };
}> {
  const stageA = checkCandleBatch(candles, {
    timeframe: scope.timeframe,
    from: scope.from,
    to: scope.to,
  });

  const stageBDeps: { quantBaseUrl: string | null; sharedSecret?: string } = {
    quantBaseUrl: deps.quantBaseUrl,
  };
  if (deps.sharedSecret !== undefined) {
    stageBDeps.sharedSecret = deps.sharedSecret;
  }
  const stageB = await fetchStageBChecks(stageBDeps, candles);

  const checks: StructuralCheck[] = [...stageA, ...stageB];
  const { score, status } = scoreChecks(checks);
  const datasetHash = computeDatasetHash(candles);

  // Surface an INFRA Stage-B outage so the pipeline can emit a health event
  // (AUTH never lands here — it fails fast via StageBAuthError above).
  const infra = stageB.find(
    (c) => c.check === "stage_b_unavailable" && c.category === "INFRA",
  );
  const stageBHealth = infra
    ? { category: "INFRA" as const, detail: infra.detail }
    : undefined;

  try {
    const report = await deps.prisma.dataQualityReport.create({
      data: {
        exchange: scope.exchange,
        symbol: scope.symbol,
        timeframe: scope.timeframe,
        windowStart: scope.from,
        windowEnd: scope.to,
        score,
        status,
        checks: checks.map((c) => ({ ...c })),
        datasetHash,
      },
    });

    logJson("info", "data quality report written", {
      reportId: report.id,
      exchange: scope.exchange,
      symbol: scope.symbol,
      timeframe: scope.timeframe,
      windowStart: scope.from.toISOString(),
      windowEnd: scope.to.toISOString(),
      candleCount: candles.length,
      score,
      status,
      failedChecks: checks.filter((c) => !c.passed).map((c) => c.check),
    });

    return {
      id: report.id,
      score,
      status,
      datasetHash,
      ...(stageBHealth ? { stageBHealth } : {}),
    };
  } catch (err) {
    logJson("error", "failed to persist data quality report", {
      exchange: scope.exchange,
      symbol: scope.symbol,
      timeframe: scope.timeframe,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}
