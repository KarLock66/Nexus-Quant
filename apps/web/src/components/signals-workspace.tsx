"use client";

import { useState } from "react";
import { DecisionTerminal } from "./decision-terminal";
import { TradingTerminal } from "./trading-terminal";
import { SignalFeed } from "./signal-feed";

/**
 * Trading Terminal workspace — owns the single symbol focus shared by the
 * decision terminal and the signal-analysis terminal, so clicking a symbol
 * (or an opportunity-board row) focuses BOTH panels consistently instead of
 * each section keeping its own divergent selection.
 */
export function SignalsWorkspace() {
  const [selected, setSelected] = useState<string | null>(null);

  return (
    <>
      <section className="space-y-3">
        <div className="space-y-1">
          <div className="flex items-center gap-3">
            <h2 className="text-sm font-semibold text-slate-100">Actionable decision</h2>
            <span className="rounded-full border border-(--color-line) px-2.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-slate-500">
              Phase 10C-1
            </span>
          </div>
          <p className="max-w-3xl text-xs leading-relaxed text-slate-500">
            Five decision panels over the selected signal — the action verdict (should/can I trade ·
            why), a pre-trade execution checklist, the concrete risk figures, what would invalidate the
            trade, and a deterministic 0–100 readiness score. Derived on-read from the{" "}
            <span className="font-mono text-slate-400">TradingDecision</span> (consumed verbatim);
            nothing is recomputed and unavailable data is shown as such — never fabricated.
          </p>
        </div>
        <DecisionTerminal selected={selected} onSelect={setSelected} />
      </section>

      <section className="space-y-3 border-t border-(--color-line) pt-6">
        <div className="space-y-1">
          <h2 className="text-sm font-semibold text-slate-100">Signal analysis</h2>
          <p className="text-xs text-slate-500">
            The five analysis panels — market overview, trade plan, AI explain, market analysis and the
            opportunity board — over each admitted decision.
          </p>
        </div>
        <TradingTerminal selected={selected} onSelect={setSelected} />
      </section>

      <section className="space-y-3 border-t border-(--color-line) pt-6">
        <div className="space-y-1">
          <h2 className="text-sm font-semibold text-slate-100">Raw EngineSignal feed</h2>
          <p className="text-xs text-slate-500">
            The verbatim deterministic signal stream (live via SSE) the decisions above are derived
            from — trend bias, post-volatility-filter decision, confidence, and lineage hashes.
          </p>
        </div>
        <SignalFeed />
      </section>
    </>
  );
}
