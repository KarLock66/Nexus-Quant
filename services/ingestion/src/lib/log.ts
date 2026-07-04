/**
 * Structured JSON-lines logger for the ingestion service.
 *
 * Every line is a single JSON object with the fixed fields
 * `ts` / `service` / `level` / `msg` plus any caller-provided extras.
 * Errors go to stderr, everything else to stdout. Logging never throws.
 */

export function log(
  level: "info" | "warn" | "error",
  msg: string,
  extra?: object,
): void {
  try {
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      service: "ingestion",
      level,
      msg,
      ...extra,
    });
    if (level === "error") {
      console.error(line);
    } else {
      console.log(line);
    }
  } catch {
    // Logging must never throw (e.g. circular refs in extra).
    try {
      console.error(
        JSON.stringify({
          ts: new Date().toISOString(),
          service: "ingestion",
          level: "error",
          msg: "log serialization failed",
          original: msg,
        }),
      );
    } catch {
      // Give up silently — never crash the caller over a log line.
    }
  }
}
