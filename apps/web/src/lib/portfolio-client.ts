"use client";

import { usePolledResource, type PollState } from "./use-polled-resource";
import type {
  PortfolioExposureView,
  PortfolioHealthView,
  PortfolioSummaryView,
} from "./portfolio-types";

/**
 * Typed client service layer for the Phase 10C-2A Portfolio Intelligence Engine. Reuses the
 * shared `usePolledResource` primitive so each panel loads / errors / refreshes independently.
 * Brisk cadence — a live portfolio view must never show stale exposure / risk.
 */

export const PORTFOLIO_ENDPOINTS = {
  summary: "/api/v1/portfolio/summary",
  exposure: "/api/v1/portfolio/exposure",
  health: "/api/v1/portfolio/health",
} as const;

/** Auto-refresh cadence (ms) — matches the decisions / trade-plan feeds. */
const FAST = 4_000;

export type { PollState };

export const usePortfolioSummary = () =>
  usePolledResource<PortfolioSummaryView>(PORTFOLIO_ENDPOINTS.summary, "portfolio/summary", FAST);

export const usePortfolioExposure = () =>
  usePolledResource<PortfolioExposureView>(PORTFOLIO_ENDPOINTS.exposure, "portfolio/exposure", FAST);

export const usePortfolioHealth = () =>
  usePolledResource<PortfolioHealthView>(PORTFOLIO_ENDPOINTS.health, "portfolio/health", FAST);
