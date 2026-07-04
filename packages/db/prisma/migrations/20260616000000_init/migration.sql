-- Baseline (init) migration - Phase 0/1 schema.
-- Forward-consistent prerequisite for 20260616152134_engine_signal, which is
-- additive and references StrategyVersion / FeatureSnapshot / DataQualityReport.
-- Generated from prisma/schema.prisma via `prisma migrate diff --from-empty`,
-- excluding the SignalDecision enum + EngineSignal table (created by the later
-- engine_signal migration so that migration remains unchanged).

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "Exchange" AS ENUM ('BINANCE', 'DERIBIT', 'BYBIT', 'DEMO');

-- CreateEnum
CREATE TYPE "AssetType" AS ENUM ('SPOT', 'PERP', 'OPTION');

-- CreateEnum
CREATE TYPE "Timeframe" AS ENUM ('M1', 'M5', 'M15', 'H1', 'H4', 'D1');

-- CreateEnum
CREATE TYPE "SignalState" AS ENUM ('STRONG_BUY', 'BUY', 'NEUTRAL', 'SELL', 'STRONG_SELL');

-- CreateEnum
CREATE TYPE "SignalStatus" AS ENUM ('ACTIVE', 'TARGET_HIT', 'STOPPED', 'INVALIDATED', 'EXPIRED', 'REQUIRES_MANUAL_REVIEW', 'CAPACITY_DEFERRED');

-- CreateEnum
CREATE TYPE "MarketRegime" AS ENUM ('TRENDING_BULL', 'TRENDING_BEAR', 'RANGE_BOUND', 'HIGH_VOL', 'LOW_VOL', 'PANIC', 'EUPHORIA');

-- CreateEnum
CREATE TYPE "GateType" AS ENUM ('DATA_QUALITY', 'RISK_REWARD', 'POSITION_SIZE', 'MARKET_REGIME', 'VOLATILITY_FILTER', 'RISK_MODE');

-- CreateEnum
CREATE TYPE "AgentType" AS ENUM ('RESEARCH', 'RISK', 'OPTIONS', 'GOVERNANCE');

-- CreateEnum
CREATE TYPE "OptionType" AS ENUM ('CALL', 'PUT');

-- CreateEnum
CREATE TYPE "LsRatioScope" AS ENUM ('GLOBAL_ACCOUNTS', 'TOP_TRADER_ACCOUNTS', 'TOP_TRADER_POSITIONS');

-- CreateEnum
CREATE TYPE "FeatureDomain" AS ENUM ('TECHNICAL', 'OPTIONS', 'FLOW', 'REGIME', 'RISK');

-- CreateEnum
CREATE TYPE "DQStatus" AS ENUM ('PASSED', 'FAILED');

-- CreateEnum
CREATE TYPE "SizingMethod" AS ENUM ('FIXED_FRACTIONAL', 'KELLY', 'ATR', 'VOLATILITY_TARGET');

-- CreateEnum
CREATE TYPE "RiskMode" AS ENUM ('NORMAL', 'ELEVATED', 'RISK_OFF', 'FROZEN');

-- CreateEnum
CREATE TYPE "RiskEventType" AS ENUM ('VOLATILITY_SHOCK', 'LIQUIDITY_COLLAPSE', 'FUNDING_EXTREME', 'IV_SPIKE', 'IV_CRUSH_RISK', 'GAMMA_EXPOSURE', 'ABNORMAL_PCR', 'FLASH_CRASH', 'EXCHANGE_FAILURE', 'STABLECOIN_DEPEG', 'REGULATORY_SHOCK', 'CORRELATION_SPIKE', 'DRAWDOWN_LIMIT', 'DATA_OUTAGE');

-- CreateEnum
CREATE TYPE "RiskSeverity" AS ENUM ('INFO', 'WARNING', 'CRITICAL', 'EMERGENCY');

-- CreateEnum
CREATE TYPE "StrategyStatus" AS ENUM ('DRAFT', 'BACKTESTING', 'BACKTEST_APPROVED', 'PENDING_DEPLOY_APPROVAL', 'ACTIVE', 'PAUSED', 'DEGRADED', 'RETIRED');

-- CreateEnum
CREATE TYPE "ApprovalKind" AS ENUM ('BACKTEST_APPROVAL', 'DEPLOY_APPROVAL', 'PARAMETER_CHANGE', 'RISK_ADJUSTMENT', 'RISK_MODE_DEESCALATION', 'AI_RECOMMENDATION', 'ALLOCATION_PLAN');

