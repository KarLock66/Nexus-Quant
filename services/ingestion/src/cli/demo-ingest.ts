/**
 * Demo ingest CLI — runs a full deterministic backfill through the SAME
 * pipeline as live venues (DQ gateway included), using the Demo connector.
 *
 *   pnpm --filter @nexus/ingestion demo:ingest
 *
 * Reads env (see .env.example): DEMO_SEED, INGEST_SYMBOLS, INGEST_TIMEFRAMES,
 * INGEST_OPTION_UNDERLYINGS, INGEST_BACKFILL_DAYS, REDIS_URL,
 * QUANT_SERVICE_URL, QUANT_SERVICE_SHARED_SECRET.
 *
 * Option chains are NOT backfillable (they are live snapshots); this CLI
 * additionally fetches one current chain per underlying and persists it
 * directly via upsertOptionChain.
 *
 * Prints a single summary JSON line including `demoDatasetHash` — a sha256
 * over the canonical JSON of every generated candle (recomputed through
 * connector.fetchCandles) so two machines can diff their demo datasets.
 */

import { prisma } from "@nexus/db";
import { TIMEFRAMES, type Timeframe } from "@nexus/core";
import { createDemoConnector } from "../connectors/demo.js";
import type { NormalizedCandle } from "../connectors/types.js";
import { computeDatasetHash } from "../dq/hash.js";
import { createPublisher } from "../lib/events.js";
import { runBackfill } from "../pipeline/backfill.js";
import { upsertOptionChain } from "../persistence/index.js";

function log(
  level: "info" | "warn" | "error",
  msg: string,
  extra?: Record<string, unknown>,
): void {
  console.log(
    JSON.stringify({
      ts: new Date().toISOString(),
      service: "ingestion",
      component: "demo-ingest-cli",
      level,
      msg,
      ...extra,
    }),
  );
}

interface CliEnv {
  seed: number;
  backfillDays: number;
  symbols: string[];
  timeframes: Timeframe[];
  underlyings: string[];
  redisUrl: string;
  quantBaseUrl: string;
  sharedSecret: string;
}

function csv(value: string | undefined, fallback: string): string[] {
  return (value !== undefined && value.trim() !== "" ? value : fallback)
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");
}

/** Fail-closed env parsing: malformed values abort the run with a reason. */
function readEnv(): CliEnv {
  // Zero-demo discipline: this CLI writes deterministic synthetic rows into the
  // SAME market tables as live venues — running it requires the explicit
  // platform-wide demo opt-in, exactly like the DEMO connector in the daemon.
  const demoMode = ["true", "1", "yes"].includes(
    (process.env["DEMO_MODE"] ?? "").trim().toLowerCase(),
  );
  if (!demoMode) {
    throw new Error(
      "demo-ingest writes synthetic DEMO-venue rows into the shared market tables. " +
        "Set DEMO_MODE=true to opt in (never on a production database).",
    );
  }
  const seed = Number.parseInt(process.env["DEMO_SEED"] ?? "42", 10);
  if (!Number.isInteger(seed)) {
    throw new Error(`invalid DEMO_SEED: ${process.env["DEMO_SEED"]}`);
  }
  const backfillDays = Number.parseInt(
    process.env["INGEST_BACKFILL_DAYS"] ?? "730",
    10,
  );
  if (!Number.isInteger(backfillDays) || backfillDays <= 0) {
    throw new Error(
      `invalid INGEST_BACKFILL_DAYS: ${process.env["INGEST_BACKFILL_DAYS"]}`,
    );
  }
  const symbols = csv(
    process.env["INGEST_SYMBOLS"],
    "BTC-USDT,ETH-USDT,BTC-PERP,ETH-PERP",
  );
  const rawTimeframes = csv(process.env["INGEST_TIMEFRAMES"], "H1,H4,D1");
  const timeframes: Timeframe[] = [];
  for (const tf of rawTimeframes) {
    if (!(TIMEFRAMES as readonly string[]).includes(tf)) {
      throw new Error(
        `invalid INGEST_TIMEFRAMES entry "${tf}" (valid: ${TIMEFRAMES.join(",")})`,
      );
    }
    timeframes.push(tf as Timeframe);
  }
  const underlyings = csv(process.env["INGEST_OPTION_UNDERLYINGS"], "BTC,ETH");
  return {
    seed,
    backfillDays,
    symbols,
    timeframes,
    underlyings,
    redisUrl: process.env["REDIS_URL"] ?? "redis://localhost:6379",
    quantBaseUrl: process.env["QUANT_SERVICE_URL"] ?? "http://localhost:8000",
    sharedSecret: process.env["QUANT_SERVICE_SHARED_SECRET"] ?? "",
  };
}

