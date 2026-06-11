import { EVENTS } from "@nexus/events";

/**
 * Workers service bootstrap (Phase 0 skeleton).
 *
 * Hosts, in later phases: the M1 signal pipeline orchestrator + gate chain,
 * M2 agent orchestrator (Research/Risk/Options/Governance), M3 calibration,
 * M8 regime refresh, M10 capacity assessment, and the defense-framework
 * monitors. BullMQ queues attach in Phase 1 alongside Redis.
 */
function log(level: "info" | "error", msg: string, extra?: object) {
  console.log(
    JSON.stringify({
      ts: new Date().toISOString(),
      service: "workers",
      level,
      msg,
      ...extra,
    }),
  );
}

async function main() {
  log("info", "workers service starting (phase 0 skeleton)", {
    knownEvents: Object.values(EVENTS).length,
  });

  const shutdown = (signal: string) => {
    log("info", `received ${signal}, shutting down`);
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  setInterval(() => log("info", "heartbeat"), 60_000);
}

main().catch((err) => {
  log("error", "fatal", { error: String(err) });
  process.exit(1);
});