-- CreateEnum
CREATE TYPE "ApprovalStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'WITHDRAWN');

-- CreateEnum
CREATE TYPE "BacktestStatus" AS ENUM ('QUEUED', 'RUNNING', 'COMPLETED', 'FAILED');

-- CreateEnum
CREATE TYPE "AllocationPlanStatus" AS ENUM ('PROPOSED', 'APPROVED', 'SUPERSEDED');

-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('ADMIN', 'ANALYST', 'VIEWER');

-- CreateTable
CREATE TABLE "MarketCandle" (
    "exchange" "Exchange" NOT NULL,
    "symbol" TEXT NOT NULL,
    "assetType" "AssetType" NOT NULL,
    "timeframe" "Timeframe" NOT NULL,
    "ts" TIMESTAMP(3) NOT NULL,
    "open" DECIMAL(20,8) NOT NULL,
    "high" DECIMAL(20,8) NOT NULL,
    "low" DECIMAL(20,8) NOT NULL,
    "close" DECIMAL(20,8) NOT NULL,
    "volume" DECIMAL(28,8) NOT NULL,
    "trades" INTEGER,

    CONSTRAINT "MarketCandle_pkey" PRIMARY KEY ("exchange","symbol","timeframe","ts")
);

-- CreateTable
CREATE TABLE "FundingRate" (
    "exchange" "Exchange" NOT NULL,
    "symbol" TEXT NOT NULL,
    "ts" TIMESTAMP(3) NOT NULL,
    "rate" DECIMAL(12,10) NOT NULL,
    "nextTs" TIMESTAMP(3),

    CONSTRAINT "FundingRate_pkey" PRIMARY KEY ("exchange","symbol","ts")
);

-- CreateTable
CREATE TABLE "OpenInterestSnapshot" (
    "exchange" "Exchange" NOT NULL,
    "symbol" TEXT NOT NULL,
    "ts" TIMESTAMP(3) NOT NULL,
    "openInterest" DECIMAL(28,8) NOT NULL,
    "openInterestValue" DECIMAL(28,2) NOT NULL,
    "oiDelta" DECIMAL(28,8),
    "oiDeltaPct" DECIMAL(12,6),

    CONSTRAINT "OpenInterestSnapshot_pkey" PRIMARY KEY ("exchange","symbol","ts")
);

-- CreateTable
CREATE TABLE "LongShortRatio" (
    "exchange" "Exchange" NOT NULL,
    "symbol" TEXT NOT NULL,
    "scope" "LsRatioScope" NOT NULL,
    "ts" TIMESTAMP(3) NOT NULL,
    "ratio" DECIMAL(12,6) NOT NULL,
    "longPct" DECIMAL(8,6),
    "shortPct" DECIMAL(8,6),

    CONSTRAINT "LongShortRatio_pkey" PRIMARY KEY ("exchange","symbol","scope","ts")
);

-- CreateTable
CREATE TABLE "OptionsChainSnapshot" (
    "exchange" "Exchange" NOT NULL,
    "underlying" TEXT NOT NULL,
    "ts" TIMESTAMP(3) NOT NULL,
    "spot" DECIMAL(20,8) NOT NULL,
    "ivAtm30d" DECIMAL(10,6),
    "skew25d" DECIMAL(10,6),
    "putCallRatio" DECIMAL(10,4),
    "totalGammaExposure" DECIMAL(28,2),
    "termStructure" JSONB,
    "contractCount" INTEGER,

    CONSTRAINT "OptionsChainSnapshot_pkey" PRIMARY KEY ("exchange","underlying","ts")
);

-- CreateTable
CREATE TABLE "OptionContractSnapshot" (
    "exchange" "Exchange" NOT NULL,
    "underlying" TEXT NOT NULL,
    "ts" TIMESTAMP(3) NOT NULL,
    "expiry" TIMESTAMP(3) NOT NULL,
    "strike" DECIMAL(20,8) NOT NULL,
    "optionType" "OptionType" NOT NULL,
    "iv" DECIMAL(10,6),
    "delta" DECIMAL(10,6),
    "gamma" DECIMAL(16,10),
    "theta" DECIMAL(16,6),
    "vega" DECIMAL(16,6),
    "openInterest" DECIMAL(28,8),
    "volume" DECIMAL(28,8),
    "bid" DECIMAL(20,8),
    "ask" DECIMAL(20,8),
    "markPrice" DECIMAL(20,8),

    CONSTRAINT "OptionContractSnapshot_pkey" PRIMARY KEY ("exchange","underlying","ts","expiry","strike","optionType")
);

