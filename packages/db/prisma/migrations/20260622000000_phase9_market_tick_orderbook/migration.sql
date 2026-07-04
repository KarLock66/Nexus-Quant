-- Phase 9 — Real Market Data Integration.
-- Additive only: a new TradeSide enum + two market-data tables (MarketTick,
-- OrderbookSnapshot) for the live WebSocket feed. No existing table is altered.
-- Both PKs include "ts" so they can become TimescaleDB hypertables
-- (prisma/timescale.sql registers them).

-- CreateEnum
CREATE TYPE "TradeSide" AS ENUM ('BUY', 'SELL');

-- CreateTable
CREATE TABLE "MarketTick" (
    "exchange" "Exchange" NOT NULL,
    "symbol" TEXT NOT NULL,
    "ts" TIMESTAMP(3) NOT NULL,
    "tradeId" TEXT NOT NULL,
    "price" DECIMAL(20,8) NOT NULL,
    "size" DECIMAL(28,8) NOT NULL,
    "side" "TradeSide" NOT NULL,

    CONSTRAINT "MarketTick_pkey" PRIMARY KEY ("exchange","symbol","ts","tradeId")
);

-- CreateIndex
CREATE INDEX "MarketTick_symbol_ts_idx" ON "MarketTick"("symbol", "ts" DESC);

-- CreateTable
CREATE TABLE "OrderbookSnapshot" (
    "exchange" "Exchange" NOT NULL,
    "symbol" TEXT NOT NULL,
    "ts" TIMESTAMP(3) NOT NULL,
    "bestBid" DECIMAL(20,8) NOT NULL,
    "bestAsk" DECIMAL(20,8) NOT NULL,
    "bestBidSize" DECIMAL(28,8) NOT NULL,
    "bestAskSize" DECIMAL(28,8) NOT NULL,
    "markPrice" DECIMAL(20,8),
    "spreadBps" DECIMAL(10,4),
    "bids" JSONB,
    "asks" JSONB,

    CONSTRAINT "OrderbookSnapshot_pkey" PRIMARY KEY ("exchange","symbol","ts")
);

-- CreateIndex
CREATE INDEX "OrderbookSnapshot_symbol_ts_idx" ON "OrderbookSnapshot"("symbol", "ts" DESC);
