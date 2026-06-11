# Nexus Quant — System Diagrams

> Status: DRAFT — pending human approval. Diagrams in Mermaid.

## 1. System Context

```mermaid
flowchart LR
    subgraph External
        BIN[Binance]
        DER[Deribit]
        BYB[Bybit]
        NEWS[News / Sentiment Feeds]
        MACRO[Macro Data]
        CLAUDE[Claude API]
    end

    ANALYST((Human Analyst\nfinal decision maker))

    subgraph NQ[Nexus Quant Platform]
        ING[Ingestion Service]
        DQ[Data Quality Gateway M5]
        QUANT[Quant Service Python]
        WORK[Workers: Signals M1 / AI M2 / Calibration M3 / Defense]
        WEB[Next.js Web + BFF API M6 M7]
        PG[(PostgreSQL + Timescale)]
        RD[(Redis: queues + pub/sub)]
    end

    BIN & DER & BYB --> ING --> DQ --> PG
    NEWS & MACRO --> ING
    WORK <--> QUANT
    WORK <--> RD
    WORK --> PG
    WORK <--> CLAUDE
    WEB <--> PG
    RD --> WEB
    WEB <--> ANALYST
```

## 2. Signal Generation Pipeline (M1) — data flow

```mermaid
flowchart TD
    A[Scheduled trigger / manual request] --> B{DQ Gate\nscore >= 90?}
    B -- no --> R1[Reject: DATA_QUALITY\n+ diagnostic report]
    B -- yes --> C[Feature Store FS:\ncompute + persist versioned\nFeatureSnapshot + featureHash]
    C --> D[Regime Engine M8:\nclassify 7-state regime\npersist RegimeSnapshot]
    D --> E[Evaluate strategy logic\nStrategyVersion params]
    E -- no setup --> R2[No candidate - log only]
    E -- candidate --> F{Gate chain - packages/core/gates}
    F --> G1{RR >= 2?}
    G1 -- no --> RJ[signal.rejected + failed gates persisted]
    G1 -- yes --> G2{Position size approved?\nM4 RiskLimits + M9 budgets,\nconcentration + M10 capacity}
    G2 -- no --> RJ
    G2 -- yes --> G3{Regime permitted\nfor strategy?}
    G3 -- no --> RJ
    G3 -- yes --> G4{Volatility filter\nno active vol shock?}
    G4 -- no --> RJ
    G4 -- yes --> G5{Risk mode\nNORMAL / ELEVATED?}
    G5 -- no --> RJ
    G5 -- yes --> H[Persist Signal + gate results\n+ reproducibility quintuple]
    H --> I[AI Agents M2:\nResearch / Risk / Options\nadvisory only - can lower confidence]
    I --> J[signal.published -> SSE -> UI]
    J --> K[Track outcome: TP / SL / invalidation / expiry]
    K --> L[SignalOutcome -> Calibration M3]
```

## 3. Signal Generation — sequence

```mermaid
sequenceDiagram
    participant S as Scheduler (BullMQ)
    participant W as Signal Worker
    participant P as Quant Svc (Python)
    participant G as Gate Layer (core/gates)
    participant DB as Postgres
    participant AI as AI Orchestrator (Claude)
    participant UI as Web (SSE)

    S->>W: run(symbol, timeframe, strategyVersion)
    W->>DB: latest DataQualityReport(scope)
    alt score < 90
        W->>DB: persist rejection (DATA_QUALITY)
        W-->>UI: signal.rejected
    else score >= 90
        W->>P: /features/compute (FeatureSet vN)
        P->>DB: persist FeatureSnapshot + featureHash
        P-->>W: snapshot ref
        W->>P: /regime/classify (snapshot)
        P->>DB: persist RegimeSnapshot (7-state)
        P-->>W: regime + probabilities
        W->>W: evaluate strategy logic -> candidate?
        W->>P: /sizing/calculate + /capacity/assess
        P-->>W: size numbers + capacity ranking
        W->>G: run gate chain (RR, size+limits+budgets+capacity, regime, vol, mode)
        alt any gate fails
            W->>DB: persist candidate + failed GateResults
            W-->>UI: signal.rejected
        else all pass
            W->>DB: persist Signal + GateResults + lineage quintuple (ACTIVE)
            W->>AI: Research/Risk/Options agents (FeatureSnapshot inputs only)
            AI-->>W: theses / risks / invalidation (advisory)
            W->>DB: persist AIAnalysis (agent, modelVersion, promptVersion, temperature, seed; conf adj <= 0)
            W-->>UI: signal.published
        end
    end
```

## 4. Strategy Lifecycle (M7) — state machine

```mermaid
stateDiagram-v2
    [*] --> DRAFT
    DRAFT --> BACKTESTING : submit for backtest
    BACKTESTING --> DRAFT : failed / rework
    BACKTESTING --> BACKTEST_APPROVED : human backtest approval
    BACKTEST_APPROVED --> PENDING_DEPLOY_APPROVAL : request deploy
    PENDING_DEPLOY_APPROVAL --> ACTIVE : human deploy approval
    PENDING_DEPLOY_APPROVAL --> DRAFT : rejected
    ACTIVE --> PAUSED : manual pause
    PAUSED --> ACTIVE : manual resume
    ACTIVE --> DEGRADED : calibration breach
    DEGRADED --> ACTIVE : re-approval after review
    DEGRADED --> RETIRED : retire
    ACTIVE --> RETIRED : retire
    PAUSED --> RETIRED : retire
```

