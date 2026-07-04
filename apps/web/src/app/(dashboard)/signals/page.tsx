import { SignalsWorkspace } from "@/components/signals-workspace";

export const metadata = { title: "Trading Terminal" };

export default function SignalsPage() {
  return (
    <div className="space-y-6">
      <header className="space-y-1.5">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-xl font-semibold text-white">Trading Terminal</h1>
          <span className="rounded-full border border-(--color-line) bg-(--color-surface-800) px-2.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-(--color-accent-500)">
            Institutional Console
          </span>
          <span className="rounded-full border border-(--color-line) px-2.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-slate-500">
            Phase 10A-2
          </span>
        </div>
        <p className="max-w-3xl text-sm leading-relaxed text-slate-400">
          Five synchronized panels over each admitted{" "}
          <span className="font-mono text-slate-300">EngineSignal</span>: market overview, trade plan,
          AI explain, market analysis, and the opportunity board. Direction and confidence are carried
          verbatim from the deterministic signal engine; every derived value is tagged with its
          provenance (verbatim · real · derived · estimated) and unavailable data is shown as such —
          never fabricated. <span className="font-mono text-slate-400">TradingDecision</span> remains the
          single source of truth.
        </p>
      </header>

      <SignalsWorkspace />
    </div>
  );
}
