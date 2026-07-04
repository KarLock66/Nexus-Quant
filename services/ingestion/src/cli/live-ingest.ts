/**
 * Live ingest CLI — a BOUNDED run of the live daemon for manual smoke testing.
 *
 *   pnpm --filter @nexus/ingestion live:ingest
 *
 * Runs bootstrap + the live stream for INGEST_RUN_MS (default 60s) against the
 * configured venues, then stops and prints a single summary JSON line with the
 * persisted row counts (candles / ticks / orderbook / funding / features). For a
 * long-running daemon use `pnpm --filter @nexus/ingestion start` instead.
 */

import { prisma } from "@nexus/db";
import { env } from "../lib/env.js";
import { resolveConnector } from "../connectors/index.js";
import { createPublisher } from "../lib/events.js";
import { runLiveIngestion } from "../pipeline/live.js";

function log(level: "info" | "error", msg: string, extra?: Record<string, unknown>): void {
  console.log(
    JSON.stringify({ ts: new Date().toISOString(), service: "ingestion", component: "live-ingest-cli", level, msg, ...extra }),
  );
}

const RUN_MS = Number.parseInt(process.env["INGEST_RUN_MS"] ?? "60000", 10);

async function main(): Promise<void> {
  const to = new Date();
  const from = new Date(to.getTime() - env.ingestBackfillDays * 86_400_000);
  const publisher = createPublisher(env.redisUrl);
  const deps = {
    prisma,
    publish: publisher.publish.bind(publisher),
    quantBaseUrl: env.quantServiceUrl,
    ...(env.sharedSecret !== undefined ? { sharedSecret: env.sharedSecret } : {}),
  };

  log("info", "live ingest starting", {
    exchanges: env.ingestExchanges,
    liveTimeframe: env.ingestLiveTimeframe,
    runMs: RUN_MS,
  });

  const handles = [];
  for (const exchange of env.ingestExchanges) {
    const connector = resolveConnector(exchange);
    handles.push(
      await runLiveIngestion(
        connector,
        {
          symbols: env.ingestSymbols,
          liveTimeframe: env.ingestLiveTimeframe,
          underlyings: env.ingestOptionUnderlyings,
          backfillFrom: from,
          backfillTo: to,
          flowPollMs: env.ingestFlowPollMs,
          featureSet: env.featureSet,
          featureVersion: env.featureVersion,
        },
        deps,
      ),
    );
  }

  await new Promise((resolve) => setTimeout(resolve, RUN_MS));
  await Promise.allSettled(handles.map((h) => h.stop()));
  await publisher.close().catch(() => undefined);

  const [candles, ticks, orderbook, funding, features] = await Promise.all([
    prisma.marketCandle.count(),
    prisma.marketTick.count(),
    prisma.orderbookSnapshot.count(),
    prisma.fundingRate.count(),
    prisma.featureSnapshot.count(),
  ]);

  console.log(
    JSON.stringify({
      ts: new Date().toISOString(),
      service: "ingestion",
      component: "live-ingest-cli",
      level: "info",
      msg: "live ingest complete",
      exchanges: env.ingestExchanges,
      counts: { candles, ticks, orderbook, funding, features },
    }),
  );
}

main()
  .then(async () => {
    await prisma.$disconnect().catch(() => undefined);
    process.exit(0);
  })
  .catch(async (err: unknown) => {
    log("error", "live ingest failed", {
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
    await prisma.$disconnect().catch(() => undefined);
    process.exit(1);
  });
