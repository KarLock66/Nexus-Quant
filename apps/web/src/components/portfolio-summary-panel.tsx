/**
 * Phase 10C-2B-1 — Panel A: Portfolio Summary. Pure, props-only. The headline cards
 * (status / exposure / capital / risk / trade counts) plus the capital-used and risk-used
 * meters. Every figure is already fail-closed by the derivation layer.
 */

import { Panel, type PanelPollState } from "./console-ui";
import { Meter, Tile } from "./portfolio-viz";
import type { MeterView, SummaryCard } from "@/lib/portfolio-terminal-derivations";

export function PortfolioSummaryPanel({
  cards,
  capital,
  risk,
  state,
}: {
  cards: SummaryCard[];
  capital: MeterView;
  risk: MeterView;
  state: PanelPollState;
}) {
  return (
    <Panel
      title="Portfolio Summary"
      hint="Top-line book state aggregated VERBATIM from the served decisions — status, exposure, capital and risk usage, and the candidate-trade counts. $-figures fail closed to — when a leg is unavailable."
      state={state}
    >
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
        {cards.map((c) => (
          <Tile
            key={c.label}
            label={c.label}
            value={c.value}
            tone={c.tone}
            hint={c.hint}
            qualifier={c.qualifier}
          />
        ))}
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Meter
          label="capital used"
          pct={capital.pct}
          display={capital.available ? `${capital.usedLabel} / ${capital.remainingLabel} free` : "—"}
          tone="info"
          hint={capital.basis}
        />
        <Meter
          label="risk used"
          pct={risk.pct}
          display={risk.available ? `${risk.usedLabel} / ${risk.remainingLabel} free` : "—"}
          tone="warning"
          hint={risk.basis}
        />
      </div>
    </Panel>
  );
}
