/**
 * Persistent portfolio & equity ledger — Final production completion.
 *
 * Persists the live execution account (equity / exposure / drawdown / open
 * positions) as an append-only `PortfolioSnapshot` time series, closing the
 * "executed positions are not persisted" production blocker: the dashboard
 * portfolio card reads real rows, and equity/drawdown series exist for risk
 * evaluation and audit.
 *
 * Discipline:
 *  - DERIVED-ONLY: every persisted number comes VERBATIM from the market
 *    layer's event-sourced state (`valuateAccount` output + the Position map).
 *    Nothing is recomputed, simulated, or fabricated here.
 *  - Idempotent: snapshots upsert on (portfolioId, ts) — a retried tick or a
 *    replay writes the same row, not a near-duplicate.
 *  - Restart-safe: `init()` finds-or-creates the Portfolio row by name and
 *    recovers the running PEAK equity from the persisted series, so drawdown
 *    is continuous across process restarts (the in-memory market state itself
 *    is recovered from the Phase 7 journal by the existing boot path).
 *  - Fail-closed reporting: a write failure THROWS to the caller (the tick
 *    wrapper logs it CRITICAL); it is never silently swallowed here.
 */

import type { PrismaClient } from "@nexus/db";
import type { log as Logger } from "../lib/log.js";
import { parseDecimal, quantizePnl } from "./money.js";
import type { AccountValuation, Position } from "./types.js";

export interface PortfolioLedgerConfig {
  prisma: PrismaClient;
  log: typeof Logger;
  /** Portfolio identity (find-or-create by name). */
  name: string;
  baseCurrency: string;
  /** Opening capital — the market account's configured initial cash. */
  initialValue: number;
}

/** Drawdown precision matches the DB Decimal(8,4). */
function quantizeDrawdown(n: number): string {
  const v = Number.isFinite(n) && n > 0 ? n : 0;
  return Math.min(v, 1).toFixed(4);
}

export class PortfolioLedger {
  private readonly prisma: PrismaClient;
  private readonly log: typeof Logger;
  private readonly name: string;
  private readonly baseCurrency: string;
  private readonly initialValue: number;

  private portfolioId: string | null = null;
  private peakEquity = 0;

  constructor(config: PortfolioLedgerConfig) {
    this.prisma = config.prisma;
    this.log = config.log;
    this.name = config.name;
    this.baseCurrency = config.baseCurrency;
    this.initialValue = config.initialValue;
  }

  /**
   * Resolve the Portfolio row (find-or-create by name) and recover the running
   * peak equity from the persisted series. Must complete before record().
   */
  async init(): Promise<void> {
    const existing = await this.prisma.portfolio.findFirst({ where: { name: this.name } });
    const portfolio =
      existing ??
      (await this.prisma.portfolio.create({
        data: {
          name: this.name,
          baseCurrency: this.baseCurrency,
          initialValue: quantizePnl(this.initialValue),
        },
      }));
    this.portfolioId = portfolio.id;

    const peak = await this.prisma.portfolioSnapshot.aggregate({
      where: { portfolioId: portfolio.id },
      _max: { equity: true },
    });
    const rawPeak = peak._max.equity !== null ? Number(peak._max.equity) : 0;
    // Finite guard (Phase 11C GAP C): a corrupt persisted Decimal would otherwise
    // poison the running peak (NaN survives Math.max). An unusable aggregate is
    // LOGGED and treated as absent — initialValue wins below, nothing repaired.
    if (!Number.isFinite(rawPeak)) {
      this.log("error", "portfolio ledger: persisted peak equity is not finite — ignoring persisted series peak, recovering from initialValue", {
        portfolioId: portfolio.id,
      });
    }
    const recoveredPeak = Number.isFinite(rawPeak) ? rawPeak : 0;
    this.peakEquity = Math.max(recoveredPeak, this.initialValue);

    this.log("info", "portfolio ledger initialized (persistent equity series)", {
      portfolioId: portfolio.id,
      name: this.name,
      created: existing === null,
      peakEquity: this.peakEquity,
    });
  }

  /**
   * Persist one snapshot of the live account at `at`. Equity/exposure are the
   * market layer's derived valuation VERBATIM; drawdown is measured against the
   * recovered running peak. Upserts on (portfolioId, ts) — idempotent.
   */
  async record(
    valuation: AccountValuation,
    positions: Record<string, Position>,
    at: Date,
  ): Promise<void> {
    if (this.portfolioId === null) {
      throw new Error("portfolio ledger not initialized — refusing to record (fail-closed)");
    }
    const equity = parseDecimal(valuation.equity);
    this.peakEquity = Math.max(this.peakEquity, equity);
    const drawdown =
      this.peakEquity > 0 ? (this.peakEquity - equity) / this.peakEquity : 0;

    await this.prisma.portfolioSnapshot.upsert({
      where: { portfolioId_ts: { portfolioId: this.portfolioId, ts: at } },
      create: {
        portfolioId: this.portfolioId,
        ts: at,
        equity: valuation.equity,
        exposure: valuation.grossExposure,
        drawdown: quantizeDrawdown(drawdown),
        positions: positions as object,
      },
      update: {
        equity: valuation.equity,
        exposure: valuation.grossExposure,
        drawdown: quantizeDrawdown(drawdown),
        positions: positions as object,
      },
    });
  }
}

/** PORTFOLIO_LEDGER=on enables the persistent ledger (opt-in, default-off). */
export function readPortfolioLedgerEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env["PORTFOLIO_LEDGER"] === "on";
}

/** Portfolio identity for the ledger (defaults suit the single-account runtime). */
export function readPortfolioLedgerIdentity(
  env: Record<string, string | undefined> = process.env,
): { name: string; baseCurrency: string } {
  const name = (env["PORTFOLIO_NAME"] ?? "").trim();
  const baseCurrency = (env["PORTFOLIO_BASE_CURRENCY"] ?? "").trim();
  return {
    name: name === "" ? "production" : name,
    baseCurrency: baseCurrency === "" ? "USDT" : baseCurrency,
  };
}
