/**
 * Stage-A DQ unit tests — network-free and database-free.
 * Fixtures are inline; prisma is a mock object; global fetch is stubbed.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@nexus/db";
import type { NormalizedCandle } from "../connectors/types.js";
import {
  checkCandleBatch,
  computeDatasetHash,
  detectCandleGaps,
  scoreChecks,
  StageBAuthError,
  validateAndReport,
} from "./index.js";
import type { StructuralCheck } from "./index.js";

const H1_MS = 3_600_000;
const START = new Date("2024-01-01T00:00:00.000Z"); // grid-aligned whole hour

function makeCandles(n: number): NormalizedCandle[] {
  const out: NormalizedCandle[] = [];
  for (let i = 0; i < n; i += 1) {
    out.push({
      exchange: "BINANCE",
      symbol: "BTC-USDT",
      assetType: "SPOT",
      timeframe: "H1",
      ts: new Date(START.getTime() + i * H1_MS),
      open: "100.00000000",
      high: "110.00000000",
      low: "90.00000000",
      close: "105.00000000",
      volume: "1000.00000000",
    });
  }
  return out;
}

function windowFor(n: number): { from: Date; to: Date } {
  return { from: START, to: new Date(START.getTime() + n * H1_MS) };
}

function byName(
  checks: StructuralCheck[],
  name: string,
): StructuralCheck {
  const found = checks.find((c) => c.check === name);
  if (!found) throw new Error(`check not found: ${name}`);
  return found;
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

describe("checkCandleBatch + scoreChecks", () => {
  it("clean 100-bar H1 fixture scores 100 PASSED", () => {
    const candles = makeCandles(100);
    const { from, to } = windowFor(100);
    const checks = checkCandleBatch(candles, { timeframe: "H1", from, to });

    expect(checks).toHaveLength(4);
    for (const c of checks) {
      expect(c.passed).toBe(true);
      expect(c.deduction).toBe(0);
    }
    expect(scoreChecks(checks)).toEqual({ score: 100, status: "PASSED" });
  });

  it("3-bar gap fails the gaps check with correct missingBars and deduction", () => {
    const candles = makeCandles(100).filter((_, i) => i < 10 || i > 12);
    const { from, to } = windowFor(100);
    const checks = checkCandleBatch(candles, { timeframe: "H1", from, to });

    const gaps = byName(checks, "gaps");
    expect(gaps.passed).toBe(false);
    // missingPct = 3/100*100 = 3 -> ceil(3 * 2.5) = 8
    expect(gaps.deduction).toBe(8);
    expect(gaps.detail).toContain("3 missing of 100");

    expect(byName(checks, "schema_conformance").passed).toBe(true);
    expect(byName(checks, "duplicates").passed).toBe(true);
    expect(byName(checks, "timestamp_monotonic").passed).toBe(true);
    expect(scoreChecks(checks)).toEqual({ score: 92, status: "PASSED" });
  });

  it("duplicate ts fails the duplicates check only", () => {
    const candles = makeCandles(100);
    const five = candles[5];
    if (!five) throw new Error("fixture too small");
    candles.splice(6, 0, { ...five }); // adjacent clone keeps order sorted
    const { from, to } = windowFor(100);
    const checks = checkCandleBatch(candles, { timeframe: "H1", from, to });

    const dup = byName(checks, "duplicates");
    expect(dup.passed).toBe(false);
    expect(dup.deduction).toBe(20);
    expect(dup.detail).toContain("1 duplicate row(s)");
    expect(byName(checks, "timestamp_monotonic").passed).toBe(true);
    expect(byName(checks, "gaps").passed).toBe(true);
    expect(scoreChecks(checks)).toEqual({ score: 80, status: "FAILED" });
  });

  it("high < low row fails schema_conformance", () => {
    const candles = makeCandles(100);
    const seven = candles[7];
    if (!seven) throw new Error("fixture too small");
    candles[7] = { ...seven, high: "80.00000000", low: "90.00000000" };
    const { from, to } = windowFor(100);
    const checks = checkCandleBatch(candles, { timeframe: "H1", from, to });

    const schema = byName(checks, "schema_conformance");
    expect(schema.passed).toBe(false);
    expect(schema.deduction).toBe(40);
    expect(schema.detail).toContain("high_lt_low");
    expect(schema.detail).toContain(seven.ts.toISOString());
    expect(byName(checks, "gaps").passed).toBe(true);
    expect(scoreChecks(checks)).toEqual({ score: 60, status: "FAILED" });
  });

  it("NaN price and negative volume fail schema_conformance", () => {
    const candles = makeCandles(10);
    const zero = candles[0];
    const one = candles[1];
    if (!zero || !one) throw new Error("fixture too small");
    candles[0] = { ...zero, open: "NaN" };
    candles[1] = { ...one, volume: "-5" };
    const { from, to } = windowFor(10);
    const checks = checkCandleBatch(candles, { timeframe: "H1", from, to });

    const schema = byName(checks, "schema_conformance");
    expect(schema.passed).toBe(false);
    expect(schema.detail).toContain("2/10 rows");
    expect(schema.detail).toContain("negative_volume");
  });

  it("shuffled order fails timestamp_monotonic", () => {
    const candles = makeCandles(100);
    const a = candles[20];
    const b = candles[21];
    if (!a || !b) throw new Error("fixture too small");
    candles[20] = b;
    candles[21] = a;
    const { from, to } = windowFor(100);
    const checks = checkCandleBatch(candles, { timeframe: "H1", from, to });

    const mono = byName(checks, "timestamp_monotonic");
    expect(mono.passed).toBe(false);
    expect(mono.deduction).toBe(15);
    expect(mono.detail).toContain("unsorted:1");
    expect(byName(checks, "gaps").passed).toBe(true);
    expect(byName(checks, "duplicates").passed).toBe(true);
    expect(scoreChecks(checks)).toEqual({ score: 85, status: "FAILED" });
  });

  it("off-grid timestamp fails timestamp_monotonic", () => {
    const candles = makeCandles(10);
    const three = candles[3];
    if (!three) throw new Error("fixture too small");
    candles[3] = { ...three, ts: new Date(three.ts.getTime() + 1) };
    const { from, to } = windowFor(10);
    const checks = checkCandleBatch(candles, { timeframe: "H1", from, to });

    const mono = byName(checks, "timestamp_monotonic");
    expect(mono.passed).toBe(false);
    expect(mono.detail).toContain("off_grid:1");
  });

  it("combined corruption drops the score below 90 -> FAILED", () => {
    const candles = makeCandles(100).filter((_, i) => i < 30 || i > 32); // 3-bar gap
    const bad = candles[0];
    const dup = candles[10];
    if (!bad || !dup) throw new Error("fixture too small");
    candles[0] = { ...bad, high: "1.0", low: "200.0" }; // schema violation
    candles.splice(11, 0, { ...dup }); // duplicate
    const { from, to } = windowFor(100);
    const checks = checkCandleBatch(candles, { timeframe: "H1", from, to });

    const { score, status } = scoreChecks(checks);
    // schema 40 + duplicates 20 + gaps 8 = 68 -> score 32
    expect(score).toBe(32);
    expect(status).toBe("FAILED");
  });

  it("scoreChecks floors at 0 and treats passed deductions as 0", () => {
    const checks: StructuralCheck[] = [
      { check: "a", passed: false, deduction: 60, detail: "" },
      { check: "b", passed: false, deduction: 60, detail: "" },
      { check: "c", passed: true, deduction: 99, detail: "" },
    ];
    expect(scoreChecks(checks)).toEqual({ score: 0, status: "FAILED" });
  });
});

describe("detectCandleGaps", () => {
  it("returns exact half-open ranges for an interior gap", () => {
    const candles = makeCandles(100).filter((_, i) => i < 10 || i > 12);
    const { from, to } = windowFor(100);
    const gaps = detectCandleGaps(
      candles.map((c) => c.ts),
      "H1",
      from,
      to,
    );

    expect(gaps).toEqual([
      {
        from: new Date(START.getTime() + 10 * H1_MS),
        to: new Date(START.getTime() + 13 * H1_MS),
        missingBars: 3,
      },
    ]);
  });

  it("detects leading and trailing gaps as separate ranges", () => {
    const candles = makeCandles(100).filter((_, i) => i !== 0 && i !== 99);
    const { from, to } = windowFor(100);
    const gaps = detectCandleGaps(
      candles.map((c) => c.ts),
      "H1",
      from,
      to,
    );

    expect(gaps).toEqual([
      { from: START, to: new Date(START.getTime() + H1_MS), missingBars: 1 },
      {
        from: new Date(START.getTime() + 99 * H1_MS),
        to: new Date(START.getTime() + 100 * H1_MS),
        missingBars: 1,
      },
    ]);
  });

  it("returns no gaps for a complete window and an empty window", () => {
    const candles = makeCandles(24);
    const { from, to } = windowFor(24);
    expect(
      detectCandleGaps(candles.map((c) => c.ts), "H1", from, to),
    ).toEqual([]);
    expect(detectCandleGaps([], "H1", from, from)).toEqual([]);
  });
});

describe("computeDatasetHash", () => {
  it("is deterministic for identical rows and changes when a row changes", () => {
    const rows = makeCandles(10);
    const h1 = computeDatasetHash(rows);
    const h2 = computeDatasetHash(makeCandles(10));
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);

    const mutated = makeCandles(10);
    const zero = mutated[0];
    if (!zero) throw new Error("fixture too small");
    mutated[0] = { ...zero, close: "105.00000001" };
    expect(computeDatasetHash(mutated)).not.toBe(h1);
  });

  it("canonicalizes key order, Dates, and drops undefined", () => {
    const ts = new Date("2024-01-01T00:00:00.000Z");
    const a = [{ open: "1", close: "2", ts }];
    const b = [{ ts: "2024-01-01T00:00:00.000Z", close: "2", open: "1" }];
    expect(computeDatasetHash(a)).toBe(computeDatasetHash(b));

    const withUndefined = [{ open: "1", close: "2", ts, trades: undefined }];
    expect(computeDatasetHash(withUndefined)).toBe(computeDatasetHash(a));
  });
});

describe("validateAndReport", () => {
  function makePrismaMock() {
    const create = vi.fn(
      async (args: { data: Record<string, unknown> }) => ({
        id: "dq_test_1",
        createdAt: new Date(),
        ...args.data,
      }),
    );
    return {
      create,
      prisma: { dataQualityReport: { create } } as unknown as PrismaClient,
    };
  }

  const scope = {
    exchange: "BINANCE",
    symbol: "BTC-USDT",
    timeframe: "H1",
    from: START,
    to: new Date(START.getTime() + 100 * H1_MS),
  } as const;

  it("null quantBaseUrl fail-closes via stage_b_unavailable INFRA (score 85, FAILED)", async () => {
    const { prisma, create } = makePrismaMock();
    const candles = makeCandles(100);

    const result = await validateAndReport(
      { prisma, quantBaseUrl: null },
      scope,
      candles,
    );

    expect(result).toEqual({
      id: "dq_test_1",
      score: 85,
      status: "FAILED",
      datasetHash: computeDatasetHash(candles),
      stageBHealth: {
        category: "INFRA",
        detail:
          "statistical checks unavailable (fail-closed): quantBaseUrl not configured",
      },
    });
    expect(create).toHaveBeenCalledTimes(1);

    const data = create.mock.calls[0]?.[0]?.data as Record<string, unknown>;
    expect(data["exchange"]).toBe("BINANCE");
    expect(data["symbol"]).toBe("BTC-USDT");
    expect(data["timeframe"]).toBe("H1");
    expect(data["windowStart"]).toEqual(scope.from);
    expect(data["windowEnd"]).toEqual(scope.to);
    expect(data["score"]).toBe(85);
    expect(data["status"]).toBe("FAILED");

    const checks = data["checks"] as StructuralCheck[];
    expect(checks).toHaveLength(5);
    const stageB = byName(checks, "stage_b_unavailable");
    expect(stageB.passed).toBe(false);
    expect(stageB.deduction).toBe(15);
    expect(stageB.category).toBe("INFRA"); // taxonomy tag, score unchanged
  });

  it("fails fast (throws StageBAuthError) on a 401 — no report persisted", async () => {
    const { prisma, create } = makePrismaMock();
    const candles = makeCandles(10);
    const smallScope = { ...scope, to: new Date(START.getTime() + 10 * H1_MS) };

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status: 401,
        json: async () => ({}),
      })) as unknown as typeof fetch,
    );

    await expect(
      validateAndReport(
        { prisma, quantBaseUrl: "http://quant.test:8000" },
        smallScope,
        candles,
      ),
    ).rejects.toBeInstanceOf(StageBAuthError);
    // Fail-fast: AUTH never degrades to a deduction and never writes a report.
    expect(create).not.toHaveBeenCalled();
  });

  it("merges stage B checks on success and sends secret header + ISO body", async () => {
    const { prisma, create } = makePrismaMock();
    const candles = makeCandles(100);
    const stageBChecks: StructuralCheck[] = [
      { check: "outlier_detection", passed: true, deduction: 0, detail: "ok" },
      { check: "volume_anomaly", passed: true, deduction: 0, detail: "ok" },
    ];
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => stageBChecks,
    }));
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    const result = await validateAndReport(
      {
        prisma,
        quantBaseUrl: "http://quant.test:8000",
        sharedSecret: "secret123",
      },
      scope,
      candles,
    );

    expect(result.score).toBe(100);
    expect(result.status).toBe("PASSED");
    expect(result.id).toBe("dq_test_1");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      { method: string; headers: Record<string, string>; body: string },
    ];
    expect(url).toBe("http://quant.test:8000/dq/statistical");
    expect(init.method).toBe("POST");
    expect(init.headers["X-Internal-Secret"]).toBe("secret123");
    const body = JSON.parse(init.body) as {
      candles: Array<Record<string, string>>;
      referenceCloses: null;
    };
    expect(body.referenceCloses).toBeNull();
    expect(body.candles).toHaveLength(100);
    expect(body.candles[0]).toEqual({
      ts: "2024-01-01T00:00:00.000Z",
      open: "100.00000000",
      high: "110.00000000",
      low: "90.00000000",
      close: "105.00000000",
      volume: "1000.00000000",
    });

    const data = create.mock.calls[0]?.[0]?.data as Record<string, unknown>;
    const checks = data["checks"] as StructuralCheck[];
    expect(checks).toHaveLength(6); // 4 stage A + 2 stage B
    expect(byName(checks, "outlier_detection").passed).toBe(true);
  });

  it("fail-closes when the stage B call rejects", async () => {
    const { prisma, create } = makePrismaMock();
    const candles = makeCandles(100);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      }) as unknown as typeof fetch,
    );

    const result = await validateAndReport(
      { prisma, quantBaseUrl: "http://quant.test:8000" },
      scope,
      candles,
    );

    expect(result.score).toBe(85);
    expect(result.status).toBe("FAILED");
    const data = create.mock.calls[0]?.[0]?.data as Record<string, unknown>;
    const stageB = byName(data["checks"] as StructuralCheck[], "stage_b_unavailable");
    expect(stageB.deduction).toBe(15);
    expect(stageB.detail).toContain("ECONNREFUSED");
  });

  it("fail-closes on non-OK status and malformed payload", async () => {
    const { prisma } = makePrismaMock();
    const candles = makeCandles(10);
    const smallScope = { ...scope, to: new Date(START.getTime() + 10 * H1_MS) };

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}) })) as unknown as typeof fetch,
    );
    const r1 = await validateAndReport(
      { prisma, quantBaseUrl: "http://quant.test:8000" },
      smallScope,
      candles,
    );
    expect(r1.score).toBe(85);

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ unexpected: true }),
      })) as unknown as typeof fetch,
    );
    const r2 = await validateAndReport(
      { prisma, quantBaseUrl: "http://quant.test:8000" },
      smallScope,
      candles,
    );
    expect(r2.score).toBe(85);
  });

  it("rethrows when report persistence fails (fail-closed)", async () => {
    const create = vi.fn(async () => {
      throw new Error("db down");
    });
    const prisma = {
      dataQualityReport: { create },
    } as unknown as PrismaClient;

    await expect(
      validateAndReport({ prisma, quantBaseUrl: null }, scope, makeCandles(10)),
    ).rejects.toThrow("db down");
  });
});
