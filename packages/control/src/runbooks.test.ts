import { describe, expect, it } from "vitest";
import {
  allRunbooks,
  applicableRunbooks,
  PROTECTION_RULE_IDS,
  runbookFor,
  RUNBOOKS,
  type RunbookKey,
} from "./index.js";

const ALL_KEYS: RunbookKey[] = [
  ...PROTECTION_RULE_IDS,
  "kill_switch.engaged",
  "startup.failed",
];

/** Reject obviously-generic placeholder text — Section F forbids it. */
const PLACEHOLDER = /\b(tbd|todo|placeholder|lorem|xxx|fixme|coming soon)\b/i;

describe("operator runbooks (F) — complete & specific", () => {
  it("has a runbook for every protection rule + kill switch + startup failure", () => {
    for (const key of ALL_KEYS) {
      expect(RUNBOOKS[key], `missing runbook: ${key}`).toBeDefined();
      expect(runbookFor(key).key).toBe(key);
    }
    expect(allRunbooks()).toHaveLength(ALL_KEYS.length);
  });

  it("every runbook fills all five fields with real, non-placeholder text", () => {
    for (const rb of allRunbooks()) {
      // Title is a short label; the prose fields must be substantive.
      expect(rb.title.trim().length, `${rb.key}.title empty`).toBeGreaterThan(3);
      expect(PLACEHOLDER.test(rb.title), `${rb.key}.title placeholder`).toBe(false);
      for (const field of ["problem", "impact", "diagnosis", "requiredAction"] as const) {
        expect(rb[field].trim().length, `${rb.key}.${field} empty`).toBeGreaterThan(20);
        expect(PLACEHOLDER.test(rb[field]), `${rb.key}.${field} placeholder`).toBe(false);
      }
      expect(rb.verificationSteps.length, `${rb.key} has no verification steps`).toBeGreaterThan(0);
      for (const step of rb.verificationSteps) {
        expect(step.trim().length).toBeGreaterThan(5);
        expect(PLACEHOLDER.test(step)).toBe(false);
      }
    }
  });

  it("surfaces the right runbooks for the live situation", () => {
    const rbs = applicableRunbooks({
      activeRuleIds: ["database.unavailable", "quant.unavailable"],
      killEngaged: true,
      startupFailed: false,
    });
    const keys = rbs.map((r) => r.key);
    expect(keys).toContain("kill_switch.engaged");
    expect(keys).toContain("database.unavailable");
    expect(keys).toContain("quant.unavailable");
    expect(keys).not.toContain("startup.failed");
  });

  it("returns nothing applicable when all clear", () => {
    expect(
      applicableRunbooks({ activeRuleIds: [], killEngaged: false, startupFailed: false }),
    ).toHaveLength(0);
  });
});
