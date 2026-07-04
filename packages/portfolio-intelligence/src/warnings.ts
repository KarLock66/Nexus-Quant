/**
 * PortfolioWarnings — a deterministic, ordered list of portfolio risks. Every warning is
 * derived ONLY from already-aggregated facts (+ the heat concentration), carries a severity,
 * a human reason, a source, a provenance tag and an audit basis, and is emitted in a fixed
 * order so identical inputs serialize identically. Nothing is fabricated; a warning fires only
 * when its real source value breaches a documented threshold.
 */

import { derivePortfolioFacts, type PortfolioFacts } from "./facts.js";
import { concentrationScore } from "./heat.js";
import { round } from "./util.js";
import type {
  PortfolioInputs,
  PortfolioWarning,
  PortfolioWarnings,
  WarningSeverity,
} from "./types.js";

/** Largest single-symbol share of gross exposure (%), 0 when no exposure. */
function topSymbolSharePct(facts: PortfolioFacts): { symbol: string | null; pct: number } {
  if (facts.grossExposure <= 0) return { symbol: null, pct: 0 };
  const bySymbol = new Map<string, number>();
  for (const p of facts.open) {
    if (p.notional === null) continue;
    bySymbol.set(p.symbol, (bySymbol.get(p.symbol) ?? 0) + p.notional);
  }
  let symbol: string | null = null;
  let notional = -1;
  for (const [s, n] of bySymbol) {
    // Deterministic tie-break: higher notional wins; equal notional → lexicographically first.
    if (n > notional || (n === notional && symbol !== null && s < symbol)) {
      notional = n;
      symbol = s;
    }
  }
  return { symbol, pct: round((notional / facts.grossExposure) * 100, 2) };
}

export function buildPortfolioWarnings(inputs: PortfolioInputs): PortfolioWarnings {
  const facts = derivePortfolioFacts(inputs);
  const cfg = facts.cfg;
  const out: PortfolioWarning[] = [];

  const push = (
    id: string,
    severity: WarningSeverity,
    reason: string,
    source: PortfolioWarning["source"],
    provenance: PortfolioWarning["provenance"],
    basis: string,
  ) => out.push({ id, severity, reason, source, provenance, basis });

  // ── hard gates (verbatim from the served context) ──
  if (facts.killEngaged) {
    push("kill-engaged", "CRITICAL", "Kill switch engaged — trading globally stopped", "control", "real", "killEngaged=true");
  }
  if (facts.controlAllowed === false) {
    push("control-blocked", "CRITICAL", "Control plane is BLOCKING trading", "control", "real", "controlPermission=BLOCKED");
  }
  if (facts.runtimeHealthy === false) {
    push("runtime-unhealthy", "HIGH", "Runtime is not HEALTHY — trading gated", "runtime", "real", `runtimeState=${inputs.runtimeState ?? "unknown"}`);
  } else if (facts.runtimeHealthy === null) {
    push("runtime-unknown", "LOW", "Runtime state unknown (control plane off / no data) — fail-closed", "runtime", "unavailable", "runtimeState=null");
  }

  // ── risk budget ──
  if (facts.riskUsedAbs > facts.riskBudgetAbs && facts.riskBudgetAbs > 0) {
    push("risk-over-budget", "CRITICAL", "Portfolio risk exceeds the risk budget", "risk", "derived", `risk $${facts.riskUsedAbs} > budget $${facts.riskBudgetAbs} (${cfg.maxPortfolioRiskPct}% of equity)`);
  }

  // ── capital ──
  if (facts.openCount > 0 && facts.capitalAvailable <= 0) {
    push("no-capital", "HIGH", "No capital remaining — book is fully deployed", "capital", "derived", `capitalUsed $${facts.capitalUsed} ≥ equity $${facts.assumedEquity}`);
  } else if (facts.openCount > 0 && facts.capitalPct >= cfg.capitalWarnPct) {
    push("low-capital", "MEDIUM", "Low capital remaining — most of the book is deployed", "capital", "derived", `capital ${facts.capitalPct}% ≥ ${cfg.capitalWarnPct}% threshold`);
  }

  // ── concentration ──
  const conc = concentrationScore(facts);
  const top = topSymbolSharePct(facts);
  if (top.symbol !== null && top.pct >= cfg.concentrationWarnPct) {
    push("over-concentrated", "MEDIUM", `Portfolio over-concentrated in ${top.symbol}`, "concentration", "derived", `${top.symbol} ${top.pct}% of gross ≥ ${cfg.concentrationWarnPct}% (HHI ${conc}/100)`);
  }

  // ── directional skew (only meaningful with exposure) ──
  if (facts.grossExposure > 0) {
    const longPct = round((facts.longExposure / facts.grossExposure) * 100, 2);
    const shortPct = round((facts.shortExposure / facts.grossExposure) * 100, 2);
    if (longPct >= cfg.directionalSkewWarnPct) {
      push("long-skew", "MEDIUM", "Too much long exposure — one-sided book", "exposure", "derived", `long ${longPct}% of gross ≥ ${cfg.directionalSkewWarnPct}%`);
    } else if (shortPct >= cfg.directionalSkewWarnPct) {
      push("short-skew", "MEDIUM", "Too much short exposure — one-sided book", "exposure", "derived", `short ${shortPct}% of gross ≥ ${cfg.directionalSkewWarnPct}%`);
    }
  }

  // ── actionability / freshness / data quality ──
  if (facts.totalCount > 0 && facts.openCount === 0) {
    push("no-actionable", "LOW", "No actionable trades — nothing currently executable", "signal", "derived", `0 OPEN of ${facts.totalCount} candidates`);
  }
  if (facts.staleCount > 0) {
    push("stale-decisions", "MEDIUM", "Stale decisions present — past the freshness bound", "freshness", "derived", `${facts.staleCount} directional signal(s) stale (> ${cfg.signalStaleSeconds}s)`);
  }
  if (facts.lowDqCount > 0) {
    push("low-dq", "MEDIUM", "Low data quality on one or more signals", "data-quality", "real", `${facts.lowDqCount} signal(s) below DQ floor ${cfg.minDqScore}`);
  }

  const critical = out.filter((w) => w.severity === "CRITICAL").length;
  const high = out.filter((w) => w.severity === "HIGH").length;
  const medium = out.filter((w) => w.severity === "MEDIUM").length;
  const low = out.filter((w) => w.severity === "LOW").length;

  return {
    warnings: out,
    critical,
    high,
    medium,
    low,
    note:
      out.length === 0
        ? "no portfolio warnings"
        : `${out.length} warning(s): ${critical} critical, ${high} high, ${medium} medium, ${low} low`,
  };
}
