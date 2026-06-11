import { ModulePage } from "@/components/module-page";

export const metadata = { title: "Research Lab" };

export default function ResearchPage() {
  return (
    <ModulePage
      title="Research Lab"
      module="M2 · M8"
      phase="Phase 5"
      description="Multi-agent AI analysis — Research, Risk, Options, and Governance agents consume validated feature snapshots and explain why a thesis exists, why it may fail, and what invalidates it. Advisory only: agents can lower confidence, never raise it."
      widgets={[
        { title: "Research Agent", detail: "Technical, sentiment, and macro thesis with explicit failure conditions." },
        { title: "Risk Agent", detail: "Cross-checks candidates against limits, regime, and correlation; flags conflicts." },
        { title: "Options Agent", detail: "IV surface, skew, put/call ratio, gamma exposure — ETH options risk context." },
        { title: "Governance Agent", detail: "Calibration drift and audit anomalies routed into the approval queue." },
        { title: "Regime Monitor", detail: "7-state market regime with probabilities and evidence (M8)." },
        { title: "Reproducibility", detail: "Every analysis records modelVersion, promptVersion, temperature, seed, and hashes." },
      ]}
    />
  );
}
