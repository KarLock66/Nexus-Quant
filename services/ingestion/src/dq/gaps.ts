/**
 * Candle gap detection on the exact timeframe grid.
 *
 * Convention: bars are expected at every grid-aligned open time in [from, to).
 * Grid alignment is absolute (epoch-ms % timeframe-ms === 0), matching how
 * venues publish bar open times. Off-grid input timestamps never satisfy an
 * expected slot (they are flagged separately by timestamp_monotonic).
 *
 * Gap ranges are half-open: `from` = open time of the first missing bar,
 * `to` = open time of the first present (or out-of-window) bar after the run,
 * i.e. `to` - `from` = missingBars * timeframeMs.
 */

import type { Timeframe } from "@nexus/core";

export const TIMEFRAME_MS: Record<Timeframe, number> = {
  M1: 60_000,
  M5: 300_000,
  M15: 900_000,
  H1: 3_600_000,
  H4: 14_400_000,
  D1: 86_400_000,
};

export interface CandleGap {
  from: Date;
  to: Date;
  missingBars: number;
}

export function detectCandleGaps(
  timestamps: Date[],
  timeframe: Timeframe,
  from: Date,
  to: Date,
): CandleGap[] {
  const gridMs = TIMEFRAME_MS[timeframe];
  const firstAligned = Math.ceil(from.getTime() / gridMs) * gridMs;
  const endMs = to.getTime();

  if (firstAligned >= endMs) return [];

  const present = new Set<number>();
  for (const ts of timestamps) {
    const ms = ts.getTime();
    if (ms % gridMs === 0 && ms >= firstAligned && ms < endMs) {
      present.add(ms);
    }
  }

  const gaps: CandleGap[] = [];
  let runStart: number | null = null;
  let runBars = 0;

  for (let ms = firstAligned; ms < endMs; ms += gridMs) {
    if (present.has(ms)) {
      if (runStart !== null) {
        gaps.push({
          from: new Date(runStart),
          to: new Date(runStart + runBars * gridMs),
          missingBars: runBars,
        });
        runStart = null;
        runBars = 0;
      }
    } else {
      if (runStart === null) runStart = ms;
      runBars += 1;
    }
  }
  if (runStart !== null) {
    gaps.push({
      from: new Date(runStart),
      to: new Date(runStart + runBars * gridMs),
      missingBars: runBars,
    });
  }

  return gaps;
}
