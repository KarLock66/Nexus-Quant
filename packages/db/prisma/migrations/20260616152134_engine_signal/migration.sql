-- CreateEnum
CREATE TYPE "SignalDecision" AS ENUM ('LONG', 'SHORT', 'FLAT');

-- CreateTable
CREATE TABLE "EngineSignal" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "symbol" TEXT NOT NULL,
    "side" "SignalDecision" NOT NULL,
    "decision" "SignalDecision" NOT NULL,
    "confidence" DECIMAL(5,4) NOT NULL,
    "strategyVersionId" TEXT NOT NULL,
    "strategyParams" JSONB NOT NULL,
    "featureSnapshotId" TEXT NOT NULL,
    "dqReportId" TEXT NOT NULL,
    "datasetHash" TEXT NOT NULL,
    "featureHash" TEXT NOT NULL,

    CONSTRAINT "EngineSignal_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "EngineSignal_symbol_createdAt_idx" ON "EngineSignal"("symbol", "createdAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "EngineSignal_featureSnapshotId_strategyVersionId_key" ON "EngineSignal"("featureSnapshotId", "strategyVersionId");

-- AddForeignKey
ALTER TABLE "EngineSignal" ADD CONSTRAINT "EngineSignal_strategyVersionId_fkey" FOREIGN KEY ("strategyVersionId") REFERENCES "StrategyVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EngineSignal" ADD CONSTRAINT "EngineSignal_featureSnapshotId_fkey" FOREIGN KEY ("featureSnapshotId") REFERENCES "FeatureSnapshot"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EngineSignal" ADD CONSTRAINT "EngineSignal_dqReportId_fkey" FOREIGN KEY ("dqReportId") REFERENCES "DataQualityReport"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

