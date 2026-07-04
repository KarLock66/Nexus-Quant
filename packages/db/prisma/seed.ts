import { randomBytes, scryptSync } from "node:crypto";
import { pathToFileURL } from "node:url";
import { PrismaClient } from "@prisma/client";

function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, 64).toString("hex");
  return `scrypt:${salt}:${hash}`;
}

/**
 * Base reference data (config / governance). Exported so `demo-seed.ts` can
 * compose it with the demo signal chain without re-implementing any of it.
 */
export async function seedBase(prisma: PrismaClient) {
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

  // ── Feature Store: one feature set per domain (FS) — v1 definitions.
  //    Domains (approved review modification): Technical, Options, Flow,
  //    Regime, Risk. Specs are declarative; computation lives in services/quant.
  const featureSets: Array<{
    name: string;
    domain: "TECHNICAL" | "OPTIONS" | "FLOW" | "REGIME" | "RISK";
    spec: object;
  }> = [
    {
      name: "core-technical",
      domain: "TECHNICAL",
      spec: {
        indicators: [
          { name: "ema", params: { periods: [20, 50, 200] } },
          { name: "rsi", params: { period: 14 } },
          { name: "atr", params: { period: 14 } },
          { name: "realized_vol", params: { windowBars: 30 } },
          { name: "volume_zscore", params: { windowBars: 100 } },
          { name: "donchian", params: { period: 20 } },
        ],
      },
    },
    {
      name: "core-options",
      domain: "OPTIONS",
      spec: {
        indicators: [
          { name: "atm_iv", params: { tenorDays: 30 } },
          { name: "iv_term_slope", params: { nearDays: 7, farDays: 90 } },
          { name: "skew_25d", params: { tenorDays: 30 } },
          { name: "pcr_oi", params: {} },
          { name: "pcr_volume", params: {} },
          { name: "total_gamma_exposure", params: {} },
        ],
        source: "OptionContractSnapshot + OptionsChainSnapshot",
      },
    },
    {
      name: "core-flow",
      domain: "FLOW",
      spec: {
        indicators: [
          { name: "funding_rate", params: {} },
          { name: "funding_zscore", params: { windowSnapshots: 90 } },
          { name: "oi", params: {} },
          { name: "oi_delta_pct", params: {} },
          { name: "ls_ratio_global", params: { scope: "GLOBAL_ACCOUNTS" } },
          { name: "ls_ratio_top", params: { scope: "TOP_TRADER_POSITIONS" } },
        ],
        source: "FundingRate + OpenInterestSnapshot + LongShortRatio",
      },
    },
    {
      name: "core-regime",
      domain: "REGIME",
      spec: {
        indicators: [
          { name: "trend_strength", params: { fast: 20, slow: 200 } },
          { name: "momentum_roc", params: { period: 20 } },
          { name: "realized_vol_percentile", params: { windowBars: 365 } },
          { name: "drawdown_velocity", params: { windowBars: 30 } },
          { name: "range_compression", params: { period: 20 } },
        ],
        consumer: "M8 regime classifier (Phase 3)",
      },
    },
    {
      name: "core-risk",
      domain: "RISK",
      spec: {
        indicators: [
          { name: "realized_vol", params: { windowBars: 30 } },
          { name: "atr_pct", params: { period: 14 } },
          { name: "max_drawdown", params: { windowBars: 30 } },
          { name: "spread_bps", params: {} },
          { name: "depth_usd", params: { bandPct: 0.5 } },
        ],
        consumer: "M4 sizing inputs + liquidity scoring",
      },
    },
  ];
  for (const fs of featureSets) {
    await prisma.featureSetDefinition.upsert({
      where: { name_version: { name: fs.name, version: 1 } },
      update: {},
      create: {
        name: fs.name,
        version: 1,
        domain: fs.domain,
        createdBy: "system:seed",
        spec: {
          ...fs.spec,
          canonicalOrder: "alphabetical",
          hash: "sha256",
        },
      },
    });
  }

  // ── M2 agent prompt templates v1 — each agent has a distinct objective.
  //    Consumed in Phase 5; versioned as data from day one so AIAnalysis rows
  //    can always reference an immutable prompt version.
  const promptTemplates: Array<{
    name: string;
    agent: "RESEARCH" | "RISK" | "OPTIONS" | "GOVERNANCE";
    template: string;
  }> = [
    {
      name: "research-agent",
      agent: "RESEARCH",
      template: [
        "OBJECTIVE: Produce an evidence-grounded market thesis for {{symbol}}.",
        "You receive ONLY validated Feature Store snapshots (technical, flow,",
        "regime domains) and persisted domain records — never raw data.",
        "Explain: why a signal may exist, why it may fail, and the exact",
        "invalidation conditions. You are advisory: you may lower confidence",
        "or flag for review; you can never raise confidence or alter levels.",
        "Output must validate against the ResearchAnalysis JSON schema.",
      ].join("\n"),
    },
    {
      name: "risk-agent",
      agent: "RISK",
      template: [
        "OBJECTIVE: Adversarially cross-examine the candidate signal for {{symbol}}.",
        "Cross-check against: active RiskEvents, current MarketRegime, RiskLimit",
        "utilization, correlation concentration, and recent calibration deviations.",
        "Enumerate every risk you find with severity. Recommend a confidence",
        "reduction (<= 0) and set the manual-review flag when risks are material.",
        "You exist to find reasons NOT to act. Output must validate against the",
        "RiskAnalysis JSON schema.",
      ].join("\n"),
    },
    {
      name: "options-agent",
      agent: "OPTIONS",
      template: [
        "OBJECTIVE: Analyze the derivatives layer for {{underlying}}.",
        "You receive options-domain Feature Store snapshots: IV surface stats,",
        "25d skew, term structure, put/call ratios, gamma exposure, funding and",
        "OI flow. Identify: options-structure risks, IV-crush setups around",
        "events, dealer-gamma effects, and hedging context for the candidate",
        "signal. Warn explicitly when implied vol contradicts the directional",
        "thesis. Output must validate against the OptionsAnalysis JSON schema.",
      ].join("\n"),
    },
    {
      name: "governance-agent",
      agent: "GOVERNANCE",
      template: [
        "OBJECTIVE: Detect strategy drift and propose governed remediations.",
        "You receive calibration reports (expected vs realized), signal outcome",
        "distributions, and audit anomalies. When deviation is material, draft a",
        "parameter-review or strategy-review PROPOSAL with rationale, routed to",
        "the M7 approval queue. You can never change parameters directly —",
        "humans approve. Output must validate against the GovernanceProposal",
        "JSON schema.",
      ].join("\n"),
    },
  ];
  for (const pt of promptTemplates) {
    await prisma.promptTemplate.upsert({
      where: { name_version: { name: pt.name, version: 1 } },
      update: {},
      create: {
        name: pt.name,
        version: 1,
        agent: pt.agent,
        template: pt.template,
      },
    });
  }

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

  console.log(
    "Seed complete: admin user, risk limits, detectors, 5 domain feature sets, 4 agent prompts, risk mode NORMAL.",
  );
}

async function main() {
  const prisma = new PrismaClient();
  try {
    await seedBase(prisma);
  } catch (e) {
    console.error(e);
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

// Only auto-run when executed directly (`tsx prisma/seed.ts`), never on import.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
