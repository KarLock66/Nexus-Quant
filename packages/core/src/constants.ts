/**
 * Hard platform invariants. These are floors/ceilings, not tunables:
 * operational thresholds (detector params, risk limits) live as data in
 * the DetectorConfig / RiskLimit tables, but the values below are part of
 * the platform's risk contract and may only change via an approved ADR.
 */

/** No signal may be generated from data scoring below this (M5). */
export const MIN_DATA_QUALITY_SCORE = 90;

/** Minimum expected risk:reward for any signal (M1 gate). */
export const MIN_RISK_REWARD = 2.0;

/** Risk modes in which signal publication is allowed (M1 RISK_MODE gate). */
export const SIGNAL_PERMITTED_RISK_MODES = ["NORMAL", "ELEVATED"] as const;

/** AI analyses may only lower confidence — never raise it (M2). */
export const MAX_AI_CONFIDENCE_ADJUSTMENT = 0;

/** Signal TTL per timeframe, in bars. */
export const SIGNAL_TTL_BARS = 3;
