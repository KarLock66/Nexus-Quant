"use client";

import { usePolledResource, type PollState } from "./use-polled-resource";
import type { ReadinessView, TradePlansView } from "./trade-plan-types";

/**
 * Typed client service layer for the Phase 10C-1 Actionable Decision Engine. Reuses the
 * shared `usePolledResource` primitive so each panel loads / errors / refreshes
 * independently. Brisk cadence — a live decision terminal must never show stale verdicts.
 */

export const TRADE_PLAN_ENDPOINTS = {
  tradePlan: "/api/v1/signals/trade-plan",
  readiness: "/api/v1/signals/readiness",
} as const;

/** Auto-refresh cadence (ms) — matches the decisions feed. */
const FAST = 4_000;

export type { PollState };

export const useTradePlan = () =>
  usePolledResource<TradePlansView>(TRADE_PLAN_ENDPOINTS.tradePlan, "signals/trade-plan", FAST);

export const useReadiness = () =>
  usePolledResource<ReadinessView>(TRADE_PLAN_ENDPOINTS.readiness, "signals/readiness", FAST);
