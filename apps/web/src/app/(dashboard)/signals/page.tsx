import { ModulePage } from "@/components/module-page";

export const metadata = { title: "Signal Center" };

export default function SignalsPage() {
  return (
    <ModulePage
      title="Signal Center"
      module="M1"
      phase="Phase 3"
      description="Every signal that passed — or failed — the six-gate chain. No signal exists without a data-quality report ≥ 90, RR ≥ 2, approved sizing, validated regime, a passing volatility filter, and a permissive risk mode."
      widgets={[
        { title: "Signal Feed", detail: "Realtime SSE stream of published and rejected signals with full gate results." },
        { title: "Signal Detail", detail: "Entry, stop, target, invalidation point, reasoning, failure conditions, lineage quintuple." },
        { title: "Gate Audit", detail: "Per-gate measured value vs. threshold for any signal, including rejections." },
        { title: "Outcome Tracking", detail: "TARGET_HIT / STOPPED / INVALIDATED / EXPIRED resolution feeding calibration." },
        { title: "Capacity Ranking", detail: "Prioritization scores and CAPACITY_DEFERRED signals with binding constraints." },
        { title: "Manual Trigger", detail: "Run the pipeline on demand — subject to every gate; no bypass exists." },
      ]}
    />
  );
}
