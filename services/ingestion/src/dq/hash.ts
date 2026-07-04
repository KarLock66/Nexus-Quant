/**
 * Dataset hashing for reproducibility lineage (datasetHash on every
 * DataQualityReport / Signal / AIAnalysis).
 *
 * Canonical JSON: object keys recursively sorted, Date -> ISO-8601 string,
 * undefined properties dropped. sha256 hex over the canonical serialization.
 */

import { createHash } from "node:crypto";

function canonicalize(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map((v) => canonicalize(v));
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const v = canonicalize((value as Record<string, unknown>)[key]);
      if (v !== undefined) out[key] = v;
    }
    return out;
  }
  return value;
}

/** sha256 hex over canonical JSON (sorted keys, Date -> ISO, undefined dropped). */
export function computeDatasetHash(rows: unknown[]): string {
  const canonical = JSON.stringify(canonicalize(rows));
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}
