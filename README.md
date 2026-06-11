# Project Nexus Quant

**AI-Powered Quant Research, Signal Intelligence & Risk Governance Platform**

Nexus Quant is an explainable, deterministic, risk-first quantitative intelligence
platform for Bitcoin and Ethereum markets (spot, perpetual futures, options) across
Binance, Deribit, and Bybit.

This is **not** a trading bot. The platform analyzes markets, generates gated signals,
evaluates risk, tests strategies, and monitors performance. A human is always the
final decision maker.

## Core Philosophy (priority order)

1. Capital Preservation
2. Risk Management
3. Data Integrity
4. Strategy Robustness
5. Explainability
6. Consistency
7. Profitability

Higher priorities are never sacrificed for lower ones.

## Status

**Architecture approved (with modifications) — Phase 0 scaffolding in progress.**
Approved modifications incorporated: Feature Store (FS), Market Regime Engine (M8,
7-state taxonomy), multi-agent AI architecture (Research/Risk/Options/Governance),
Portfolio Construction Engine (M9), Strategy Capacity Planner (M10), full model
version tracking on AI analyses, and platform-wide reproducibility metadata
(datasetHash, featureHash, strategyVersion, promptVersion, modelVersion).

## Architecture Package

| Document | Contents |
| --- | --- |
| [docs/architecture/00-overview.md](docs/architecture/00-overview.md) | System overview, engine specs, service topology, key decisions |
| [docs/architecture/01-folder-structure.md](docs/architecture/01-folder-structure.md) | Monorepo layout |
| [docs/architecture/02-database-schema.md](docs/architecture/02-database-schema.md) | PostgreSQL schema + full Prisma model draft |
| [docs/architecture/03-api-design.md](docs/architecture/03-api-design.md) | REST/SSE API design, internal quant-service API, contracts |
| [docs/architecture/04-system-diagrams.md](docs/architecture/04-system-diagrams.md) | Context, container, data-flow, sequence & state diagrams |
| [docs/architecture/05-roadmap.md](docs/architecture/05-roadmap.md) | Phased implementation roadmap with acceptance criteria |
