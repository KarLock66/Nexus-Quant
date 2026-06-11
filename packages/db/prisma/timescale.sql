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
SELECT create_hypertable('"OptionsChainSnapshot"', 'ts', migrate_data => true, if_not_exists => true);
SELECT create_hypertable('"LiquiditySnapshot"', 'ts', migrate_data => true, if_not_exists => true);

-- Compression: candles older than 30 days (raw M1 retention handled by drop policy)
ALTER TABLE "MarketCandle" SET (timescaledb.compress, timescaledb.compress_segmentby = 'exchange,symbol,timeframe');
SELECT add_compression_policy('"MarketCandle"', INTERVAL '30 days', if_not_exists => true);

-- M2 advisory constraint enforced at the database layer:
-- AI analyses may only lower confidence, never raise it.
ALTER TABLE "AIAnalysis"
  ADD CONSTRAINT ai_confidence_adjustment_nonpositive
  CHECK ("confidenceAdjustment" <= 0);
