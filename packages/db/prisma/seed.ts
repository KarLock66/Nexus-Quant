import { randomBytes, scryptSync } from "node:crypto";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, 64).toString("hex");
  return `scrypt:${salt}:${hash}`;
}

async function main() {
  // ── Admin user (dev only — change password immediately in any shared env)
  await prisma.user.upsert({
    where: { email: "admin@nexus-quant.local" },
    update: {},
    create: {
      email: "admin@nexus-quant.local",
      name: "Admin",
      role: "ADMIN",
      passwordHash: hashPassword(process.env.SEED_ADMIN_PASSWORD ?? "nexus-dev-admin"),
    },
  });

  // ── Hard risk limits (M4) — conservative defaults, changeable only via
  //    audited PUT /api/v1/risk/limits/:key with mandatory reason.
  const limits: Array<{ key: string; value: string; unit: string }> = [
    { key: "DAILY_DD", value: "2.0", unit: "pct" },
    { key: "WEEKLY_DD", value: "5.0", unit: "pct" },
    { key: "MONTHLY_DD", value: "10.0", unit: "pct" },
    { key: "MAX_PORTFOLIO_EXPOSURE", value: "50.0", unit: "pct" },
    { key: "MAX_CORR_EXPOSURE", value: "30.0", unit: "pct" },
    { key: "MAX_RISK_PER_TRADE", value: "1.0", unit: "pct" },
  ];
  for (const limit of limits) {
    await prisma.riskLimit.upsert({
      where: { key: limit.key },
      update: {},
      create: { ...limit, updatedBy: "system:seed" },
    });
  }

  // ── Defense framework detector configs (thresholds are data, not code)
  const detectors: Array<{ detector: string; params: object }> = [
    {
      detector: "BTC_VOL_SHOCK",
      params: {
        atrExplosionMultiple: 3.0,
        atrBaselineWindowBars: 100,
        liquidityDepthDropPct: 60,
        fundingRateAbsExtreme: 0.0015,
        sizingScaleFactor: 0.5,
      },
    },
    {
      detector: "ETH_OPTIONS_RISK",
      params: {
        ivSpikePctPerDay: 25,
        ivCrushTermSlopeMin: -0.15,
        gammaExposureUsdAbsMax: 500_000_000,
        putCallRatioBands: { min: 0.4, max: 1.6 },
        confidenceCap: 0.5,
      },
    },
    {
      detector: "BLACK_SWAN",
      params: {
        flashCrashReturnPct: -10,
        flashCrashWindowMinutes: 15,
        stablecoinDepegBandPct: 1.5,
        crossExchangeDivergencePct: 3,
        correlationSpikeThreshold: 0.95,
      },
    },
  ];
  for (const d of detectors) {
    await prisma.detectorConfig.upsert({
      where: { detector: d.detector },
      update: {},
      create: { detector: d.detector, enabled: true, params: d.params },
    });
  }

  // ── Feature Store: core technical feature set v1 (FS)
  await prisma.featureSetDefinition.upsert({
    where: { name_version: { name: "core-technical", version: 1 } },
    update: {},
    create: {
      name: "core-technical",
      version: 1,
      createdBy: "system:seed",
      spec: {
        indicators: [
          { name: "ema", params: { periods: [20, 50, 200] } },
          { name: "rsi", params: { period: 14 } },
          { name: "atr", params: { period: 14 } },
          { name: "realized_vol", params: { windowBars: 30 } },
          { name: "volume_zscore", params: { windowBars: 100 } },
          { name: "donchian", params: { period: 20 } },
        ],
        canonicalOrder: "alphabetical",
        hash: "sha256",
      },
    },
  });

  // ── Initial system risk mode
  const existingMode = await prisma.systemRiskState.findFirst();
  if (!existingMode) {
    await prisma.systemRiskState.create({
      data: {
        mode: "NORMAL",
        reason: "initial seed state",
        triggeredBy: "system:seed",
      },
    });
  }

  console.log("Seed complete: admin user, risk limits, detectors, feature set v1, risk mode NORMAL.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
