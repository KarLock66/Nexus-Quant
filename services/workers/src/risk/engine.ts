/**
 * Risk Engine (Phase 8) — the orchestration that sits between Signal Generation and
 * Execution. For each proposed (already-sized) order it:
 *
 *   1. blocks immediately if trading is HALTED (the kill switch survives restart)
 *   2. evaluates the GLOBAL kill-switch triggers from the freshly-built capital model
 *      (drawdown / leverage / daily-loss / external health) — a trip ENGAGES the
 *      switch (journaled) and halts all new orders until an explicit reset
 *   3. runs the FAIL-CLOSED pre-trade gate (the six hard checks)
 *   4. journals the outcome to the append-only risk event store BEFORE returning
 *
 * Every decision is journaled, so the entire RiskControlState (halt status + trigger,
 * session baseline, drawdown high-water-mark, counters) is reconstructable from the
 * journal alone (recovery.ts) — no in-memory-only state. FAIL-CLOSED throughout: an
 * un-journalable decision (even a passing check) BLOCKS, a halt that cannot be
 * persisted still halts in-memory, and any uncertainty resolves to "do not trade".
 *
 * The engine is the single mandatory path to an approval — the integration hook
 * (integration.ts) wires it in front of the execution stage so no order reaches an
 * adapter without a passing risk decision.
 */

import {
  DEFAULT_ACCOUNT_CONFIG,
  type AccountConfig,
} from "../market/account.js";
import type { Account, Position } from "../market/types.js";
import { errMsg } from "../lib/log.js";
import { buildCapitalSnapshot } from "./capital.js";
import type { RiskEventStore } from "./events.js";
import { DEFAULT_RISK_LIMITS, evaluatePreTrade, projectOrder } from "./gate.js";
import { currentDrawdown, evaluateTriggers } from "./kill-switch.js";
import { parseDecimal } from "./money.js";
import { applyRiskRecord, initialRiskControlState } from "./state.js";
import type {
  CapitalSnapshot,
  HealthSignals,
  KillSwitchTrigger,
  ProposedOrder,
  RiskControlState,
  RiskDecision,
  RiskEventType,
  RiskJournalInput,
  RiskJournalRecord,
  RiskLimits,
} from "./types.js";

/** The market view the engine builds its capital model + projections from. */
export interface MarketView {
  account: Account;
  positions: Record<string, Position>;
}

export interface EvaluateContext {
  /** External health signals consulted by the kill switch (stale data, etc.). */
  health?: HealthSignals;
}

export interface RiskEngineDeps {
  store: RiskEventStore;
  limits?: RiskLimits;
  accountConfig?: AccountConfig;
  /** Seed state (e.g. recovered on restart); defaults to the empty pre-history. */
  state?: RiskControlState;
}

export class RiskEngine {
  private readonly store: RiskEventStore;
  readonly limits: RiskLimits;
  readonly accountConfig: AccountConfig;
  private _state: RiskControlState;

  constructor(deps: RiskEngineDeps) {
    this.store = deps.store;
    this.limits = deps.limits ?? DEFAULT_RISK_LIMITS;
    this.accountConfig = deps.accountConfig ?? DEFAULT_ACCOUNT_CONFIG;
    this._state = deps.state ?? initialRiskControlState();
  }

  /** The current journal-derived control state (halt status, baseline, peak, counts). */
  get state(): RiskControlState {
    return this._state;
  }

  /** True when trading is halted (no new order will be approved until reset). */
  isHalted(): boolean {
    return this._state.halted;
  }

  /** Append a record and fold it into the live state (keeping live == recovered). */
  private async appendAndFold(input: RiskJournalInput): Promise<RiskJournalRecord> {
    const record = await this.store.append(input);
    this._state = applyRiskRecord(this._state, record);
    return record;
  }