Every transition: mandatory `reason`, `AuditLog` row; approvals require
requester ≠ reviewer.

## 5. System Risk Mode — state machine

```mermaid
stateDiagram-v2
    [*] --> NORMAL
    NORMAL --> ELEVATED : detector WARNING (vol shock, funding extreme)
    ELEVATED --> NORMAL : conditions clear (auto, dwell time)
    ELEVATED --> RISK_OFF : detector CRITICAL (flash crash, depeg, corr spike)
    NORMAL --> RISK_OFF : detector CRITICAL
    RISK_OFF --> FROZEN : detector EMERGENCY (exchange failure, data outage)
    RISK_OFF --> ELEVATED : HUMAN APPROVAL required
    FROZEN --> RISK_OFF : HUMAN APPROVAL required

    note right of RISK_OFF
        RISK_OFF and FROZEN block ALL
        signal publication (RISK_MODE gate).
        Escalation automatic, fail-closed.
        De-escalation human-approved only.
    end note
```

## 6. Calibration Loop (M3)

```mermaid
flowchart LR
    BT[Backtest metrics\nexpected distribution] --> CMP{Deviation\n> threshold?}
    OUT[SignalOutcomes\nrealized performance] --> CMP
    CMP -- no --> OK[CalibrationReport: healthy]
    CMP -- yes --> PR[Proposal: parameter review /\nstrategy review / risk adjustment]
    PR --> AQ[ApprovalRequest PENDING]
    AQ -- human approves --> NV[New StrategyVersion\nback through lifecycle]
    AQ -- human rejects --> LOG[Audit trail only]
    CMP -- severe --> DEG[StrategyVersion -> DEGRADED\n+ alert]
```

## 7. Data Quality Gateway (M5) — two stages

```mermaid
flowchart TD
    RAW[Exchange payloads] --> SA[Stage A - structural, TS ingestion]
    SA --> C1[schema conformance]
    SA --> C2[missing values]
    SA --> C3[duplicates]
    SA --> C4[timestamp integrity]
    SA --> C5[symbol consistency]
    SA --> C6[outage / heartbeat gaps]
    C1 & C2 & C3 & C4 & C5 & C6 --> PERSIST[(Persist normalized data)]
    PERSIST --> SB[Stage B - statistical, Python]
    SB --> C7[MAD outliers + cross-exchange price check]
    SB --> C8[distribution drift]
    SB --> C9[volume anomalies]
    C7 & C8 & C9 --> SCORE[Score 0-100\nweighted deductions]
    SCORE --> REP[(DataQualityReport)]
    REP -->|score < 90| BLOCK[Block all signal generation\n+ diagnostic report + alert]
    REP -->|score >= 90| ALLOW[Feature Store may compute snapshots\npipelines consume snapshots only]
```

## 8. AI Agent Architecture (M2)

```mermaid
flowchart TD
    FS[(Feature Store\nsnapshots)] --> ORCH[Agent Orchestrator\nservices/workers]
    DOM[(Domain records:\nsignals, risk events,\ncalibration, audit)] --> ORCH

    ORCH --> RA[Research Agent\ntechnical + sentiment + macro]
    ORCH --> RK[Risk Agent\nlimits, regime, correlation cross-check]
    ORCH --> OA[Options Agent\nIV surface, skew, PCR, gamma]
    ORCH --> GA[Governance Agent\ncalibration drift, audit anomalies]

    RA & RK & OA --> VAL{Schema validation\n+ advisory constraints\nconf adj <= 0}
    GA --> AQ[ApprovalRequest queue M7]
    VAL -- invalid --> RETRY[Reject + retry\nnever persisted raw]
    VAL -- valid --> DB[(AIAnalysis\nagent, modelVersion, promptVersion,\ntemperature, seed, featureHash, datasetHash)]
    RA -. disagreement with .-> RK
    RK -- conflict --> MR[Signal -> REQUIRES_MANUAL_REVIEW]
```

## 9. Capacity Planning & Signal Prioritization (M10)

```mermaid
flowchart LR
    SIGS[Valid candidate signals] --> RANK[Deterministic priority score\nRR x confidence x regime fit\n/ marginal correlation cost]
    CAPP[(Portfolio capacity)] --> ALLOC
    CAPM[(Margin capacity)] --> ALLOC
    CAPR[(Risk capacity\nDD budgets + M9 risk budgets)] --> ALLOC
    RANK --> ALLOC{Greedy allocation\nunder constraints}
    ALLOC -- admitted --> PUB[Signal ACTIVE\ncapacityRank recorded]
    ALLOC -- capacity exhausted --> DEF[Signal CAPACITY_DEFERRED\nbinding constraint recorded]
    ALLOC --> ASSESS[(CapacityAssessment\nfull ranking persisted)]
```
