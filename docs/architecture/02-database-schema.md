# Nexus Quant — Database Schema & Prisma Models

> Status: DRAFT — pending human approval.
> PostgreSQL 16 + TimescaleDB. Prisma is the ORM for all domain tables. Market-data
> hypertables (candles, funding, OI) are created via Prisma models + a raw-SQL
> migration step that converts them to hypertables (`create_hypertable`) — Prisma
> reads/writes them normally.

## 1. Schema Map

```
Market Data        : MarketCandle, FundingRate, OpenInterestSnapshot,
                     OptionsChainSnapshot, LiquiditySnapshot
Data Quality (M5)  : DataQualityReport
Feature Store (FS) : FeatureSetDefinition, FeatureSnapshot
Regime (M8)        : RegimeSnapshot
Signals (M1)       : Signal, SignalGateResult, SignalOutcome
AI Agents (M2)     : AIAnalysis, PromptTemplate
Backtesting (M3)   : Backtest, WalkForwardRun, MonteCarloRun, StressTestRun,
                     CalibrationReport
Sizing & Risk (M4) : PositionSizingCalc, RiskLimit, RiskEvent, SystemRiskState,
                     DetectorConfig
Portfolio Cx (M9)  : CorrelationMatrixSnapshot, RiskBudget, AllocationPlan
Capacity (M10)     : CapacityAssessment
Portfolio (M6)     : Portfolio, PortfolioSnapshot, HypotheticalTrade
Governance (M7)    : Strategy, StrategyVersion, ApprovalRequest, AuditLog
Platform           : User, Alert, JobRun
```

All prices/amounts are `Decimal`; all timestamps `timestamptz`; all IDs `cuid`.
Composite uniques guarantee idempotent ingestion (re-ingesting a candle upserts).

## 2. Prisma Schema (full draft)