  /**
   * Evaluate one proposed order. Returns an approval only when trading is not halted,
   * no global trigger trips, every pre-trade check passes, AND the PASS is durably
   * journaled. Any other outcome blocks (fail-closed).
   */
  async evaluate(
    order: ProposedOrder,
    view: MarketView,
    ctx: EvaluateContext = {},
  ): Promise<RiskDecision> {
    const capital = buildCapitalSnapshot(view.account, view.positions, this.accountConfig);

    // Already halted → block. The halt is already journaled; no new record per order.
    if (this._state.halted) {
      return {
        approved: false,
        reason: "TRADING_HALTED",
        eventType: "TRADING_HALTED",
        detail: `trading halted (${this._state.trigger ?? "?"}): ${this._state.haltDetail ?? ""}`,
        capital,
      };
    }

    const equity = parseDecimal(capital.accountEquity);
    const baseline =
      this._state.baselineEquity !== null ? parseDecimal(this._state.baselineEquity) : equity;
    const priorPeak =
      this._state.peakEquity !== null ? parseDecimal(this._state.peakEquity) : -Infinity;
    const peak = Math.max(priorPeak, equity);
    const dailyPnL = equity - baseline;
    const drawdown = currentDrawdown(peak, equity);

    // 2) GLOBAL kill-switch triggers (drawdown / leverage / daily-loss / health).
    const trip = evaluateTriggers({
      capital,
      limits: this.limits,
      dailyPnL,
      drawdown,
      ...(ctx.health !== undefined ? { health: ctx.health } : {}),
    });
    if (trip) {
      await this.halt(trip.detail, trip.trigger, capital);
      return {
        approved: false,
        reason: "TRADING_HALTED",
        eventType: "KILL_SWITCH_TRIGGERED",
        detail: `${trip.trigger}: ${trip.detail}`,
        capital,
      };
    }

    // 3) FAIL-CLOSED pre-trade gate.
    const projection = projectOrder(view.positions, capital, order, this.accountConfig.leverage);
    const verdict = evaluatePreTrade(order, projection, capital, this.limits, dailyPnL);

    // 4) Journal the outcome. A PASS must be durably recorded BEFORE we approve
    //    (fail-closed: never trade on a decision we could not record).
    if (verdict.approved) {
      try {
        await this.appendAndFold({
          type: "RISK_CHECK_PASSED",
          reason: "PASSED",
          detail: "all pre-trade checks passed",
          symbol: order.symbol,
          capital,
          trigger: null,
          order,
        });
      } catch (err) {
        return {
          approved: false,
          reason: "FAIL_CLOSED",
          eventType: "RISK_CHECK_FAILED",
          detail: `risk journal write failed: ${errMsg(err)}`,
          capital,
        };
      }
      return { approved: true, capital };
    }

    // A rejection ALWAYS journals the umbrella RISK_CHECK_FAILED (the canonical "a
    // pre-trade check failed" event), PLUS the specific hard-limit breach event
    // (POSITION_LIMIT_BREACHED / LEVERAGE_LIMIT_BREACHED) when the failure maps to
    // one — so the failure path realizes the full event model. The order is blocked
    // regardless of journaling success (fail-closed: a rejection never executes).
    try {
      await this.appendAndFold({
        type: "RISK_CHECK_FAILED",
        reason: verdict.reason,
        detail: verdict.detail,
        symbol: order.symbol,
        capital,
        trigger: null,
        order,
      });
      if (verdict.eventType !== "RISK_CHECK_FAILED") {
        await this.appendAndFold({
          type: verdict.eventType,
          reason: verdict.reason,
          detail: verdict.detail,
          symbol: order.symbol,
          capital,
          trigger: null,
          order,
        });
      }
    } catch (err) {
      // Journaling the rejection failed; the order is blocked anyway (safe direction).
      return {
        approved: false,
        reason: verdict.reason,
        eventType: verdict.eventType,
        detail: `${verdict.detail} (risk journal write failed: ${errMsg(err)})`,
        capital,
      };
    }

    return {
      approved: false,
      reason: verdict.reason,
      eventType: verdict.eventType,
      detail: verdict.detail,
      capital,
    };
  }

  /**
   * Engage the kill switch — halt all trading. A trigger-driven halt journals the
   * specific breach (for DRAWDOWN/LEVERAGE) then KILL_SWITCH_TRIGGERED then
   * TRADING_HALTED; an operator halt (no trigger) journals TRADING_HALTED with cause
   * MANUAL. FAIL-CLOSED: if the journal write fails, the engine STILL halts in-memory
   * (capital preservation) and rethrows so the caller can escalate.
   */
  async halt(
    detail: string,
    trigger?: KillSwitchTrigger,
    capital: CapitalSnapshot | null = null,
  ): Promise<void> {
    const reason = trigger ?? "MANUAL";
    const breachType: RiskEventType | null =
      trigger === "DRAWDOWN_BREACH"
        ? "DRAWDOWN_LIMIT_BREACHED"
        : trigger === "LEVERAGE_BREACH"
          ? "LEVERAGE_LIMIT_BREACHED"
          : null;
    try {
      if (breachType) {
        await this.appendAndFold({
          type: breachType,
          reason,
          detail,
          symbol: null,
          capital,
          trigger: null,
          order: null,
        });
      }
      if (trigger) {
        await this.appendAndFold({
          type: "KILL_SWITCH_TRIGGERED",
          reason,
          detail,
          symbol: null,
          capital,
          trigger,
          order: null,
        });
      }
      await this.appendAndFold({
        type: "TRADING_HALTED",
        reason,
        detail,
        symbol: null,
        capital,
        trigger: trigger ?? null,
        order: null,
      });
    } catch (err) {
      // Durability failed, but we must NOT keep trading: halt in-memory regardless.
      this._state = {
        ...this._state,
        halted: true,
        trigger: trigger ?? "MANUAL",
        haltDetail: `${detail} (journal write failed: ${errMsg(err)})`,
      };
      throw err;
    }
  }

  /**
   * Reset the kill switch back to a trading state — the ONLY way to clear a halt
   * (no automatic recovery). Journals TRADING_RESUMED so the cleared state is durable.
   */
  async reset(detail = "operator reset"): Promise<void> {
    await this.appendAndFold({
      type: "TRADING_RESUMED",
      reason: "RESET",
      detail,
      symbol: null,
      capital: null,
      trigger: null,
      order: null,
    });
  }
}