-- CreateTable
CREATE TABLE "LiquiditySnapshot" (
    "exchange" "Exchange" NOT NULL,
    "symbol" TEXT NOT NULL,
    "ts" TIMESTAMP(3) NOT NULL,
    "bidDepthUsd" DECIMAL(28,2) NOT NULL,
    "askDepthUsd" DECIMAL(28,2) NOT NULL,
    "spreadBps" DECIMAL(10,4) NOT NULL,

    CONSTRAINT "LiquiditySnapshot_pkey" PRIMARY KEY ("exchange","symbol","ts")
);

-- CreateTable
CREATE TABLE "DataQualityReport" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "exchange" "Exchange" NOT NULL,
    "symbol" TEXT NOT NULL,
    "timeframe" "Timeframe",
    "windowStart" TIMESTAMP(3) NOT NULL,
    "windowEnd" TIMESTAMP(3) NOT NULL,
    "score" INTEGER NOT NULL,
    "status" "DQStatus" NOT NULL,
    "checks" JSONB NOT NULL,
    "datasetHash" TEXT NOT NULL,

    CONSTRAINT "DataQualityReport_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FeatureSetDefinition" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "domain" "FeatureDomain" NOT NULL,
    "spec" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT NOT NULL,

    CONSTRAINT "FeatureSetDefinition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FeatureSnapshot" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "exchange" "Exchange" NOT NULL,
    "symbol" TEXT NOT NULL,
    "timeframe" "Timeframe" NOT NULL,
    "ts" TIMESTAMP(3) NOT NULL,
    "features" JSONB NOT NULL,
    "featureHash" TEXT NOT NULL,
    "featureSetId" TEXT NOT NULL,
    "dqReportId" TEXT NOT NULL,

    CONSTRAINT "FeatureSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RegimeSnapshot" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "symbol" TEXT NOT NULL,
    "timeframe" "Timeframe" NOT NULL,
    "ts" TIMESTAMP(3) NOT NULL,
    "regime" "MarketRegime" NOT NULL,
    "probabilities" JSONB NOT NULL,
    "evidence" JSONB NOT NULL,
    "featureSnapshotId" TEXT NOT NULL,

    CONSTRAINT "RegimeSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RegimeTransitionMatrix" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "symbol" TEXT NOT NULL,
    "timeframe" "Timeframe" NOT NULL,
    "windowStart" TIMESTAMP(3) NOT NULL,
    "windowEnd" TIMESTAMP(3) NOT NULL,
    "method" TEXT NOT NULL,
    "regimes" JSONB NOT NULL,
    "matrix" JSONB NOT NULL,
    "sampleCounts" JSONB NOT NULL,

    CONSTRAINT "RegimeTransitionMatrix_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Signal" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "exchange" "Exchange" NOT NULL,
    "symbol" TEXT NOT NULL,
    "assetType" "AssetType" NOT NULL,
    "timeframe" "Timeframe" NOT NULL,
    "state" "SignalState" NOT NULL,
    "status" "SignalStatus" NOT NULL DEFAULT 'ACTIVE',
    "confidence" DECIMAL(5,4) NOT NULL,
    "riskScore" INTEGER NOT NULL,
    "volatilityScore" INTEGER NOT NULL,
    "liquidityScore" INTEGER NOT NULL,
    "marketRegime" "MarketRegime" NOT NULL,
    "expectedRr" DECIMAL(8,3) NOT NULL,
    "entry" DECIMAL(20,8) NOT NULL,
    "stopLoss" DECIMAL(20,8) NOT NULL,
    "takeProfit" DECIMAL(20,8) NOT NULL,
    "invalidationPoint" DECIMAL(20,8) NOT NULL,
    "reasoning" TEXT NOT NULL,
    "failureConditions" JSONB NOT NULL,
    "datasetHash" TEXT NOT NULL,
    "featureHash" TEXT NOT NULL,
    "featureSnapshotId" TEXT NOT NULL,
    "strategyVersionId" TEXT NOT NULL,
    "dqReportId" TEXT NOT NULL,
    "capacityRank" INTEGER,
    "capacityAssessmentId" TEXT,

    CONSTRAINT "Signal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SignalGateResult" (
    "id" TEXT NOT NULL,
    "signalId" TEXT NOT NULL,
    "gate" "GateType" NOT NULL,
    "passed" BOOLEAN NOT NULL,
    "detail" JSONB NOT NULL,

    CONSTRAINT "SignalGateResult_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SignalOutcome" (
    "id" TEXT NOT NULL,
    "signalId" TEXT NOT NULL,
    "resolvedAt" TIMESTAMP(3) NOT NULL,
    "resolution" "SignalStatus" NOT NULL,
    "realizedRr" DECIMAL(8,3),
    "maxFavorable" DECIMAL(8,4),
    "maxAdverse" DECIMAL(8,4),

    CONSTRAINT "SignalOutcome_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PromptTemplate" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "agent" "AgentType" NOT NULL,
    "template" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PromptTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AIAnalysis" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "agent" "AgentType" NOT NULL,
    "signalId" TEXT,
    "symbol" TEXT NOT NULL,
    "layers" JSONB NOT NULL,
    "thesis" TEXT NOT NULL,
    "whyMayFail" TEXT NOT NULL,
    "risks" JSONB NOT NULL,
    "invalidationConditions" JSONB NOT NULL,
    "confidenceAdjustment" DECIMAL(5,4) NOT NULL DEFAULT 0,
    "flaggedForReview" BOOLEAN NOT NULL DEFAULT false,
    "modelId" TEXT NOT NULL,
    "modelVersion" TEXT NOT NULL,
    "promptTemplateId" TEXT NOT NULL,
    "promptVersion" INTEGER NOT NULL,
    "temperature" DECIMAL(4,3) NOT NULL,
    "seed" INTEGER,
    "datasetHash" TEXT NOT NULL,
    "featureHash" TEXT NOT NULL,
    "inputHash" TEXT NOT NULL,

    CONSTRAINT "AIAnalysis_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Backtest" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" "BacktestStatus" NOT NULL DEFAULT 'QUEUED',
    "engine" TEXT NOT NULL,
    "strategyVersionId" TEXT NOT NULL,
    "config" JSONB NOT NULL,
    "datasetHash" TEXT,
    "cagr" DECIMAL(10,4),
    "sharpe" DECIMAL(10,4),
    "sortino" DECIMAL(10,4),
    "profitFactor" DECIMAL(10,4),
    "maxDrawdown" DECIMAL(10,4),
    "winRate" DECIMAL(6,4),
    "recoveryFactor" DECIMAL(10,4),
    "trades" INTEGER,
    "equityCurve" JSONB,
    "error" TEXT,

    CONSTRAINT "Backtest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WalkForwardRun" (
    "id" TEXT NOT NULL,
    "backtestId" TEXT NOT NULL,
    "config" JSONB NOT NULL,
    "windows" JSONB NOT NULL,
    "oosMetrics" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WalkForwardRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MonteCarloRun" (
    "id" TEXT NOT NULL,
    "backtestId" TEXT NOT NULL,
    "iterations" INTEGER NOT NULL,
    "method" TEXT NOT NULL,
    "ddDistribution" JSONB NOT NULL,
    "ruinProbability" DECIMAL(8,6) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MonteCarloRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StressTestRun" (
    "id" TEXT NOT NULL,
    "backtestId" TEXT NOT NULL,
    "scenario" TEXT NOT NULL,
    "config" JSONB NOT NULL,
    "results" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StressTestRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CalibrationReport" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "strategyVersionId" TEXT NOT NULL,
    "windowStart" TIMESTAMP(3) NOT NULL,
    "windowEnd" TIMESTAMP(3) NOT NULL,
    "expected" JSONB NOT NULL,
    "actual" JSONB NOT NULL,
    "deviations" JSONB NOT NULL,
    "breached" BOOLEAN NOT NULL,
    "proposal" JSONB,
    "approvalRequestId" TEXT,

    CONSTRAINT "CalibrationReport_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PositionSizingCalc" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "signalId" TEXT,
    "method" "SizingMethod" NOT NULL,
    "inputs" JSONB NOT NULL,
    "positionSize" DECIMAL(28,8) NOT NULL,
    "maxExposure" DECIMAL(28,2) NOT NULL,
    "portfolioRiskPct" DECIMAL(8,4) NOT NULL,
    "approved" BOOLEAN NOT NULL,
    "limitChecks" JSONB NOT NULL,

    CONSTRAINT "PositionSizingCalc_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RiskLimit" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" DECIMAL(10,4) NOT NULL,
    "unit" TEXT NOT NULL,
    "updatedBy" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RiskLimit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DetectorConfig" (
    "id" TEXT NOT NULL,
    "detector" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "params" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DetectorConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RiskEvent" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "type" "RiskEventType" NOT NULL,
    "severity" "RiskSeverity" NOT NULL,
    "detector" TEXT NOT NULL,
    "symbol" TEXT,
    "payload" JSONB NOT NULL,
    "actionsTaken" JSONB NOT NULL,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "RiskEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SystemRiskState" (
    "id" TEXT NOT NULL,
    "ts" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "mode" "RiskMode" NOT NULL,
    "reason" TEXT NOT NULL,
    "triggeredBy" TEXT NOT NULL,
    "approvalRequestId" TEXT,

    CONSTRAINT "SystemRiskState_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CorrelationMatrixSnapshot" (
    "id" TEXT NOT NULL,
    "ts" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "windowDays" INTEGER NOT NULL,
    "method" TEXT NOT NULL,
    "regime" "MarketRegime",
    "assets" JSONB NOT NULL,
    "matrix" JSONB NOT NULL,

    CONSTRAINT "CorrelationMatrixSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RiskBudget" (
    "id" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "budgetPct" DECIMAL(8,4) NOT NULL,
    "usedPct" DECIMAL(8,4) NOT NULL DEFAULT 0,
    "updatedBy" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RiskBudget_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AllocationPlan" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "portfolioId" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "allocations" JSONB NOT NULL,
    "constraints" JSONB NOT NULL,
    "correlationMatrixId" TEXT NOT NULL,
    "status" "AllocationPlanStatus" NOT NULL DEFAULT 'PROPOSED',
    "approvalRequestId" TEXT,

    CONSTRAINT "AllocationPlan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CapacityAssessment" (
    "id" TEXT NOT NULL,
    "ts" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "portfolioId" TEXT NOT NULL,
    "portfolioCapacity" JSONB NOT NULL,
    "marginCapacity" JSONB NOT NULL,
    "riskCapacity" JSONB NOT NULL,
    "prioritization" JSONB NOT NULL,

    CONSTRAINT "CapacityAssessment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Portfolio" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "baseCurrency" TEXT NOT NULL DEFAULT 'USDT',
    "initialValue" DECIMAL(28,2) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Portfolio_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PortfolioSnapshot" (
    "id" TEXT NOT NULL,
    "portfolioId" TEXT NOT NULL,
    "ts" TIMESTAMP(3) NOT NULL,
    "equity" DECIMAL(28,2) NOT NULL,
    "exposure" DECIMAL(28,2) NOT NULL,
    "drawdown" DECIMAL(8,4) NOT NULL,
    "positions" JSONB NOT NULL,

    CONSTRAINT "PortfolioSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HypotheticalTrade" (
    "id" TEXT NOT NULL,
    "portfolioId" TEXT NOT NULL,
    "signalId" TEXT,
    "symbol" TEXT NOT NULL,
    "side" TEXT NOT NULL,
    "entryTs" TIMESTAMP(3) NOT NULL,
    "entryPrice" DECIMAL(20,8) NOT NULL,
    "exitTs" TIMESTAMP(3),
    "exitPrice" DECIMAL(20,8),
    "size" DECIMAL(28,8) NOT NULL,
    "pnl" DECIMAL(28,2),
    "fees" DECIMAL(28,2),
    "rMultiple" DECIMAL(8,3),

    CONSTRAINT "HypotheticalTrade_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Strategy" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT NOT NULL,

    CONSTRAINT "Strategy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StrategyVersion" (
    "id" TEXT NOT NULL,
    "strategyId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "status" "StrategyStatus" NOT NULL DEFAULT 'DRAFT',
    "description" TEXT NOT NULL,
    "hypothesis" TEXT NOT NULL,
    "entryLogic" TEXT NOT NULL,
    "exitLogic" TEXT NOT NULL,
    "riskRules" TEXT NOT NULL,
    "failureConditions" TEXT NOT NULL,
    "parameters" JSONB NOT NULL,
    "validRegimes" JSONB NOT NULL,
    "volatilityBounds" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT NOT NULL,

    CONSTRAINT "StrategyVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApprovalRequest" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "kind" "ApprovalKind" NOT NULL,
    "status" "ApprovalStatus" NOT NULL DEFAULT 'PENDING',
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "rationale" TEXT NOT NULL,
    "requestedBy" TEXT NOT NULL,
    "reviewedBy" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "reviewNote" TEXT,

    CONSTRAINT "ApprovalRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "ts" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actor" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "before" JSONB,
    "after" JSONB,
    "reason" TEXT,
    "requestId" TEXT,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "role" "UserRole" NOT NULL DEFAULT 'ANALYST',
    "passwordHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Alert" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "severity" "RiskSeverity" NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "readAt" TIMESTAMP(3),

    CONSTRAINT "Alert_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JobRun" (
    "id" TEXT NOT NULL,
    "job" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),
    "status" TEXT NOT NULL,
    "detail" JSONB,

    CONSTRAINT "JobRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MarketCandle_symbol_timeframe_ts_idx" ON "MarketCandle"("symbol", "timeframe", "ts" DESC);

-- CreateIndex
CREATE INDEX "LongShortRatio_symbol_scope_ts_idx" ON "LongShortRatio"("symbol", "scope", "ts" DESC);

-- CreateIndex
CREATE INDEX "OptionContractSnapshot_underlying_expiry_ts_idx" ON "OptionContractSnapshot"("underlying", "expiry", "ts" DESC);

-- CreateIndex
CREATE INDEX "DataQualityReport_exchange_symbol_timeframe_createdAt_idx" ON "DataQualityReport"("exchange", "symbol", "timeframe", "createdAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "FeatureSetDefinition_name_version_key" ON "FeatureSetDefinition"("name", "version");

-- CreateIndex
CREATE INDEX "FeatureSnapshot_symbol_timeframe_ts_idx" ON "FeatureSnapshot"("symbol", "timeframe", "ts" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "FeatureSnapshot_exchange_symbol_timeframe_ts_featureSetId_key" ON "FeatureSnapshot"("exchange", "symbol", "timeframe", "ts", "featureSetId");

-- CreateIndex
CREATE INDEX "RegimeSnapshot_symbol_timeframe_ts_idx" ON "RegimeSnapshot"("symbol", "timeframe", "ts" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "RegimeSnapshot_symbol_timeframe_ts_key" ON "RegimeSnapshot"("symbol", "timeframe", "ts");

-- CreateIndex
CREATE INDEX "RegimeTransitionMatrix_symbol_timeframe_createdAt_idx" ON "RegimeTransitionMatrix"("symbol", "timeframe", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "Signal_symbol_status_createdAt_idx" ON "Signal"("symbol", "status", "createdAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "SignalGateResult_signalId_gate_key" ON "SignalGateResult"("signalId", "gate");

-- CreateIndex
CREATE UNIQUE INDEX "SignalOutcome_signalId_key" ON "SignalOutcome"("signalId");

-- CreateIndex
CREATE UNIQUE INDEX "PromptTemplate_name_version_key" ON "PromptTemplate"("name", "version");

-- CreateIndex
CREATE INDEX "AIAnalysis_symbol_agent_createdAt_idx" ON "AIAnalysis"("symbol", "agent", "createdAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "RiskLimit_key_key" ON "RiskLimit"("key");

-- CreateIndex
CREATE UNIQUE INDEX "DetectorConfig_detector_key" ON "DetectorConfig"("detector");

-- CreateIndex
CREATE INDEX "RiskEvent_type_createdAt_idx" ON "RiskEvent"("type", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "CorrelationMatrixSnapshot_ts_idx" ON "CorrelationMatrixSnapshot"("ts" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "RiskBudget_scope_key" ON "RiskBudget"("scope");

-- CreateIndex
CREATE INDEX "CapacityAssessment_portfolioId_ts_idx" ON "CapacityAssessment"("portfolioId", "ts" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "PortfolioSnapshot_portfolioId_ts_key" ON "PortfolioSnapshot"("portfolioId", "ts");

-- CreateIndex
CREATE UNIQUE INDEX "Strategy_name_key" ON "Strategy"("name");

-- CreateIndex
CREATE UNIQUE INDEX "StrategyVersion_strategyId_version_key" ON "StrategyVersion"("strategyId", "version");

-- CreateIndex
CREATE INDEX "AuditLog_entityType_entityId_ts_idx" ON "AuditLog"("entityType", "entityId", "ts" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "JobRun_job_startedAt_idx" ON "JobRun"("job", "startedAt" DESC);

-- AddForeignKey
ALTER TABLE "FeatureSnapshot" ADD CONSTRAINT "FeatureSnapshot_featureSetId_fkey" FOREIGN KEY ("featureSetId") REFERENCES "FeatureSetDefinition"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FeatureSnapshot" ADD CONSTRAINT "FeatureSnapshot_dqReportId_fkey" FOREIGN KEY ("dqReportId") REFERENCES "DataQualityReport"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RegimeSnapshot" ADD CONSTRAINT "RegimeSnapshot_featureSnapshotId_fkey" FOREIGN KEY ("featureSnapshotId") REFERENCES "FeatureSnapshot"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Signal" ADD CONSTRAINT "Signal_featureSnapshotId_fkey" FOREIGN KEY ("featureSnapshotId") REFERENCES "FeatureSnapshot"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Signal" ADD CONSTRAINT "Signal_strategyVersionId_fkey" FOREIGN KEY ("strategyVersionId") REFERENCES "StrategyVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Signal" ADD CONSTRAINT "Signal_dqReportId_fkey" FOREIGN KEY ("dqReportId") REFERENCES "DataQualityReport"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Signal" ADD CONSTRAINT "Signal_capacityAssessmentId_fkey" FOREIGN KEY ("capacityAssessmentId") REFERENCES "CapacityAssessment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SignalGateResult" ADD CONSTRAINT "SignalGateResult_signalId_fkey" FOREIGN KEY ("signalId") REFERENCES "Signal"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SignalOutcome" ADD CONSTRAINT "SignalOutcome_signalId_fkey" FOREIGN KEY ("signalId") REFERENCES "Signal"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AIAnalysis" ADD CONSTRAINT "AIAnalysis_signalId_fkey" FOREIGN KEY ("signalId") REFERENCES "Signal"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AIAnalysis" ADD CONSTRAINT "AIAnalysis_promptTemplateId_fkey" FOREIGN KEY ("promptTemplateId") REFERENCES "PromptTemplate"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Backtest" ADD CONSTRAINT "Backtest_strategyVersionId_fkey" FOREIGN KEY ("strategyVersionId") REFERENCES "StrategyVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WalkForwardRun" ADD CONSTRAINT "WalkForwardRun_backtestId_fkey" FOREIGN KEY ("backtestId") REFERENCES "Backtest"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MonteCarloRun" ADD CONSTRAINT "MonteCarloRun_backtestId_fkey" FOREIGN KEY ("backtestId") REFERENCES "Backtest"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StressTestRun" ADD CONSTRAINT "StressTestRun_backtestId_fkey" FOREIGN KEY ("backtestId") REFERENCES "Backtest"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CalibrationReport" ADD CONSTRAINT "CalibrationReport_strategyVersionId_fkey" FOREIGN KEY ("strategyVersionId") REFERENCES "StrategyVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PositionSizingCalc" ADD CONSTRAINT "PositionSizingCalc_signalId_fkey" FOREIGN KEY ("signalId") REFERENCES "Signal"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AllocationPlan" ADD CONSTRAINT "AllocationPlan_portfolioId_fkey" FOREIGN KEY ("portfolioId") REFERENCES "Portfolio"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AllocationPlan" ADD CONSTRAINT "AllocationPlan_correlationMatrixId_fkey" FOREIGN KEY ("correlationMatrixId") REFERENCES "CorrelationMatrixSnapshot"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CapacityAssessment" ADD CONSTRAINT "CapacityAssessment_portfolioId_fkey" FOREIGN KEY ("portfolioId") REFERENCES "Portfolio"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PortfolioSnapshot" ADD CONSTRAINT "PortfolioSnapshot_portfolioId_fkey" FOREIGN KEY ("portfolioId") REFERENCES "Portfolio"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HypotheticalTrade" ADD CONSTRAINT "HypotheticalTrade_portfolioId_fkey" FOREIGN KEY ("portfolioId") REFERENCES "Portfolio"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StrategyVersion" ADD CONSTRAINT "StrategyVersion_strategyId_fkey" FOREIGN KEY ("strategyId") REFERENCES "Strategy"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
