import { EXCHANGES } from "@nexus/core";

/**
 * Ingestion service bootstrap (Phase 0 skeleton).
 *
 * Phase 1 adds: Binance/Deribit/Bybit connectors (REST backfill + WebSocket
 * live), canonical normalization, Stage-A structural DQ checks, persistence,
 * and gap detection. Until then this process only proves the service wiring
 * (build, container, env, graceful shutdown).
 */
function log(level: "info" | "error", msg: string, extra?: object) {
  console.log(
    JSON.stringify({
      ts: new Date().toISOString(),
      service: "ingestion",
      level,
      msg,
      ...extra,
    }),
  );
}

async function main() {
  log("info", "ingestion service starting (phase 0 skeleton)", {
    exchanges: EXCHANGES,
  });

  const shutdown = (signal: string) => {
    log("info", `received ${signal}, shutting down`);
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  // Keep the process alive; Phase 1 replaces this with connector lifecycles.
  setInterval(() => log("info", "heartbeat"), 60_000);
}

main().catch((err) => {
  log("error", "fatal", { error: String(err) });
  process.exit(1);
});
