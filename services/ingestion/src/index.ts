/**
 * Ingestion service runtime (Phase 9 — Real Market Data Integration).
 *
 * Replaces the Phase-0 heartbeat skeleton with the live ingestion daemon: for
 * each configured venue (INGEST_EXCHANGE) it resolves the ExchangeConnector,
 * runs the bootstrap warm-up, and starts the live WebSocket feed
 * (candles -> features, trades -> ticks, quotes -> orderbook, funding). The
 * worker service consumes the resulting FeatureSnapshots; no runtime code there
 * changes. Default INGEST_EXCHANGE is DERIBIT (the primary venue).
 *
 * Graceful shutdown stops every venue handle (final flush), closes the publisher,
 * and disconnects Prisma.
 */

import { prisma } from "@nexus/db";
import { env } from "./lib/env.js";
import { log } from "./lib/log.js";
import { resolveConnector } from "./connectors/index.js";
import { createPublisher } from "./lib/events.js";
import { runLiveIngestion, type LiveIngestionHandle } from "./pipeline/live.js";

const BACKFILL_DAYS_MS = env.ingestBackfillDays * 86_400_000;

async function main(): Promise<void> {
  log("info", "ingestion service starting (live market data)", {
    exchanges: env.ingestExchanges,
    symbols: env.ingestSymbols.map((s) => s.symbol),
    liveTimeframe: env.ingestLiveTimeframe,
    quant: env.quantServiceUrl !== null,
  });

  const publisher = createPublisher(env.redisUrl);
  const to = new Date();
  const from = new Date(to.getTime() - BACKFILL_DAYS_MS);

  const deps = {
    prisma,
    publish: publisher.publish.bind(publisher),
    quantBaseUrl: env.quantServiceUrl,
    ...(env.sharedSecret !== undefined ? { sharedSecret: env.sharedSecret } : {}),
  };

  const handles: LiveIngestionHandle[] = [];
  for (const exchange of env.ingestExchanges) {
    try {
      const connector = resolveConnector(exchange);
      const handle = await runLiveIngestion(
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
      );
      handles.push(handle);
    } catch (err) {
      // One venue failing to start must not take down the others (fail-isolated).
      log("error", "failed to start live ingestion for venue", {
        exchange,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (handles.length === 0) {
    throw new Error("no live ingestion venues started (fail-closed)");
  }

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    log("info", `received ${signal}, shutting down`);
    await Promise.allSettled(handles.map((h) => h.stop()));
    await publisher.close().catch(() => undefined);
    await prisma.$disconnect().catch(() => undefined);
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  log("error", "fatal", { error: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});
