-- TimescaleDB conversion — run once after the initial Prisma migration:
--   psql "$DATABASE_URL" -f packages/db/prisma/timescale.sql
-- (Will be folded into a Prisma migration's migration.sql in Phase 1.)
--
-- Market-data tables have composite PKs that include "ts", which satisfies
-- Timescale's requirement that unique constraints contain the partition column.

CREATE EXTENSION IF NOT EXISTS timescaledb;

SELECT create_hypertable('"MarketCandle"', 'ts', migrate_data => true, if_not_exists => true);
SELECT create_hypertable('"FundingRate"', 'ts', migrate_data => true, if_not_exists => true);
SELECT create_hypertable('"OpenInterestSnapshot"', 'ts', migrate_data => true, if_not_exists => true);
SELECT create_hypertable('"LongShortRatio"', 'ts', migrate_data => true, if_not_exists => true);
SELECT create_hypertable('"OptionsChainSnapshot"', 'ts', migrate_data => true, if_not_exists => true);
SELECT create_hypertable('"OptionContractSnapshot"', 'ts', migrate_data => true, if_not_exists => true);
SELECT create_hypertable('"LiquiditySnapshot"', 'ts', migrate_data => true, if_not_exists => true);

-- Phase 9 — live WebSocket feed tables (raw ticks + top-of-book/mark snapshots).
SELECT create_hypertable('"MarketTick"', 'ts', migrate_data => true, if_not_exists => true);
SELECT create_hypertable('"OrderbookSnapshot"', 'ts', migrate_data => true, if_not_exists => true);

-- MarketTick is the highest-cardinality stream — compress after 7 days.
ALTER TABLE "MarketTick" SET (timescaledb.compress, timescaledb.compress_segmentby = 'exchange,symbol');
SELECT add_compression_policy('"MarketTick"', INTERVAL '7 days', if_not_exists => true);

-- Compression: candles older than 30 days (raw M1 retention handled by drop policy)
ALTER TABLE "MarketCandle" SET (timescaledb.compress, timescaledb.compress_segmentby = 'exchange,symbol,timeframe');
SELECT add_compression_policy('"MarketCandle"', INTERVAL '30 days', if_not_exists => true);

-- Strike-level option chain rows are the platform's largest table by far:
-- compress aggressively after 7 days (reads beyond that window are analytical).
ALTER TABLE "OptionContractSnapshot" SET (timescaledb.compress, timescaledb.compress_segmentby = 'exchange,underlying');
SELECT add_compression_policy('"OptionContractSnapshot"', INTERVAL '7 days', if_not_exists => true);

-- M2 advisory constraint enforced at the database layer:
-- AI analyses may only lower confidence, never raise it.
ALTER TABLE "AIAnalysis"
  ADD CONSTRAINT ai_confidence_adjustment_nonpositive
  CHECK ("confidenceAdjustment" <= 0);

-- Ops alerting concurrency guard: at most ONE ACTIVE alert row per rule.
-- GET /api/v1/ops/alerts evaluates + persists on every poll from every open tab;
-- without this index two overlapping requests can both miss the existing ACTIVE
-- row and both insert one (duplicate active alerts, inflated counts). Any
-- duplicates that predate the constraint are resolved first (newest survives).
UPDATE "OpsAlert" SET "status" = 'RESOLVED', "resolvedAt" = NOW()
WHERE "id" IN (
  SELECT "id" FROM (
    SELECT "id", ROW_NUMBER() OVER (PARTITION BY "ruleId" ORDER BY "lastSeen" DESC, "id" DESC) AS rn
    FROM "OpsAlert" WHERE "status" = 'ACTIVE'
  ) ranked
  WHERE ranked.rn > 1
);
CREATE UNIQUE INDEX IF NOT EXISTS "OpsAlert_ruleId_active_key"
  ON "OpsAlert"("ruleId") WHERE "status" = 'ACTIVE';
