/**
 * Backfill pipeline — REST history -> idempotent persistence -> DQ gateway.
 *
 * Per symbol+timeframe: fetchCandles -> upsertCandles -> validateAndReport
 * -> publish data.quality.report. Capability-gated flow data (funding / OI /
 * LSR -> data.flow.ingested), option chains per underlying
 * (data.options.chain.ingested), and a liquidity snapshot per symbol.
 *
 * Absent capabilities are skipped WITHOUT error (capability-gated, not
 * error-driven). Per-scope failures are logged, counted, and isolated — the
 * rest of the backfill proceeds; the closing heartbeat reports FAILED when
 * any scope errored (fail-closed observability, no silent degradation).
 */

import type { PrismaClient } from "@nexus/db";
import type { AssetType, Exchange, Timeframe } from "@nexus/core";
import type { ExchangeConnector, NormalizedCandle } from "../connectors/types.js";
import { StageBAuthError, validateAndReport } from "../dq/index.js";
import {
  heartbeat,
  upsertCandles,
  upsertFundingRates,
  upsertLiquidity,
  upsertLongShortRatios,
  upsertOpenInterest,
  upsertOptionChain,
} from "../persistence/index.js";
import { log } from "../lib/log.js";

export interface PipelineDeps {
  prisma: PrismaClient;
  publish: (name: string, payload: object) => Promise<void>;
  quantBaseUrl: string | null;
  sharedSecret?: string;
  /**
   * OPT-IN (Phase 9): invoked after a candle window PASSES DQ, with the candles
   * and the persisted report — the live daemon wires this to the feature bridge
   * (compute + persist a FeatureSnapshot). Omitted (demo-ingest, tests) =
   * byte-for-byte prior behavior. A throw here is isolated per scope (logged +
   * counted), never aborting the rest of the backfill.
   */
  onCandlesValidated?: (args: {
    scope: { exchange: Exchange; symbol: string; timeframe: Timeframe; from: Date; to: Date };
    candles: NormalizedCandle[];
    report: { id: string; score: number; status: "PASSED" | "FAILED" };
  }) => Promise<void>;
}

export interface BackfillOptions {
  symbols: Array<{ symbol: string; assetType: AssetType }>;
  timeframes: Timeframe[];
  from: Date;
  to: Date;
  underlyings: string[];
}

