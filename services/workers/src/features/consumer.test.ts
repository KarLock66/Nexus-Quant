/**
 * STEP 10 verification — production Feature Store consumer.
 *
 * Proves the worker persists the quant service's output VERBATIM:
 *   - featureHash persisted byte-identically (opaque string, never recomputed)
 *   - feature vector persisted byte-identically (no key reorder, no rounding)
 *   - feature-key casing preserved exactly
 *   - replay input (dq_report_id, as_of_ts, scope) preserved
 *
 * The feature vector + featureHash are REAL output of services/quant
 * compute_core_technical (see __fixtures__/core-technical-authentic.json).
 * Network and DB are exercised through the production code paths; only the
 * external HTTP and Prisma boundaries are doubled (no Docker/Postgres on this
 * host — same convention as dq.test.ts).
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@nexus/db";
import {
  consumeFeatureComputation,
  FeatureAdmissionError,
  FeatureComputeAuthError,
  UnknownFeatureSetError,
} from "./index.js";
import type { FeatureComputeInput } from "./index.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(
  readFileSync(join(HERE, "../__fixtures__/core-technical-authentic.json"), "utf8"),
) as {
  feature_set: string;
  version: number;
  as_of_ts: string;
  featureHash: string;
  features: Record<string, number>;
  input_candle_count: number;
  dq_report_id: string;
};

// The exact response body bytes the quant service would return.
const RESPONSE_BODY = JSON.stringify({
  feature_set: fixture.feature_set,
  version: fixture.version,
  as_of_ts: fixture.as_of_ts,
  featureHash: fixture.featureHash,
  features: fixture.features,
  input_candle_count: fixture.input_candle_count,
  dq_report_id: fixture.dq_report_id,
});

function baseInput(): FeatureComputeInput {
  return {
    dqReportId: fixture.dq_report_id,
    dqScore: 95,
    scope: {
      exchange: "BINANCE",
      symbol: "BTC-USDT",
      timeframe: "H1",
      ts: new Date(fixture.as_of_ts),
    },
    featureSet: "core-technical",
    version: 1,
    marketData: {
      candles: [
        {
          ts: fixture.as_of_ts,
          open: "100.00000000",
          high: "100.10000000",
          low: "99.90000000",
          close: "100.00000000",
          volume: "1000.00000000",
        },
      ],
    },
  };
}

interface UpsertArgs {
  where: unknown;
  create: Record<string, unknown>;
  update: Record<string, unknown>;
  select: unknown;
}

function makePrisma() {
  const upsert = vi.fn(async (_args: UpsertArgs) => ({ id: "fs_test_1" }));
  const findUnique = vi.fn(async (_args: unknown) => ({
    id: "fsd_core_technical_v1",
    name: "core-technical",
    version: 1,
  }));
  const prisma = {
    featureSnapshot: { upsert },
    featureSetDefinition: { findUnique },
  } as unknown as PrismaClient;
  return { prisma, upsert, findUnique };
}

function stubFetch(body: string, status = 200) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: status >= 200 && status < 300,
      status,
      text: async () => body,
    })) as unknown as typeof fetch,
  );
}

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("consumeFeatureComputation — verbatim persistence", () => {
  it("persists featureHash byte-identically (opaque, never recomputed)", async () => {
    const { prisma, upsert } = makePrisma();
    stubFetch(RESPONSE_BODY);

    const result = await consumeFeatureComputation(
      { prisma, quantBaseUrl: "http://quant.test:8000" },
      baseInput(),
    );

    expect(result.featureHash).toBe(fixture.featureHash);
    const data = upsert.mock.calls[0]?.[0]?.create as Record<string, unknown>;
    // Exact string equality with the service value — no normalization/recompute.
    expect(data["featureHash"]).toBe(fixture.featureHash);
    expect(data["featureHash"]).toMatch(/^[0-9a-f]{64}$/);
  });

  it("persists the feature vector byte-identically (no reorder, no rounding)", async () => {
    const { prisma, upsert } = makePrisma();
    stubFetch(RESPONSE_BODY);

    await consumeFeatureComputation(
      { prisma, quantBaseUrl: "http://quant.test:8000" },
      baseInput(),
    );

    const data = upsert.mock.calls[0]?.[0]?.create as Record<string, unknown>;
    const persisted = data["features"];
    const fromWire = (JSON.parse(RESPONSE_BODY) as { features: unknown }).features;

    // Deep equality + identical serialization == byte-identical pass-through.
    expect(persisted).toEqual(fromWire);
    expect(JSON.stringify(persisted)).toBe(JSON.stringify(fromWire));
    // The persisted vector still hashes-source-of-truth value (sanity, not recompute).
    expect(persisted).toEqual(fixture.features);
  });

  it("preserves feature-key casing exactly", async () => {
    const { prisma, upsert } = makePrisma();
    stubFetch(RESPONSE_BODY);

    await consumeFeatureComputation(
      { prisma, quantBaseUrl: "http://quant.test:8000" },
      baseInput(),
    );

    const data = upsert.mock.calls[0]?.[0]?.create as Record<string, unknown>;
    const keys = Object.keys(data["features"] as object);
    expect(keys).toEqual(Object.keys(fixture.features));
    // Snake_case casing intact; no camelCase / uppercase transformation.
    expect(keys).toContain("ema_20");
    expect(keys).toContain("ema_200");
    expect(keys).toContain("donchian_mid_20");
    expect(keys).toContain("volume_zscore_100");
    for (const k of keys) expect(k).toBe(k.toLowerCase());
  });

  it("preserves the replay input (dq_report_id, as_of_ts, scope)", async () => {
    const { prisma, upsert } = makePrisma();
    stubFetch(RESPONSE_BODY);

    await consumeFeatureComputation(
      { prisma, quantBaseUrl: "http://quant.test:8000" },
      baseInput(),
    );

    const data = upsert.mock.calls[0]?.[0]?.create as Record<string, unknown>;
    expect(data["dqReportId"]).toBe(fixture.dq_report_id);
    expect(data["ts"]).toEqual(new Date(fixture.as_of_ts));
    expect(data["exchange"]).toBe("BINANCE");
    expect(data["symbol"]).toBe("BTC-USDT");
    expect(data["timeframe"]).toBe("H1");
    expect(data["featureSetId"]).toBe("fsd_core_technical_v1");
  });

  it("publishes feature.snapshot.created with the opaque hash", async () => {
    const { prisma } = makePrisma();
    stubFetch(RESPONSE_BODY);
    const publish = vi.fn(async (_name: string, _payload: object) => undefined);

    await consumeFeatureComputation(
      { prisma, quantBaseUrl: "http://quant.test:8000", publish },
      baseInput(),
    );

    expect(publish).toHaveBeenCalledTimes(1);
    const [name, payload] = publish.mock.calls[0] as unknown as [
      string,
      Record<string, unknown>,
    ];
    expect(name).toBe("feature.snapshot.created");
    expect(payload["featureHash"]).toBe(fixture.featureHash);
    expect(payload["snapshotId"]).toBe("fs_test_1");
  });
});

describe("consumeFeatureComputation — fail-closed", () => {
  it("refuses inadmissible data (dq_score < 90) without calling the service", async () => {
    const { prisma, upsert } = makePrisma();
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy as unknown as typeof fetch);

    await expect(
      consumeFeatureComputation(
        { prisma, quantBaseUrl: "http://quant.test:8000" },
        { ...baseInput(), dqScore: 89 },
      ),
    ).rejects.toBeInstanceOf(FeatureAdmissionError);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(upsert).not.toHaveBeenCalled();
  });

  it("fails fast on 401 (auth misconfig) and persists nothing", async () => {
    const { prisma, upsert } = makePrisma();
    stubFetch("{}", 401);

    await expect(
      consumeFeatureComputation(
        { prisma, quantBaseUrl: "http://quant.test:8000" },
        baseInput(),
      ),
    ).rejects.toBeInstanceOf(FeatureComputeAuthError);
    expect(upsert).not.toHaveBeenCalled();
  });

  it("refuses to persist when the feature set is not in the catalog", async () => {
    const { prisma, upsert, findUnique } = makePrisma();
    findUnique.mockResolvedValueOnce(null as never);
    stubFetch(RESPONSE_BODY);

    await expect(
      consumeFeatureComputation(
        { prisma, quantBaseUrl: "http://quant.test:8000" },
        baseInput(),
      ),
    ).rejects.toBeInstanceOf(UnknownFeatureSetError);
    expect(upsert).not.toHaveBeenCalled();
  });
});
