/**
 * PortfolioLedger — persistent equity series over the live market account.
 * Verified with a fake Prisma client (no live DB): find-or-create identity,
 * peak-equity recovery across restarts, derived-verbatim persistence, drawdown
 * math, idempotent upsert shape, and fail-closed error propagation.
 */

import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@nexus/db";
import {
  PortfolioLedger,
  readPortfolioLedgerEnabled,
  readPortfolioLedgerIdentity,
} from "./portfolio-ledger.js";
import type { AccountValuation, Position } from "./types.js";

function fakePrisma(opts: { existing?: { id: string } | null; maxEquity?: string | null } = {}) {
  const upsert = vi.fn(async (_arg: unknown) => ({}));
  const prisma = {
    portfolio: {
      findFirst: vi.fn(async () => opts.existing ?? null),
      create: vi.fn(async () => ({ id: "pf-created" })),
    },
    portfolioSnapshot: {
      aggregate: vi.fn(async () => ({ _max: { equity: opts.maxEquity ?? null } })),
      upsert,
    },
  } as unknown as PrismaClient;
  return { prisma, upsert };
}

function valuation(equity: string, grossExposure: string): AccountValuation {
  return {
    cashBalance: equity,
    realizedPnl: "0.00",
    unrealizedPnl: "0.00",
    equity,
    marginUsed: "0.00",
    buyingPower: equity,
    grossExposure,
  };
}

const POSITIONS: Record<string, Position> = {
  "BTC-PERP": {
    symbol: "BTC-PERP",
    netQty: "0.00300000",
    avgEntryPrice: "62000.00000000",
    realizedPnl: "0.00",
    markPrice: "62000.00000000",
  },
};

function ledgerWith(prisma: PrismaClient) {
  return new PortfolioLedger({
    prisma,
    log: () => {},
    name: "production",
    baseCurrency: "USDT",
    initialValue: 1_000_000,
  });
}

describe("PortfolioLedger — identity & restart recovery", () => {
  it("creates the Portfolio row when none exists", async () => {
    const { prisma } = fakePrisma();
    await ledgerWith(prisma).init();
    expect(prisma.portfolio.create).toHaveBeenCalledWith({
      data: { name: "production", baseCurrency: "USDT", initialValue: "1000000.00" },
    });
  });

  it("reuses the existing Portfolio row (no duplicate identity)", async () => {
    const { prisma } = fakePrisma({ existing: { id: "pf-1" } });
    await ledgerWith(prisma).init();
    expect(prisma.portfolio.create).not.toHaveBeenCalled();
  });

  it("recovers the running PEAK equity from the persisted series (restart continuity)", async () => {
    const { prisma, upsert } = fakePrisma({ existing: { id: "pf-1" }, maxEquity: "1200000.00" });
    const ledger = ledgerWith(prisma);
    await ledger.init();
    // Equity below the recovered peak → drawdown measured against 1.2M, not 1M.
    await ledger.record(valuation("1080000.00", "0.00"), {}, new Date("2026-07-04T00:00:00Z"));
    const arg = upsert.mock.calls[0]![0] as { create: { drawdown: string } };
    expect(arg.create.drawdown).toBe("0.1000");
  });

  it("ignores a corrupt (non-finite) persisted peak and recovers from initialValue — never NaN (GAP C)", async () => {
    const { prisma, upsert } = fakePrisma({ existing: { id: "pf-1" }, maxEquity: "garbage" });
    const ledger = ledgerWith(prisma);
    await ledger.init();
    // Peak is initialValue (1M), NOT NaN: drawdown to 0.9M reads 0.1000, and a
    // NaN peak would instead have silently zeroed every subsequent drawdown.
    await ledger.record(valuation("900000.00", "0.00"), {}, new Date("2026-07-04T00:00:00Z"));
    const arg = upsert.mock.calls[0]![0] as { create: { drawdown: string } };
    expect(arg.create.drawdown).toBe("0.1000");
  });
});

describe("PortfolioLedger — snapshot persistence (derived VERBATIM)", () => {
  it("persists equity/exposure verbatim and positions losslessly, upserting on (portfolioId, ts)", async () => {
    const { prisma, upsert } = fakePrisma({ existing: { id: "pf-1" } });
    const ledger = ledgerWith(prisma);
    await ledger.init();
    const at = new Date("2026-07-04T12:00:00Z");
    await ledger.record(valuation("1000186.00", "186.00"), POSITIONS, at);
    expect(upsert).toHaveBeenCalledWith({
      where: { portfolioId_ts: { portfolioId: "pf-1", ts: at } },
      create: {
        portfolioId: "pf-1",
        ts: at,
        equity: "1000186.00",
        exposure: "186.00",
        drawdown: "0.0000",
        positions: POSITIONS,
      },
      update: {
        equity: "1000186.00",
        exposure: "186.00",
        drawdown: "0.0000",
        positions: POSITIONS,
      },
    });
  });

  it("drawdown is 0 at a new equity high and tracks the running peak after it", async () => {
    const { prisma, upsert } = fakePrisma({ existing: { id: "pf-1" } });
    const ledger = ledgerWith(prisma);
    await ledger.init();
    await ledger.record(valuation("1100000.00", "0.00"), {}, new Date("2026-07-04T00:00:00Z"));
    await ledger.record(valuation("990000.00", "0.00"), {}, new Date("2026-07-04T00:00:15Z"));
    const first = upsert.mock.calls[0]![0] as { create: { drawdown: string } };
    const second = upsert.mock.calls[1]![0] as { create: { drawdown: string } };
    expect(first.create.drawdown).toBe("0.0000");
    expect(second.create.drawdown).toBe("0.1000"); // (1.1M - 0.99M) / 1.1M
  });

  it("refuses to record before init (fail-closed)", async () => {
    const { prisma } = fakePrisma();
    await expect(
      ledgerWith(prisma).record(valuation("1000000.00", "0.00"), {}, new Date()),
    ).rejects.toThrow(/not initialized/);
  });

  it("propagates a write failure to the caller (never silently swallowed)", async () => {
    const { prisma, upsert } = fakePrisma({ existing: { id: "pf-1" } });
    upsert.mockRejectedValueOnce(new Error("db down"));
    const ledger = ledgerWith(prisma);
    await ledger.init();
    await expect(
      ledger.record(valuation("1000000.00", "0.00"), {}, new Date()),
    ).rejects.toThrow(/db down/);
  });
});

describe("PortfolioLedger — env wiring (opt-in, default-off)", () => {
  it("is DEFAULT-OFF and enabled only by PORTFOLIO_LEDGER=on", () => {
    expect(readPortfolioLedgerEnabled({})).toBe(false);
    expect(readPortfolioLedgerEnabled({ PORTFOLIO_LEDGER: "true" })).toBe(false);
    expect(readPortfolioLedgerEnabled({ PORTFOLIO_LEDGER: "on" })).toBe(true);
  });

  it("identity defaults to production/USDT with env overrides", () => {
    expect(readPortfolioLedgerIdentity({})).toEqual({ name: "production", baseCurrency: "USDT" });
    expect(
      readPortfolioLedgerIdentity({ PORTFOLIO_NAME: "live-1", PORTFOLIO_BASE_CURRENCY: "USDC" }),
    ).toEqual({ name: "live-1", baseCurrency: "USDC" });
  });
});
