"use client";

import { usePolledResource, type PollState } from "./use-polled-resource";
import type { ConsensusView, DecisionsView, RankingView } from "./trading-decision-types";

/**
 * Typed client service layer for the Phase 10A-1 Trading Decision Center. Reuses the
 * shared `usePolledResource` polling primitive so each panel loads / errors / refreshes
 * independently. Brisk cadence — a live decision console must never show stale cards.
 */

export const DECISION_ENDPOINTS = {
  decisions: "/api/v1/signals/decisions",
  ranking: "/api/v1/signals/ranking",
  consensus: "/api/v1/signals/consensus",
} as const;

/** Auto-refresh cadence (ms). Decisions/ranking are brisk; consensus a touch slower. */
const FAST = 4_000;
const SLOW = 8_000;

export type { PollState };

export const useDecisions = () =>
  usePolledResource<DecisionsView>(DECISION_ENDPOINTS.decisions, "signals/decisions", FAST);

export const useRanking = () =>
  usePolledResource<RankingView>(DECISION_ENDPOINTS.ranking, "signals/ranking", FAST);

export const useConsensus = (symbol: string) =>
  usePolledResource<ConsensusView>(
    `${DECISION_ENDPOINTS.consensus}?symbol=${encodeURIComponent(symbol)}`,
    "signals/consensus",
    SLOW,
  );
