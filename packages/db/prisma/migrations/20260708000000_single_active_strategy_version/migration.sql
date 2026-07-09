-- Batch 8: enforce the single-ACTIVE StrategyVersion invariant at the DATABASE
-- level. The application already pauses other ACTIVE versions before activating
-- (apps/web/src/lib/governance-actions.ts), but two concurrent approval
-- transactions can both read "no other ACTIVE" and both activate. This partial
-- unique index makes the database the final arbiter: the losing transaction
-- fails with a unique violation (Prisma P2002), which the governance layer maps
-- to its existing 409 conflict path.
--
-- Prisma's schema language cannot express partial indexes, so this migration is
-- raw SQL. schema.prisma documents the index on the StrategyVersion model.

-- Preflight (report-and-stop, no data mutation): if existing rows already
-- violate the invariant, refuse to create the index and list every offending
-- strategy so an operator can resolve them deliberately. This migration NEVER
-- deletes or mutates data.
DO $$
DECLARE
  dup RECORD;
  dup_count INTEGER := 0;
  dup_report TEXT := '';
BEGIN
  FOR dup IN
    SELECT "strategyId",
           COUNT(*) AS active_count,
           ARRAY_AGG(id ORDER BY "createdAt", id) AS version_ids
    FROM "StrategyVersion"
    WHERE status = 'ACTIVE'
    GROUP BY "strategyId"
    HAVING COUNT(*) > 1
  LOOP
    dup_count := dup_count + 1;
    dup_report := dup_report
      || format(' [strategyId=%s activeCount=%s versionIds=%s]',
                dup."strategyId", dup.active_count, dup.version_ids);
  END LOOP;

  IF dup_count > 0 THEN
    RAISE EXCEPTION
      'single-ACTIVE invariant already violated for % strateg%:%',
      dup_count, CASE WHEN dup_count = 1 THEN 'y' ELSE 'ies' END, dup_report
      USING HINT = 'Manually PAUSE/RETIRE all but one ACTIVE version per strategy '
                   '(via the audited governance path), then re-run the migration. '
                   'This migration intentionally does not modify data.';
  END IF;
END $$;

-- At most one ACTIVE version per strategy, enforced by Postgres.
CREATE UNIQUE INDEX "StrategyVersion_strategyId_active_key"
  ON "StrategyVersion" ("strategyId")
  WHERE status = 'ACTIVE';
