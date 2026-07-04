/**
 * DQ scoring: score = max(0, 100 - sum(deductions of failed checks)).
 * PASSED iff score >= MIN_DATA_QUALITY_SCORE (90) — the M5 hard floor.
 */

import { MIN_DATA_QUALITY_SCORE } from "@nexus/core";
import type { StructuralCheck } from "./checks.js";

export function scoreChecks(checks: StructuralCheck[]): {
  score: number;
  status: "PASSED" | "FAILED";
} {
  const totalDeduction = checks.reduce(
    (acc, c) => acc + (c.passed ? 0 : c.deduction),
    0,
  );
  const score = Math.max(0, 100 - totalDeduction);
  return {
    score,
    status: score >= MIN_DATA_QUALITY_SCORE ? "PASSED" : "FAILED",
  };
}
