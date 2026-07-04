/**
 * Phase 9.7 — Startup Validation (Section I), pure surface. Before the runtime may enter
 * HEALTHY the worker verifies Database, Redis, Quant, schema (required control tables),
 * and that freshness probes are wired. Those checks are IO and run in the worker
 * (`control/startup.ts`); this module owns the canonical required-check list and the
 * fail-closed aggregation: ANY failed check ⇒ the runtime must go BOOTING → FAILED
 * ("do not start partially").
 */

import type { StartupCheck, StartupValidation } from "./types.js";

/** The canonical startup checks, in execution order (names are stable identifiers). */
export const REQUIRED_STARTUP_CHECKS = [
  "database",
  "redis",
  "quant",
  "schema",
  "freshness_probes",
] as const;
export type StartupCheckName = (typeof REQUIRED_STARTUP_CHECKS)[number];

/**
 * Aggregate startup checks fail-closed: `passed` is true ONLY when every check passed.
 * (An empty/partial set is treated as not-passed — you cannot validate what you did not
 * run.)
 */
export function summarizeStartup(checks: StartupCheck[]): StartupValidation {
  const passed = checks.length > 0 && checks.every((c) => c.passed);
  return { passed, checks };
}