```prisma
// packages/db/prisma/schema.prisma

generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

// ───────────────────────── Enums ─────────────────────────

enum Exchange  { BINANCE DERIBIT BYBIT }
enum AssetType { SPOT PERP OPTION }
enum Timeframe { M1 M5 M15 H1 H4 D1 }

enum SignalState     { STRONG_BUY BUY NEUTRAL SELL STRONG_SELL }
enum SignalStatus    { ACTIVE TARGET_HIT STOPPED INVALIDATED EXPIRED REQUIRES_MANUAL_REVIEW CAPACITY_DEFERRED }
enum MarketRegime    { TRENDING_BULL TRENDING_BEAR RANGE_BOUND HIGH_VOL LOW_VOL PANIC EUPHORIA }
enum GateType        { DATA_QUALITY RISK_REWARD POSITION_SIZE MARKET_REGIME VOLATILITY_FILTER RISK_MODE }
enum AgentType       { RESEARCH RISK OPTIONS GOVERNANCE }

enum DQStatus        { PASSED FAILED }
enum SizingMethod    { FIXED_FRACTIONAL KELLY ATR VOLATILITY_TARGET }

enum RiskMode        { NORMAL ELEVATED RISK_OFF FROZEN }
enum RiskEventType   { VOLATILITY_SHOCK LIQUIDITY_COLLAPSE FUNDING_EXTREME IV_SPIKE IV_CRUSH_RISK
                       GAMMA_EXPOSURE ABNORMAL_PCR FLASH_CRASH EXCHANGE_FAILURE STABLECOIN_DEPEG
                       REGULATORY_SHOCK CORRELATION_SPIKE DRAWDOWN_LIMIT DATA_OUTAGE }
enum RiskSeverity    { INFO WARNING CRITICAL EMERGENCY }

enum StrategyStatus  { DRAFT BACKTESTING BACKTEST_APPROVED PENDING_DEPLOY_APPROVAL
                       ACTIVE PAUSED DEGRADED RETIRED }
enum ApprovalKind    { BACKTEST_APPROVAL DEPLOY_APPROVAL PARAMETER_CHANGE RISK_ADJUSTMENT
                       RISK_MODE_DEESCALATION AI_RECOMMENDATION }
enum ApprovalStatus  { PENDING APPROVED REJECTED WITHDRAWN }

enum BacktestStatus  { QUEUED RUNNING COMPLETED FAILED }
enum UserRole        { ADMIN ANALYST VIEWER }

// ─────────────────────── Market Data ───────────────────────

model MarketCandle {            // TimescaleDB hypertable on ts
  id        String    @id @default(cuid())
  exchange  Exchange
  symbol    String                    // canonical: BTC-USDT, ETH-PERP…
  assetType AssetType
  timeframe Timeframe
  ts        DateTime
  open      Decimal   @db.Decimal(20, 8)
  high      Decimal   @db.Decimal(20, 8)
  low       Decimal   @db.Decimal(20, 8)
  close     Decimal   @db.Decimal(20, 8)
  volume    Decimal   @db.Decimal(28, 8)
  trades    Int?

  @@unique([exchange, symbol, timeframe, ts])
  @@index([symbol, timeframe, ts(sort: Desc)])
}

model FundingRate {
  id        String   @id @default(cuid())
  exchange  Exchange
  symbol    String
  ts        DateTime
  rate      Decimal  @db.Decimal(12, 10)
  nextTs    DateTime?

  @@unique([exchange, symbol, ts])
}

model OpenInterestSnapshot {
  id        String   @id @default(cuid())
  exchange  Exchange
  symbol    String
  ts        DateTime
  openInterest      Decimal @db.Decimal(28, 8)
  openInterestValue Decimal @db.Decimal(28, 2)   // USD notional

  @@unique([exchange, symbol, ts])
}

model OptionsChainSnapshot {   // Deribit-centric; one row per snapshot per underlying
  id          String   @id @default(cuid())
  exchange    Exchange
  underlying  String                 // BTC | ETH
  ts          DateTime
  spot        Decimal  @db.Decimal(20, 8)
  ivAtm30d    Decimal? @db.Decimal(10, 6)
  skew25d     Decimal? @db.Decimal(10, 6)     // 25Δ RR
  putCallRatio Decimal? @db.Decimal(10, 4)
  totalGammaExposure Decimal? @db.Decimal(28, 2)
  termStructure Json?                // [{expiry, atmIv}]
  chain        Json?                 // compressed strike-level detail

  @@unique([exchange, underlying, ts])
}

model LiquiditySnapshot {       // depth/spread for liquidity scoring
  id        String   @id @default(cuid())
  exchange  Exchange
  symbol    String
  ts        DateTime
  bidDepthUsd  Decimal @db.Decimal(28, 2)     // within ±0.5%
  askDepthUsd  Decimal @db.Decimal(28, 2)
  spreadBps    Decimal @db.Decimal(10, 4)

  @@unique([exchange, symbol, ts])
}

// ─────────────────── M5: Data Quality ───────────────────

model DataQualityReport {
  id        String   @id @default(cuid())
  createdAt DateTime @default(now())
  exchange  Exchange
  symbol    String
  timeframe Timeframe?
  windowStart DateTime
  windowEnd   DateTime
  score     Int                      // 0–100
  status    DQStatus                 // PASSED iff score >= 90
  checks    Json                     // [{check, passed, deduction, detail}]
  datasetHash String                 // sha256 of inputs → lineage/reproducibility

  signals   Signal[]
  featureSnapshots FeatureSnapshot[]

  @@index([exchange, symbol, timeframe, createdAt(sort: Desc)])
}

// ─────────────────── FS: Feature Store ───────────────────

model FeatureSetDefinition {
  id        String   @id @default(cuid())
  name      String                   // e.g. core-technical
  version   Int
  spec      Json                     // declarative: indicators, params, windows
  createdAt DateTime @default(now())
  createdBy String
  snapshots FeatureSnapshot[]

  @@unique([name, version])
}

model FeatureSnapshot {
  id          String   @id @default(cuid())
  createdAt   DateTime @default(now())
  exchange    Exchange
  symbol      String
  timeframe   Timeframe
  ts          DateTime                // bar close the features describe (point-in-time)
  features    Json                    // {name: value} canonical-ordered
  featureHash String                  // sha256 of canonicalized vector
  featureSetId String
  featureSet   FeatureSetDefinition @relation(fields: [featureSetId], references: [id])
  dqReportId  String                  // mandatory: features only from DQ>=90 data
  dqReport    DataQualityReport @relation(fields: [dqReportId], references: [id])

  regimeSnapshots RegimeSnapshot[]
  signals         Signal[]

  @@unique([exchange, symbol, timeframe, ts, featureSetId])
  @@index([symbol, timeframe, ts(sort: Desc)])
}

// ─────────────────── M8: Market Regime Engine ───────────────────

model RegimeSnapshot {
  id          String   @id @default(cuid())
  createdAt   DateTime @default(now())
  symbol      String
  timeframe   Timeframe
  ts          DateTime
  regime      MarketRegime
  probabilities Json                  // {TRENDING_BULL: 0.62, …} sums to 1
  evidence    Json                    // feature contributions / rule firings
  featureSnapshotId String
  featureSnapshot   FeatureSnapshot @relation(fields: [featureSnapshotId], references: [id])

  @@unique([symbol, timeframe, ts])
  @@index([symbol, timeframe, ts(sort: Desc)])
}

// ─────────────────── M1: Signals ───────────────────

model Signal {
  id          String       @id @default(cuid())
  createdAt   DateTime     @default(now())
  expiresAt   DateTime
  exchange    Exchange
  symbol      String
  assetType   AssetType
  timeframe   Timeframe

  state            SignalState
  status           SignalStatus  @default(ACTIVE)
  confidence       Decimal       @db.Decimal(5, 4)   // 0–1
  riskScore        Int                                // 0–100
  volatilityScore  Int
  liquidityScore   Int
  marketRegime     MarketRegime
  expectedRr       Decimal       @db.Decimal(8, 3)
  entry            Decimal       @db.Decimal(20, 8)
  stopLoss         Decimal       @db.Decimal(20, 8)
  takeProfit       Decimal       @db.Decimal(20, 8)
  invalidationPoint Decimal      @db.Decimal(20, 8)
  reasoning        String                             // human-readable WHY
  failureConditions Json                              // string[]

  // reproducibility quintuple (lineage)
  datasetHash       String
  featureHash       String
  featureSnapshotId String
  featureSnapshot   FeatureSnapshot @relation(fields: [featureSnapshotId], references: [id])
  strategyVersionId String
  strategyVersion   StrategyVersion @relation(fields: [strategyVersionId], references: [id])
  dqReportId        String
  dqReport          DataQualityReport @relation(fields: [dqReportId], references: [id])
  capacityRank      Int?                               // M10 prioritization rank when contended
  capacityAssessmentId String?

  gateResults  SignalGateResult[]
  outcome      SignalOutcome?
  aiAnalyses   AIAnalysis[]
  sizingCalcs  PositionSizingCalc[]

  @@index([symbol, status, createdAt(sort: Desc)])
}

model SignalGateResult {
  id        String   @id @default(cuid())
  signalId  String
  signal    Signal   @relation(fields: [signalId], references: [id], onDelete: Cascade)
  gate      GateType
  passed    Boolean
  detail    Json                     // inputs, threshold, measured value

  @@unique([signalId, gate])
}

model SignalOutcome {                // realized result → feeds M3 calibration
  id          String   @id @default(cuid())
  signalId    String   @unique
  signal      Signal   @relation(fields: [signalId], references: [id])
  resolvedAt  DateTime
  resolution  SignalStatus           // TARGET_HIT | STOPPED | INVALIDATED | EXPIRED
  realizedRr  Decimal? @db.Decimal(8, 3)
  maxFavorable Decimal? @db.Decimal(8, 4)  // MFE %
  maxAdverse   Decimal? @db.Decimal(8, 4)  // MAE %
}

// ─────────────────── M2: AI Research ───────────────────

model PromptTemplate {
  id        String   @id @default(cuid())
  name      String
  version   Int
  template  String
  createdAt DateTime @default(now())
  analyses  AIAnalysis[]

  @@unique([name, version])
}

model AIAnalysis {
  id          String   @id @default(cuid())
  createdAt   DateTime @default(now())
  agent       AgentType              // RESEARCH | RISK | OPTIONS | GOVERNANCE
  signalId    String?
  signal      Signal?  @relation(fields: [signalId], references: [id])
  symbol      String
  layers      Json                   // {technical, derivatives, sentiment, macro}
  thesis      String
  whyMayFail  String
  risks       Json                   // string[]
  invalidationConditions Json        // string[]
  confidenceAdjustment Decimal @db.Decimal(5, 4) @default(0) // <= 0 only (advisory)
  flaggedForReview Boolean @default(false)

  // reproducibility metadata (full set, denormalized for direct audit)
  modelId       String               // e.g. claude-fable-5
  modelVersion  String               // exact dated model snapshot
  promptTemplateId String
  promptTemplate   PromptTemplate @relation(fields: [promptTemplateId], references: [id])
  promptVersion Int                  // denormalized from template
  temperature   Decimal @db.Decimal(4, 3)
  seed          Int?                 // sampling seed when supported
  datasetHash   String
  featureHash   String
  inputHash     String               // hash of the fully-rendered prompt input

  @@index([symbol, agent, createdAt(sort: Desc)])
}

// ─────────────────── M3: Backtesting & Calibration ───────────────────

model Backtest {
  id          String   @id @default(cuid())
  createdAt   DateTime @default(now())
  status      BacktestStatus @default(QUEUED)
  engine      String                 // vectorbt | backtrader
  strategyVersionId String
  strategyVersion   StrategyVersion @relation(fields: [strategyVersionId], references: [id])
  config      Json                   // window, fees, slippage model, data scope
  datasetHash String?
  // metrics (null until COMPLETED)
  cagr           Decimal? @db.Decimal(10, 4)
  sharpe         Decimal? @db.Decimal(10, 4)
  sortino        Decimal? @db.Decimal(10, 4)
  profitFactor   Decimal? @db.Decimal(10, 4)
  maxDrawdown    Decimal? @db.Decimal(10, 4)
  winRate        Decimal? @db.Decimal(6, 4)
  recoveryFactor Decimal? @db.Decimal(10, 4)
  trades         Int?
  equityCurve    Json?               // downsampled [{ts, equity}]
  error          String?

  walkForwardRuns WalkForwardRun[]
  monteCarloRuns  MonteCarloRun[]
  stressTestRuns  StressTestRun[]
}

model WalkForwardRun {
  id         String   @id @default(cuid())
  backtestId String
  backtest   Backtest @relation(fields: [backtestId], references: [id])
  config     Json                    // window sizes, step
  windows    Json                    // per-window IS/OOS metrics
  oosMetrics Json                    // aggregate out-of-sample metrics
  createdAt  DateTime @default(now())
}

model MonteCarloRun {
  id         String   @id @default(cuid())
  backtestId String
  backtest   Backtest @relation(fields: [backtestId], references: [id])
  iterations Int
  method     String                  // trade_resample | block_bootstrap
  ddDistribution Json                // percentiles of max drawdown
  ruinProbability Decimal @db.Decimal(8, 6)
  createdAt  DateTime @default(now())
}

model StressTestRun {
  id         String   @id @default(cuid())
  backtestId String
  backtest   Backtest @relation(fields: [backtestId], references: [id])
  scenario   String                  // MAR_2020 | FTX_2022 | SYNTHETIC_GAP_10 …
  config     Json
  results    Json                    // pnl, dd, breached limits
  createdAt  DateTime @default(now())
}

model CalibrationReport {
  id          String   @id @default(cuid())
  createdAt   DateTime @default(now())
  strategyVersionId String
  strategyVersion   StrategyVersion @relation(fields: [strategyVersionId], references: [id])
  windowStart DateTime
  windowEnd   DateTime
  expected    Json                   // backtest-derived metric expectations
  actual      Json                   // realized from SignalOutcome
  deviations  Json                   // per-metric z-scores / breaches
  breached    Boolean
  proposal    Json?                  // {kind, changes, rationale} → ApprovalRequest
  approvalRequestId String?
}

// ─────────────────── M4: Sizing & Risk ───────────────────

model PositionSizingCalc {
  id          String   @id @default(cuid())
  createdAt   DateTime @default(now())
  signalId    String?
  signal      Signal?  @relation(fields: [signalId], references: [id])
  method      SizingMethod
  inputs      Json                   // portfolioValue, riskPerTrade, stopDistance, vol
  positionSize     Decimal @db.Decimal(28, 8)
  maxExposure      Decimal @db.Decimal(28, 2)
  portfolioRiskPct Decimal @db.Decimal(8, 4)
  approved    Boolean                // false if any limit would be breached
  limitChecks Json                   // per-limit evaluation
}

model RiskLimit {
  id        String   @id @default(cuid())
  key       String   @unique         // DAILY_DD | WEEKLY_DD | MONTHLY_DD |
                                     // MAX_PORTFOLIO_EXPOSURE | MAX_CORR_EXPOSURE | MAX_RISK_PER_TRADE
  value     Decimal  @db.Decimal(10, 4)
  unit      String                   // pct | usd
  updatedBy String
  updatedAt DateTime @updatedAt
}

model DetectorConfig {
  id        String  @id @default(cuid())
  detector  String  @unique          // BTC_VOL_SHOCK | ETH_OPTIONS_RISK | BLACK_SWAN …
  enabled   Boolean @default(true)
  params    Json                     // thresholds
  updatedAt DateTime @updatedAt
}

model RiskEvent {
  id        String       @id @default(cuid())
  createdAt DateTime     @default(now())
  type      RiskEventType
  severity  RiskSeverity
  detector  String
  symbol    String?
  payload   Json                     // measured values vs thresholds
  actionsTaken Json                  // [SIZING_SCALED, ENTRIES_PAUSED, …]
  resolvedAt DateTime?

  @@index([type, createdAt(sort: Desc)])
}

model SystemRiskState {              // append-only mode history; latest row = current
  id        String   @id @default(cuid())
  ts        DateTime @default(now())
  mode      RiskMode
  reason    String
  triggeredBy String                 // detector name or user id
  approvalRequestId String?          // required for de-escalation from RISK_OFF/FROZEN
}

// ─────────────────── M9: Portfolio Construction ───────────────────

model CorrelationMatrixSnapshot {
  id        String   @id @default(cuid())
  ts        DateTime @default(now())
  windowDays Int                     // e.g. 30 / 90
  method    String                   // pearson | spearman | regime_conditional
  regime    MarketRegime?            // set when regime-conditional
  assets    Json                     // ordered asset list
  matrix    Json                     // row-major correlation values

  @@index([ts(sort: Desc)])
}

model RiskBudget {
  id        String   @id @default(cuid())
  scope     String                   // STRATEGY:<id> | ASSET:BTC | REGIME:HIGH_VOL …
  budgetPct Decimal  @db.Decimal(8, 4)   // share of total portfolio risk
  usedPct   Decimal  @db.Decimal(8, 4) @default(0)
  updatedBy String
  updatedAt DateTime @updatedAt

  @@unique([scope])
}

model AllocationPlan {
  id          String   @id @default(cuid())
  createdAt   DateTime @default(now())
  portfolioId String
  method      String                  // erc | risk_parity | manual
  allocations Json                    // [{asset/strategy, targetPct, riskContribution}]
  constraints Json                    // concentration caps applied
  correlationMatrixId String
  status      String  @default("PROPOSED")  // PROPOSED | APPROVED | SUPERSEDED
  approvalRequestId String?
}

// ─────────────────── M10: Strategy Capacity Planner ───────────────────

model CapacityAssessment {
  id        String   @id @default(cuid())
  ts        DateTime @default(now())
  portfolioId String
  portfolioCapacity Json             // {limitUsd, usedUsd, freeUsd, bindingCap}
  marginCapacity    Json             // {initialMarginUsd, usedUsd, freeUsd, maxLeverage}
  riskCapacity      Json             // {dailyDdRemaining, weeklyDdRemaining, monthlyDdRemaining, budgetsRemaining}
  prioritization    Json             // ranked signals: [{signalId, score, components, admitted, bindingConstraint}]

  @@index([portfolioId, ts(sort: Desc)])
}

// ─────────────────── M6: Portfolio ───────────────────

model Portfolio {                    // paper/analytical portfolio
  id        String   @id @default(cuid())
  name      String
  baseCurrency String @default("USDT")
  initialValue Decimal @db.Decimal(28, 2)
  createdAt DateTime @default(now())
  snapshots PortfolioSnapshot[]
  trades    HypotheticalTrade[]
}

model PortfolioSnapshot {
  id          String   @id @default(cuid())
  portfolioId String
  portfolio   Portfolio @relation(fields: [portfolioId], references: [id])
  ts          DateTime
  equity      Decimal  @db.Decimal(28, 2)
  exposure    Decimal  @db.Decimal(28, 2)
  drawdown    Decimal  @db.Decimal(8, 4)
  positions   Json

  @@unique([portfolioId, ts])
}

model HypotheticalTrade {            // signal-following simulation, never live
  id          String   @id @default(cuid())
  portfolioId String
  portfolio   Portfolio @relation(fields: [portfolioId], references: [id])
  signalId    String?
  symbol      String
  side        String                 // LONG | SHORT
  entryTs     DateTime
  entryPrice  Decimal  @db.Decimal(20, 8)
  exitTs      DateTime?
  exitPrice   Decimal? @db.Decimal(20, 8)
  size        Decimal  @db.Decimal(28, 8)
  pnl         Decimal? @db.Decimal(28, 2)
  fees        Decimal? @db.Decimal(28, 2)
  rMultiple   Decimal? @db.Decimal(8, 3)
}

// ─────────────────── M7: Governance ───────────────────

model Strategy {
  id        String   @id @default(cuid())
  name      String   @unique
  createdAt DateTime @default(now())
  createdBy String
  versions  StrategyVersion[]
}

model StrategyVersion {
  id          String   @id @default(cuid())
  strategyId  String
  strategy    Strategy @relation(fields: [strategyId], references: [id])
  version     Int
  status      StrategyStatus @default(DRAFT)
  // mandatory governance fields (non-nullable by design)
  description String
  hypothesis  String
  entryLogic  String
  exitLogic   String
  riskRules   String
  failureConditions String
  parameters  Json                   // typed param set
  validRegimes Json                  // MarketRegime[] this strategy may trade
  volatilityBounds Json              // {min, max} realized-vol bounds
  createdAt   DateTime @default(now())
  createdBy   String

  signals     Signal[]
  backtests   Backtest[]
  calibrationReports CalibrationReport[]

  @@unique([strategyId, version])
}

model ApprovalRequest {
  id          String   @id @default(cuid())
  createdAt   DateTime @default(now())
  kind        ApprovalKind
  status      ApprovalStatus @default(PENDING)
  entityType  String                 // StrategyVersion | RiskLimit | SystemRiskState…
  entityId    String
  payload     Json                   // proposed change (diff)
  rationale   String                 // mandatory WHY
  requestedBy String                 // user id or "system:calibration"
  reviewedBy  String?
  reviewedAt  DateTime?
  reviewNote  String?
}

model AuditLog {
  id        String   @id @default(cuid())
  ts        DateTime @default(now())
  actor     String                   // user id or system component
  action    String                   // CREATE | UPDATE | APPROVE | REJECT | MODE_CHANGE…
  entityType String
  entityId  String
  before    Json?
  after     Json?
  reason    String?
  requestId String?                  // correlation id

  @@index([entityType, entityId, ts(sort: Desc)])
}

// ─────────────────── Platform ───────────────────

model User {
  id           String   @id @default(cuid())
  email        String   @unique
  name         String
  role         UserRole @default(ANALYST)
  passwordHash String
  createdAt    DateTime @default(now())
}

model Alert {
  id        String   @id @default(cuid())
  createdAt DateTime @default(now())
  severity  RiskSeverity
  title     String
  body      String
  source    String                   // detector / pipeline / system
  readAt    DateTime?
}

model JobRun {                       // observability for cron/queue jobs
  id        String   @id @default(cuid())
  job       String
  startedAt DateTime @default(now())
  endedAt   DateTime?
  status    String                   // RUNNING | OK | FAILED
  detail    Json?

  @@index([job, startedAt(sort: Desc)])
}
```

