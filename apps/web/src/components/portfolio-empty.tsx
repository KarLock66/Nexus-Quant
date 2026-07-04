/**
 * Phase 10C-2B-1 — Portfolio Terminal empty state. Pure, props-only. Shown when the engine
 * served a valid portfolio that contains no candidate positions (the demo seed-42 reality:
 * every signal FLAT). Honest copy — never implies activity that isn't there.
 */

export function PortfolioEmpty({ reason }: { reason?: string | null }) {
  return (
    <div className="glass p-6 text-sm text-slate-400">
      <p className="mb-1 text-slate-200">No portfolio positions yet.</p>
      <p>
        The portfolio is derived from admitted{" "}
        <span className="font-mono text-slate-300">EngineSignal</span> decisions. With no directional
        candidates the book is flat — capital, exposure and risk are all zero by construction, not
        hidden. Start the worker (and ingestion for live prices) to populate the terminal.
      </p>
      {reason && <p className="mt-2 font-mono text-[11px] text-slate-600">{reason}</p>}
    </div>
  );
}
