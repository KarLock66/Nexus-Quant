/**
 * Feature bridge contract tests — network-free, DB-free.
 * The quant compute call goes through a stubbed global fetch; Prisma is a fake
 * with just the two methods the bridge touches. Verifies the opaque-hash
 * discipline (featureHash/features persisted verbatim) and fail-closed gates.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@nexus/db";
import { computeAndPersistFeatures, FeatureBridgeError } from "./bridge.js";
import type { NormalizedCandle } from "../connectors/types.js";

const AS_OF = "2026-06-22T00:00:00.000Z";

function computeResponse(over: Record<string, unknown> = {}): Response {
  return new Response(
    JSON.stringify({
      feature_set: "core-technical",
      version: 1,
      as_of_ts: AS_OF,
      featureHash: "opaque-hash-abc123",
      features: { ema_20: 30250, rsi_14: 63, realized_vol_30: 0.014 },
      input_candle_count: 250,
      dq_report_id: "dq-1",
      ...over,
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function stubFetch(res: () => Response): ReturnType<typeof vi.fn> {
  const mock = vi.fn(async () => res());
  vi.stubGlobal("fetch", mock);
  return mock;
}

function fakePrisma(over: { def?: { id: string } | null } = {}): {
  prisma: PrismaClient;
  upsert: ReturnType<typeof vi.fn>;
} {
  const upsert = vi.fn(async () => ({ id: "snap-1" }));
  const prisma = {
    featureSetDefinition: {
      findUnique: vi.fn(async () => (over.def === undefined ? { id: "fs-1" } : over.def)),
    },
    featureSnapshot: { upsert },
  } as unknown as PrismaClient;
  return { prisma, upsert };
}

const candles: NormalizedCandle[] = [
  {
    exchange: "DERIBIT",
    symbol: "BTC-PERP",
    assetType: "PERP",
    timeframe: "H1",
    ts: new Date("2026-06-21T23:00:00.000Z"),
    open: "30000",
    high: "30300",
    low: "29950",
    close: "30250",
    volume: "12.5",
  },
];

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("computeAndPersistFeatures", () => {
  it("persists one FeatureSnapshot with verbatim featureHash/features and publishes", async () => {
    stubFetch(() => computeResponse());
    const { prisma, upsert } = fakePrisma();
    const publish = vi.fn(async () => undefined);

    const out = await computeAndPersistFeatures(
      { prisma, quantBaseUrl: "http://quant", publish },
      {
        scope: { exchange: "DERIBIT", symbol: "BTC-PERP", timeframe: "H1" },
        candles,
        dqReportId: "dq-1",
        dqScore: 95,
      },
    );

    expect(out.id).toBe("snap-1");
    expect(out.featureHash).toBe("opaque-hash-abc123");
    expect(out.featureSetId).toBe("fs-1");
    expect(out.asOfTs.toISOString()).toBe(AS_OF);

    const call = upsert.mock.calls[0]?.[0] as {
      where: { exchange_symbol_timeframe_ts_featureSetId: Record<string, unknown> };
      create: { featureHash: string; features: Record<string, number>; ts: Date };
    };
    expect(call.where.exchange_symbol_timeframe_ts_featureSetId).toEqual({
      exchange: "DERIBIT",
      symbol: "BTC-PERP",
      timeframe: "H1",
      ts: new Date(AS_OF),
      featureSetId: "fs-1",
    });
    // Verbatim, never recomputed.
    expect(call.create.featureHash).toBe("opaque-hash-abc123");
    expect(call.create.features).toEqual({ ema_20: 30250, rsi_14: 63, realized_vol_30: 0.014 });

    expect(publish).toHaveBeenCalledWith(
      "feature.snapshot.created",
      expect.objectContaining({ snapshotId: "snap-1", featureHash: "opaque-hash-abc123" }),
    );
  });

  it("fails closed when DQ is below the minimum (no compute call)", async () => {
    const mock = stubFetch(() => computeResponse());
    const { prisma } = fakePrisma();
    await expect(
      computeAndPersistFeatures(
        { prisma, quantBaseUrl: "http://quant" },
        {
          scope: { exchange: "DERIBIT", symbol: "BTC-PERP", timeframe: "H1" },
          candles,
          dqReportId: "dq-1",
          dqScore: 80,
        },
      ),
    ).rejects.toBeInstanceOf(FeatureBridgeError);
    expect(mock).not.toHaveBeenCalled();
  });

  it("fails closed on a feature-set/version contract mismatch", async () => {
    stubFetch(() => computeResponse({ version: 2 }));
    const { prisma } = fakePrisma();
    await expect(
      computeAndPersistFeatures(
        { prisma, quantBaseUrl: "http://quant" },
        {
          scope: { exchange: "DERIBIT", symbol: "BTC-PERP", timeframe: "H1" },
          candles,
          dqReportId: "dq-1",
          dqScore: 95,
        },
      ),
    ).rejects.toBeInstanceOf(FeatureBridgeError);
  });

  it("fails closed when the feature set is not in the catalog", async () => {
    stubFetch(() => computeResponse());
    const { prisma } = fakePrisma({ def: null });
    await expect(
      computeAndPersistFeatures(
        { prisma, quantBaseUrl: "http://quant" },
        {
          scope: { exchange: "DERIBIT", symbol: "BTC-PERP", timeframe: "H1" },
          candles,
          dqReportId: "dq-1",
          dqScore: 95,
        },
      ),
    ).rejects.toBeInstanceOf(FeatureBridgeError);
  });
});