## 3. Design Notes

- **Fail-closed gates as data:** `Signal` requires non-null `dqReportId` AND
  `featureSnapshotId`; a signal row physically cannot exist without a quality report
  and a versioned feature snapshot. Gate results are stored per-gate with their
  inputs, so any published signal can be audited.
- **Reproducibility quintuple everywhere:** `datasetHash`, `featureHash`,
  `strategyVersion`, `promptVersion`, `modelVersion` (plus `temperature`/`seed` on
  AI records) are denormalized onto `Signal` and `AIAnalysis` so audits never need
  joins to establish lineage; immutable `StrategyVersion` and `FeatureSetDefinition`
  versions guarantee the referenced definitions cannot drift.
- **Feature Store is the only feature source:** signal pipeline, regime engine, AI
  agents, and backtests all read `FeatureSnapshot` rows (point-in-time correct),
  eliminating train/serve skew by construction.
- **AI is structurally advisory:** `AIAnalysis.confidenceAdjustment` is constrained
  (app-level + DB check constraint in migration) to be ≤ 0 — the AI can only lower
  confidence or flag for review, never boost or change levels.
- **Calibration loop closure:** `SignalOutcome` (realized) joins to
  `StrategyVersion → Backtest` (expected) via `CalibrationReport`; breaches create
  `ApprovalRequest`s — never direct mutations.
- **TimescaleDB:** `MarketCandle`, `FundingRate`, `OpenInterestSnapshot`,
  `LiquiditySnapshot` become hypertables in a raw SQL migration; continuous
  aggregates derive H4/D1 from H1 to avoid redundant ingestion.
- **Retention:** raw M1 candles 90 days, M5+ indefinitely; snapshots compressed by
  Timescale compression policies (migration-defined).