/**
 * Recompute every candle in the window through the connector (pure,
 * deterministic) and hash the canonical JSON. Symbols/timeframes are
 * sorted so the hash is independent of env ordering.
 */
async function computeDemoDatasetHash(
  connector: ReturnType<typeof createDemoConnector>,
  env: CliEnv,
  from: Date,
  to: Date,
): Promise<{ hash: string; candleCount: number }> {
  const symbols = [...env.symbols].sort();
  const timeframes = [...env.timeframes].sort(
    (a, b) => TIMEFRAMES.indexOf(a) - TIMEFRAMES.indexOf(b),
  );
  const all: NormalizedCandle[] = [];
  for (const symbol of symbols) {
    const assetType = symbol.endsWith("-PERP") ? "PERP" : "SPOT";
    for (const timeframe of timeframes) {
      const candles = await connector.fetchCandles({
        symbol,
        assetType,
        timeframe,
        from,
        to,
      });
      all.push(...candles);
    }
  }
  return { hash: computeDatasetHash(all), candleCount: all.length };
}

async function main(): Promise<void> {
  const env = readEnv();
  if (process.env["DEMO_MODE"] !== "true") {
    log("warn", "DEMO_MODE is not 'true' — proceeding anyway (demo data is namespaced as exchange DEMO)");
  }

  const to = new Date();
  const from = new Date(to.getTime() - env.backfillDays * 86_400_000);
  const connector = createDemoConnector(env.seed);
  const publisher = createPublisher(env.redisUrl);

  const deps = {
    prisma,
    publish: publisher.publish.bind(publisher),
    quantBaseUrl: env.quantBaseUrl,
    sharedSecret: env.sharedSecret,
  };

  log("info", "demo backfill starting", {
    seed: env.seed,
    symbols: env.symbols,
    timeframes: env.timeframes,
    underlyings: env.underlyings,
    from: from.toISOString(),
    to: to.toISOString(),
  });

  const summary = await runBackfill(
    connector,
    {
      symbols: env.symbols.map((symbol) => ({
        symbol,
        assetType: symbol.endsWith("-PERP") ? "PERP" : "SPOT",
      })),
      timeframes: env.timeframes,
      from,
      to,
      underlyings: env.underlyings,
    },
    deps,
  );

  // Option chains are live snapshots — not backfillable — so persist one
  // current chain per underlying here.
  const chains: Array<{ underlying: string; ts: string; contracts: number }> = [];
  for (const underlying of env.underlyings) {
    const chain = await connector.fetchOptionChain(underlying);
    if (chain === null) {
      // Fail-closed: an unknown underlying is a configuration error.
      throw new Error(`demo connector returned no chain for underlying "${underlying}"`);
    }
    await upsertOptionChain(prisma, chain);
    chains.push({
      underlying,
      ts: chain.ts.toISOString(),
      contracts: chain.contracts.length,
    });
    log("info", "option chain persisted", {
      underlying,
      ts: chain.ts.toISOString(),
      contracts: chain.contracts.length,
    });
  }

  const { hash, candleCount } = await computeDemoDatasetHash(
    connector,
    env,
    from,
    to,
  );

  // Final machine-readable summary (single line, parseable).
  console.log(
    JSON.stringify({
      ts: new Date().toISOString(),
      service: "ingestion",
      component: "demo-ingest-cli",
      level: "info",
      msg: "demo ingest complete",
      seed: env.seed,
      from: from.toISOString(),
      to: to.toISOString(),
      summary,
      optionChains: chains,
      hashedCandles: candleCount,
      demoDatasetHash: hash,
    }),
  );
}

main()
  .then(async () => {
    await prisma.$disconnect().catch(() => undefined);
    process.exit(0);
  })
  .catch(async (err: unknown) => {
    log("error", "demo ingest failed", {
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
    await prisma.$disconnect().catch(() => undefined);
    process.exit(1);
  });
