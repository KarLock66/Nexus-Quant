/**
 * Seal-script destructive guard — localhost / opt-in policy (fail-closed).
 * Pure unit tests: no database, no Prisma client. Every case passes the URL and
 * env explicitly so process.env never leaks into assertions.
 */

import { describe, expect, it } from "vitest";
import {
  assertDestructiveDbAllowed,
  DESTRUCTIVE_DB_OPT_IN_ENV,
  DestructiveDbGuardError,
} from "./destructive-guard.js";

const NO_ENV: Record<string, string | undefined> = {};
const OPT_IN: Record<string, string | undefined> = { [DESTRUCTIVE_DB_OPT_IN_ENV]: "1" };

describe("assertDestructiveDbAllowed", () => {
  it.each([
    "postgresql://nexus:nexus_dev_password@localhost:5432/nexus_quant",
    "postgresql://nexus:pw@127.0.0.1:5432/nexus_quant",
    "postgresql://nexus:pw@[::1]:5432/nexus_quant",
    "postgresql://nexus:pw@LOCALHOST:5432/nexus_quant",
    "postgresql://localhost/nexus_quant",
  ])("allows local target: %s", (url) => {
    expect(() => assertDestructiveDbAllowed(url, NO_ENV)).not.toThrow();
  });

  it.each([
    "postgresql://nexus:pw@db.internal.example.com:5432/nexus_quant",
    "postgresql://nexus:pw@10.0.0.7:5432/nexus_quant",
    "postgresql://nexus:pw@prod-postgres:5432/nexus_quant", // compose service name
    "postgresql://nexus:pw@localhost.evil.com:5432/nexus_quant",
  ])("refuses non-local target: %s", (url) => {
    expect(() => assertDestructiveDbAllowed(url, NO_ENV)).toThrow(DestructiveDbGuardError);
  });

  it("refuses when DATABASE_URL is unset or empty (fail-closed)", () => {
    expect(() => assertDestructiveDbAllowed(undefined, NO_ENV)).toThrow(DestructiveDbGuardError);
    expect(() => assertDestructiveDbAllowed("", NO_ENV)).toThrow(DestructiveDbGuardError);
  });

  it("refuses an unparseable DATABASE_URL (fail-closed)", () => {
    expect(() => assertDestructiveDbAllowed("not a url", NO_ENV)).toThrow(DestructiveDbGuardError);
  });

  it(`${DESTRUCTIVE_DB_OPT_IN_ENV}=1 explicitly opts in a non-local target`, () => {
    expect(() =>
      assertDestructiveDbAllowed("postgresql://nexus:pw@ci-postgres:5432/nexus_quant", OPT_IN),
    ).not.toThrow();
  });

  it("opt-in must be exactly \"1\" — other values stay refused", () => {
    for (const v of ["true", "yes", "0", ""]) {
      expect(() =>
        assertDestructiveDbAllowed("postgresql://nexus:pw@ci-postgres:5432/nexus_quant", {
          [DESTRUCTIVE_DB_OPT_IN_ENV]: v,
        }),
      ).toThrow(DestructiveDbGuardError);
    }
  });

  it("refusal message names the offending host and the opt-in escape hatch", () => {
    try {
      assertDestructiveDbAllowed("postgresql://nexus:pw@prod-db:5432/nexus_quant", NO_ENV);
      expect.unreachable("guard should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(DestructiveDbGuardError);
      const message = (err as Error).message;
      expect(message).toContain('"prod-db"');
      expect(message).toContain(DESTRUCTIVE_DB_OPT_IN_ENV);
    }
  });
});
