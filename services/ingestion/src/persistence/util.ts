/**
 * Internal persistence helpers (not part of the pinned module surface).
 */

/** Split `items` into consecutive slices of at most `size` elements. */
export function chunk<T>(items: T[], size: number): T[][] {
  if (size <= 0) throw new Error(`chunk size must be positive, got ${size}`);
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

/** Normalize an unknown thrown value to a log-safe message. */
export function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