export interface BackfillSummary {
  candles: number;
  funding: number;
  oi: number;
  lsr: number;
  optionContracts: number;
  dqReports: Array<{ scope: string; score: number; status: string }>;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function latestTs(rows: Array<{ ts: Date }>): Date | null {
  let latest: Date | null = null;
  for (const row of rows) {
    if (latest === null || row.ts.getTime() > latest.getTime()) latest = row.ts;
  }
  return latest;
}

export async function runBackfill(
  connector: ExchangeConnector,
  opts: BackfillOptions,
  deps: PipelineDeps,
): Promise<BackfillSummary> {
  const job = `backfill:${connector.exchange}`;
  const summary: BackfillSummary = {
    candles: 0,
    funding: 0,
    oi: 0,
    lsr: 0,
    optionContracts: 0,
    dqReports: [],
  };
  const errors: Array<{ scope: string; error: string }> = [];

  await heartbeat(deps.prisma, job, "RUNNING", {
    from: opts.from.toISOString(),
    to: opts.to.toISOString(),
    symbols: opts.symbols.map((s) => s.symbol),
    timeframes: opts.timeframes,
    underlyings: opts.underlyings,
  });

  const dqDeps: {
    prisma: PrismaClient;
    quantBaseUrl: string | null;
    sharedSecret?: string;
  } = { prisma: deps.prisma, quantBaseUrl: deps.quantBaseUrl };
  if (deps.sharedSecret !== undefined) dqDeps.sharedSecret = deps.sharedSecret;

  // ── Candles + structural/statistical DQ per symbol+timeframe ─────────────
  if (connector.capabilities.candles) {
    for (const { symbol, assetType } of opts.symbols) {
      for (const timeframe of opts.timeframes) {
        const scope = `${connector.exchange}:${symbol}:${timeframe}`;
        try {
          const candles = await connector.fetchCandles({
            symbol,
            assetType,
            timeframe,
            from: opts.from,
            to: opts.to,
          });
          summary.candles += await upsertCandles(deps.prisma, candles);
          const report = await validateAndReport(
            dqDeps,
            {
              exchange: connector.exchange,
              symbol,
              timeframe,
              from: opts.from,
              to: opts.to,
            },
            candles,
          );
          summary.dqReports.push({
            scope,
            score: report.score,
            status: report.status,
          });
          await deps.publish("data.quality.report", {
            reportId: report.id,
            exchange: connector.exchange,
            symbol,
            score: report.score,
            status: report.status,
          });
          // Phase 9 feature bridge (opt-in): admitted data → FeatureSnapshot.
          if (deps.onCandlesValidated && report.status === "PASSED") {
            try {
              await deps.onCandlesValidated({
                scope: { exchange: connector.exchange, symbol, timeframe, from: opts.from, to: opts.to },
                candles,
                report: { id: report.id, score: report.score, status: report.status },
              });
            } catch (err) {
              errors.push({ scope: `${scope}:features`, error: errMsg(err) });
              log("error", "backfill feature bridge failed", { scope, error: errMsg(err) });
            }
          }
          // INFRA Stage-B outage: report was written fail-closed; surface it as
          // a health signal (WARN) so an outage is not mistaken for corruption.
          if (report.stageBHealth) {
            await deps.publish("system.health.degraded", {
              component: "quant.stage-b",
              category: report.stageBHealth.category,
              severity: "WARN",
              detail: report.stageBHealth.detail,
            });
          }
        } catch (err) {
          // AUTH misconfig fails fast — emit a CRITICAL health signal even though
          // no report exists, then record the scope as failed (fail-closed).
          if (err instanceof StageBAuthError) {
            await deps.publish("system.health.degraded", {
              component: "quant.stage-b",
              category: "AUTH",
              severity: "CRITICAL",
              detail: err.message,
            });
          }
          errors.push({ scope, error: errMsg(err) });
          log("error", "backfill candle scope failed", {
            scope,
            error: errMsg(err),
          });
        }
      }
    }
  } else {
    log("info", "connector has no candle capability — skipping candles", {
      exchange: connector.exchange,
    });
  }

  // ── Flow data per symbol (funding / OI / LSR), capability-gated ──────────
  for (const { symbol } of opts.symbols) {
    const flowReq = { symbol, from: opts.from, to: opts.to };

    if (connector.capabilities.funding) {
      const scope = `${connector.exchange}:${symbol}:funding`;
      try {
        const rows = await connector.fetchFundingRates(flowReq);
        summary.funding += await upsertFundingRates(deps.prisma, rows);
        const ts = latestTs(rows);
        if (ts !== null) {
          await deps.publish("data.flow.ingested", {
            exchange: connector.exchange,
            symbol,
            kind: "FUNDING",
            ts: ts.toISOString(),
          });
        }
      } catch (err) {
        errors.push({ scope, error: errMsg(err) });
        log("error", "backfill funding scope failed", { scope, error: errMsg(err) });
      }
    }

    if (connector.capabilities.openInterest) {
      const scope = `${connector.exchange}:${symbol}:oi`;
      try {
        const rows = await connector.fetchOpenInterest(flowReq);
        summary.oi += await upsertOpenInterest(deps.prisma, rows);
        const ts = latestTs(rows);
        if (ts !== null) {
          await deps.publish("data.flow.ingested", {
            exchange: connector.exchange,
            symbol,
            kind: "OPEN_INTEREST",
            ts: ts.toISOString(),
          });
        }
      } catch (err) {
        errors.push({ scope, error: errMsg(err) });
        log("error", "backfill open-interest scope failed", { scope, error: errMsg(err) });
      }
    }

    if (connector.capabilities.longShortRatio) {
      const scope = `${connector.exchange}:${symbol}:lsr`;
      try {
        const rows = await connector.fetchLongShortRatios(flowReq);
        summary.lsr += await upsertLongShortRatios(deps.prisma, rows);
        const ts = latestTs(rows);
        if (ts !== null) {
          await deps.publish("data.flow.ingested", {
            exchange: connector.exchange,
            symbol,
            kind: "LONG_SHORT_RATIO",
            ts: ts.toISOString(),
          });
        }
      } catch (err) {
        errors.push({ scope, error: errMsg(err) });
        log("error", "backfill long-short-ratio scope failed", { scope, error: errMsg(err) });
      }
    }

    if (connector.capabilities.liquidity) {
      const scope = `${connector.exchange}:${symbol}:liquidity`;
      try {
        const row = await connector.fetchLiquidity(symbol);
        if (row !== null) {
          await upsertLiquidity(deps.prisma, row);
        } else {
          log("info", "no liquidity snapshot returned — skipped", { scope });
        }
      } catch (err) {
        errors.push({ scope, error: errMsg(err) });
        log("error", "backfill liquidity scope failed", { scope, error: errMsg(err) });
      }
    }
  }

  // ── Option chains per underlying, capability-gated ───────────────────────
  if (connector.capabilities.optionChain) {
    for (const underlying of opts.underlyings) {
      const scope = `${connector.exchange}:${underlying}:options`;
      try {
        const chain = await connector.fetchOptionChain(underlying);
        if (chain === null) {
          log("warn", "no option chain returned — skipped", { scope });
          continue;
        }
        const contractCount = await upsertOptionChain(deps.prisma, chain);
        summary.optionContracts += contractCount;
        await deps.publish("data.options.chain.ingested", {
          exchange: connector.exchange,
          underlying,
          ts: chain.ts.toISOString(),
          contractCount,
        });
      } catch (err) {
        errors.push({ scope, error: errMsg(err) });
        log("error", "backfill option-chain scope failed", { scope, error: errMsg(err) });
      }
    }
  }

  const status = errors.length === 0 ? "OK" : "FAILED";
  await heartbeat(deps.prisma, job, status, {
    candles: summary.candles,
    funding: summary.funding,
    oi: summary.oi,
    lsr: summary.lsr,
    optionContracts: summary.optionContracts,
    dqReports: summary.dqReports.length,
    errors,
  });
  log(errors.length === 0 ? "info" : "error", "backfill finished", {
    job,
    status,
    ...summary,
    dqReports: summary.dqReports.length,
    errorCount: errors.length,
  });

  return summary;
}
