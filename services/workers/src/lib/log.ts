/**
 * Structured JSON-lines logger for the workers service (mirrors the ingestion
 * logger). One JSON object per line; errors -> stderr; logging never throws.
 */

export function log(
  level: "info" | "warn" | "error",
  msg: string,
  extra?: object,
): void {
  try {
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      service: "workers",
      level,
      msg,
      ...extra,
    });
    if (level === "error") console.error(line);
    else console.log(line);
  } catch {
    // Logging must never throw.
  }
}

export function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
