"use client";

import { useEffect, useId, useState } from "react";
import type { RuntimeState } from "@nexus/control";
import {
  runKill,
  runResume,
  useAudit,
  useIncidents,
  usePermission,
  useProtection,
  useRecovery,
  useRuntimeState,
  useRunbooks,
  type PollState,
} from "@/lib/control-client";
import type {
  IncidentWindow,
  ProtectionView,
  RecoveryView,
  RunbooksView,
  RuntimeStateView,
  TradingPermissionView,
} from "@/lib/control-types";
import { Badge, Dot, fmtDuration, Metric, Panel, relTime, type Tone } from "./console-ui";
import { OperatorTokenField } from "./operator-token-field";
import { getOperatorToken } from "@/lib/operator-token";

/* ─────────────────── state → tone ─────────────────── */

const STATE_TONE: Record<RuntimeState, Tone> = {
  BOOTING: "neutral",
  STARTING: "neutral",
  HEALTHY: "positive",
  DEGRADED: "warning",
  PROTECTED: "negative",
  STOPPED: "negative",
  RECOVERING: "info",
  FAILED: "negative",
};

const SEVERITY_TONE: Record<string, Tone> = {
  INFO: "neutral",
  WARNING: "warning",
  CRITICAL: "negative",
  EMERGENCY: "negative",
};

/* ─────────────────── A. Runtime State ─────────────────── */

function RuntimeStatePanel({ state }: { state: PollState<RuntimeStateView> }) {
  const d = state.data;
  return (
    <Panel
      title="Runtime State"
      hint="Deterministic production state machine. Current state, last transition, reason, and time in state."
      badge={d && <Badge tone={STATE_TONE[d.current]} text={d.current} />}
      state={state}
    >
      {d && (
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-2">
            <Metric label="Current state" value={d.current} sub={d.previousState ? `from ${d.previousState}` : "initial"} />
            <Metric label="Time in state" value={fmtDuration(d.durationSeconds)} sub={`since ${relTime(d.enteredAt)}`} />
          </div>
          <div className="rounded-md border border-(--color-line) bg-(--color-surface-900)/60 px-3 py-2">
            <div className="font-mono text-[10px] uppercase tracking-wider text-slate-500">transition reason</div>
            <div className="mt-0.5 text-[13px] text-slate-200">{d.reason}</div>
            {d.affectedComponents.length > 0 && (
              <div className="mt-1 flex flex-wrap gap-1">
                {d.affectedComponents.map((c) => (
                  <span key={c} className="rounded border border-(--color-line) px-1.5 py-0.5 font-mono text-[10px] text-slate-400">
                    {c}
                  </span>
                ))}
              </div>
            )}
          </div>
          <div className="space-y-1 border-t border-(--color-line) pt-2">
            <div className="font-mono text-[10px] uppercase tracking-wider text-slate-600">recent transitions</div>
            {d.recent.slice(0, 8).map((t, i) => (
              <div key={i} className="flex items-center justify-between text-[11px]">
                <span className="flex items-center gap-1.5">
                  <Dot tone={STATE_TONE[t.state]} />
                  <span className="font-mono text-slate-300">
                    {t.previousState ?? "∅"} → {t.state}
                  </span>
                </span>
                <span className="font-mono text-slate-600">{relTime(t.enteredAt)}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </Panel>
  );
}

/* ─────────────────── B. Trading Permission ─────────────────── */

function PermissionPanel({ state }: { state: PollState<TradingPermissionView> }) {
  const d = state.data;
  return (
    <Panel
      title="Trading Permission"
      hint="canTrade() — fail-closed authorization every execution path consults. ALLOWED only when all conditions hold."
      badge={d && <Badge tone={d.permission === "ALLOWED" ? "positive" : "negative"} text={d.permission} />}
      state={state}
    >
      {d && (
        <div className="space-y-1.5">
          {d.reasons.map((r) => (
            <div
              key={r.check}
              className="flex items-center justify-between gap-3 rounded-md border border-(--color-line) bg-(--color-surface-900)/50 px-3 py-1.5"
            >
              <span className="flex items-center gap-2">
                <Dot tone={r.ok ? "positive" : "negative"} />
                <span className="text-[13px] text-slate-200">{r.label}</span>
              </span>
              <span className={`max-w-[55%] truncate text-right font-mono text-[11px] ${r.ok ? "text-slate-500" : "text-(--color-negative)"}`}>
                {r.detail}
              </span>
            </div>
          ))}
        </div>
      )}
    </Panel>
  );
}

/* ─────────────────── C. Kill Switch ─────────────────── */

function KillSwitchPanel({
  permission,
  onChanged,
}: {
  permission: PollState<TradingPermissionView>;
  onChanged: () => void;
}) {
  const engaged = permission.data?.reasons.find((r) => r.check === "kill_switch")?.ok === false;
  const blocked = permission.data?.permission === "BLOCKED";
  const [actor, setActor] = useState("");
  const [reason, setReason] = useState("");
  const [pending, setPending] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const actorId = useId();
  const reasonId = useId();

  const submit = async (kind: "kill" | "resume") => {
    if (reason.trim() === "") {
      setMsg({ ok: false, text: "a reason is required" });
      return;
    }
    if (getOperatorToken().trim() === "") {
      setMsg({ ok: false, text: "an operator token is required (paste the OPS_CONTROL_TOKEN value)" });
      return;
    }
    setPending(true);
    setMsg(null);
    try {
      const r = kind === "kill" ? await runKill(actor || "operator", reason) : await runResume(actor || "operator", reason);
      setMsg({ ok: r.ok, text: r.message });
      setReason("");
      onChanged();
    } catch (err) {
      setMsg({ ok: false, text: err instanceof Error ? err.message : String(err) });
    } finally {
      setPending(false);
    }
  };

  return (
    <Panel
      title="Global Kill Switch"
      hint="System-wide emergency stop. Engaging blocks all execution immediately (fail-closed); the runtime never auto-resumes."
      badge={
        permission.data && (
          <Badge tone={engaged ? "negative" : "positive"} text={engaged ? "ENGAGED" : "DISENGAGED"} />
        )
      }
      state={permission}
    >
      <div className="space-y-3">
        <div className="rounded-md border border-(--color-line) bg-(--color-surface-900)/60 px-3 py-2 text-[12px] text-slate-300">
          {engaged
            ? "Trading is STOPPED by operator action. Resolve the underlying issue, then resume with an explicit reason."
            : blocked
              ? "Trading is currently blocked by a control condition (see Trading Permission)."
              : "Trading is permitted. Engage the kill switch to stop all execution."}
        </div>
        <OperatorTokenField />
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <div>
            <label
              htmlFor={actorId}
              className="mb-1 block font-mono text-[10px] uppercase tracking-wider text-slate-500"
            >
              operator
            </label>
            <input
              id={actorId}
              value={actor}
              onChange={(e) => setActor(e.target.value)}
              placeholder="your id"
              className="w-full rounded-md border border-(--color-line) bg-(--color-surface-900) px-3 py-2 text-[13px] text-slate-200 outline-none focus:border-(--color-accent-500)/50"
            />
          </div>
          <div>
            <label
              htmlFor={reasonId}
              className="mb-1 block font-mono text-[10px] uppercase tracking-wider text-slate-500"
            >
              reason <span className="text-(--color-negative)">*</span>
            </label>
            <input
              id={reasonId}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="required"
              required
              aria-required="true"
              className="w-full rounded-md border border-(--color-line) bg-(--color-surface-900) px-3 py-2 text-[13px] text-slate-200 outline-none focus:border-(--color-accent-500)/50"
            />
          </div>
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            disabled={pending}
            onClick={() => void submit("kill")}
            className="flex-1 rounded-md border border-(--color-negative)/40 bg-(--color-negative)/10 px-3 py-2 text-[13px] font-semibold text-(--color-negative) transition-colors hover:bg-(--color-negative)/20 disabled:opacity-50"
          >
            Engage Kill Switch
          </button>
          <button
            type="button"
            disabled={pending}
            onClick={() => void submit("resume")}
            className="flex-1 rounded-md border border-(--color-positive)/40 bg-(--color-positive)/10 px-3 py-2 text-[13px] font-semibold text-(--color-positive) transition-colors hover:bg-(--color-positive)/20 disabled:opacity-50"
          >
            Resume
          </button>
        </div>
        {msg && (
          <div
            role="status"
            className={`rounded-md border px-3 py-2 font-mono text-[11px] ${
              msg.ok
                ? "border-(--color-positive)/30 bg-(--color-positive)/5 text-(--color-positive)"
                : "border-(--color-warning)/30 bg-(--color-warning)/5 text-(--color-warning)"
            }`}
          >
            {msg.text}
          </div>
        )}
      </div>
    </Panel>
  );
}

/* ─────────────────── E. Recovery + Protected Components ─────────────────── */

function RecoveryPanel({ state }: { state: PollState<RecoveryView> }) {
  const d = state.data;
  return (
    <Panel
      title="Recovery Status"
      hint="When a protected component returns healthy, recovery verifies dependencies before resuming. Never auto-resumes blindly."
      badge={d && <Badge tone={d.recovering ? "info" : "positive"} text={d.recovering ? "RECOVERING" : "stable"} />}
      state={state}
      empty={d ? d.components.length === 0 : false}
    >
      {d && d.components.length > 0 && (
        <div className="space-y-2">
          {d.components.map((c) => (
            <div key={c.component} className="rounded-md border border-(--color-line) bg-(--color-surface-900)/50 px-3 py-2">
              <div className="font-mono text-[12px] text-slate-200">{c.component}</div>
              <ul className="mt-1 space-y-0.5">
                {c.plan.map((p, i) => (
                  <li key={i} className="flex items-center gap-1.5 text-[11px] text-slate-400">
                    <span className="text-slate-600">→</span> {p}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
      {d && d.components.length === 0 && (
        <p className="py-4 text-center text-xs text-(--color-positive)">No components under recovery.</p>
      )}
    </Panel>
  );
}

function ProtectionPanel({ state }: { state: PollState<ProtectionView> }) {
  const d = state.data;
  return (
    <Panel
      title="Protected Components"
      hint="Active protection events: which components tripped, why, and since when. Deduped by rule while active."
      badge={d && <Badge tone={d.events.length > 0 ? "negative" : "positive"} text={`${d.events.length} active`} />}
      state={state}
      empty={d ? d.events.length === 0 : false}
    >
      {d && d.events.length > 0 && (
        <div className="space-y-2">
          {d.events.map((e) => (
            <div key={e.id} className="rounded-md border border-(--color-line) bg-(--color-surface-900)/60 px-3 py-2">
              <div className="flex items-center justify-between gap-2">
                <span className="flex items-center gap-2">
                  <Badge tone={SEVERITY_TONE[e.severity] ?? "warning"} text={e.severity} />
                  <span className="font-mono text-[12px] text-slate-200">{e.ruleId}</span>
                </span>
                <span className="font-mono text-[10px] text-slate-500">since {relTime(e.firstSeen)}</span>
              </div>
              {e.detail && <div className="mt-1 font-mono text-[11px] text-slate-400">{e.detail}</div>}
            </div>
          ))}
        </div>
      )}
      {d && d.events.length === 0 && (
        <p className="py-4 text-center text-xs text-(--color-positive)">No protection events active.</p>
      )}
    </Panel>
  );
}

/* ─────────────────── F. Operator Runbooks ─────────────────── */

function RunbooksPanel({ state }: { state: PollState<RunbooksView> }) {
  const d = state.data;
  const [openKey, setOpenKey] = useState<string | null>(null);
  const list = d ? (d.applicable.length > 0 ? d.applicable : d.all) : [];
  const showingApplicable = d ? d.applicable.length > 0 : false;
  return (
    <Panel
      title="Operator Runbooks"
      hint="Problem · Impact · Diagnosis · Required Action · Verification. Applicable runbooks surface first when incidents are active."
      badge={d && <Badge tone={showingApplicable ? "warning" : "neutral"} text={showingApplicable ? `${d.applicable.length} applicable` : "catalog"} />}
      state={state}
    >
      {d && (
        <div className="space-y-1.5">
          {list.map((rb) => {
            const open = openKey === rb.key;
            return (
              <div key={rb.key} className="rounded-md border border-(--color-line) bg-(--color-surface-900)/50">
                <button
                  type="button"
                  onClick={() => setOpenKey(open ? null : rb.key)}
                  aria-expanded={open}
                  className="flex w-full items-center justify-between px-3 py-2 text-left"
                >
                  <span className="text-[13px] text-slate-200">{rb.title}</span>
                  <span className="font-mono text-[10px] text-slate-500" aria-hidden="true">
                    {open ? "−" : "+"}
                  </span>
                </button>
                {open && (
                  <div className="space-y-2 border-t border-(--color-line) px-3 py-2 text-[12px]">
                    <RunbookField label="Problem" value={rb.problem} />
                    <RunbookField label="Impact" value={rb.impact} />
                    <RunbookField label="Diagnosis" value={rb.diagnosis} />
                    <RunbookField label="Required action" value={rb.requiredAction} />
                    <div>
                      <div className="font-mono text-[10px] uppercase tracking-wider text-slate-500">verification</div>
                      <ul className="mt-0.5 space-y-0.5">
                        {rb.verificationSteps.map((s, i) => (
                          <li key={i} className="flex items-center gap-1.5 text-slate-300">
                            <span className="text-slate-600">✓</span> {s}
                          </li>
                        ))}
                      </ul>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </Panel>
  );
}

function RunbookField({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="font-mono text-[10px] uppercase tracking-wider text-slate-500">{label}</div>
      <div className="text-slate-300">{value}</div>
    </div>
  );
}

/* ─────────────────── G. Incident Timeline ─────────────────── */

const WINDOWS: IncidentWindow[] = ["1h", "24h", "7d", "30d"];

function IncidentTimelinePanel() {
  const [window, setWindow] = useState<IncidentWindow>("24h");
  const state = useIncidents(window);
  const d = state.data;
  return (
    <Panel
      title="Incident Timeline"
      hint="Chronological incident history with start, duration, severity, affected components, and recovery outcome."
      badge={
        <div className="flex gap-1" role="group" aria-label="Incident window">
          {WINDOWS.map((w) => (
            <button
              key={w}
              type="button"
              onClick={() => setWindow(w)}
              aria-pressed={window === w}
              className={`rounded border px-1.5 py-0.5 font-mono text-[10px] uppercase ${
                window === w
                  ? "border-(--color-accent-500)/40 bg-(--color-accent-500)/10 text-(--color-accent-500)"
                  : "border-(--color-line) text-slate-500 hover:text-slate-300"
              }`}
            >
              {w}
            </button>
          ))}
        </div>
      }
      state={state}
      empty={d ? d.incidents.length === 0 : false}
    >
      {d && d.incidents.length > 0 && (
        <div className="space-y-2">
          {d.incidents.map((inc) => (
            <div key={inc.id} className="rounded-md border border-(--color-line) bg-(--color-surface-900)/60 px-3 py-2">
              <div className="flex items-center justify-between gap-2">
                <span className="flex items-center gap-2">
                  <Badge tone={SEVERITY_TONE[inc.severity] ?? "warning"} text={inc.severity} />
                  <span className="font-mono text-[12px] text-slate-200">{inc.type}</span>
                  <Badge tone={inc.status === "OPEN" ? "negative" : "positive"} text={inc.status} />
                </span>
                <span className="font-mono text-[10px] text-slate-500">{relTime(inc.startedAt)}</span>
              </div>
              <div className="mt-1 flex items-center justify-between font-mono text-[10px] text-slate-500">
                <span>{inc.affectedComponents.join(", ") || "—"}</span>
                <span>
                  {fmtDuration(inc.durationSec)}
                  {inc.recoveryOutcome ? ` · ${inc.recoveryOutcome}` : ""}
                </span>
              </div>
            </div>
          ))}
        </div>
      )}
      {d && d.incidents.length === 0 && (
        <p className="py-4 text-center text-xs text-(--color-positive)">No incidents in this window.</p>
      )}
    </Panel>
  );
}

/* ─────────────────── H. Audit Trail ─────────────────── */

/** Debounce the audit query so typing doesn't fire a request per keystroke. */
const AUDIT_SEARCH_DEBOUNCE_MS = 300;

function AuditPanel() {
  const [q, setQ] = useState("");
  const [debouncedQ, setDebouncedQ] = useState("");
  useEffect(() => {
    const id = setTimeout(() => setDebouncedQ(q), AUDIT_SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(id);
  }, [q]);

  const state = useAudit(debouncedQ);
  const d = state.data;
  return (
    <Panel
      title="Audit Trail"
      hint="Immutable, append-only record of kill/resume, protection, recovery, manual actions, and state changes."
      badge={d && <Badge tone="neutral" text={`${d.total} entries`} />}
      state={state}
    >
      <div className="space-y-2">
        <input
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="search actor / action / reason…"
          aria-label="Search audit trail"
          className="w-full rounded-md border border-(--color-line) bg-(--color-surface-900) px-3 py-1.5 text-[12px] text-slate-200 outline-none focus:border-(--color-accent-500)/50"
        />
        {d && d.entries.length === 0 ? (
          <p className="py-4 text-center text-xs text-slate-500">
            {debouncedQ ? `No audit entries match “${debouncedQ}”.` : "No audit entries."}
          </p>
        ) : (
          <div
            className="max-h-80 space-y-1 overflow-y-auto"
            role="region"
            aria-label="Audit entries"
            tabIndex={0}
          >
            {d?.entries.map((a) => (
              <div key={a.id} className="rounded border border-(--color-line)/60 bg-(--color-surface-900)/40 px-2.5 py-1.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-mono text-[11px] text-slate-200">{a.action}</span>
                  <span className="font-mono text-[10px] text-slate-600">{relTime(a.ts)}</span>
                </div>
                <div className="flex items-center justify-between gap-2 font-mono text-[10px] text-slate-500">
                  <span>
                    {a.actor} · {a.result}
                  </span>
                  {a.reason && <span className="max-w-[55%] truncate">{a.reason}</span>}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </Panel>
  );
}

/* ─────────────────── composition (Section J) ─────────────────── */

export function ControlCenter() {
  const runtime = useRuntimeState();
  const permission = usePermission();
  const protection = useProtection();
  const recovery = useRecovery();
  const runbooks = useRunbooks();

  const refreshCore = () => {
    runtime.refetch();
    permission.refetch();
    protection.refetch();
    recovery.refetch();
  };

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2 xl:grid-cols-3">
      <RuntimeStatePanel state={runtime} />
      <PermissionPanel state={permission} />
      <KillSwitchPanel permission={permission} onChanged={refreshCore} />
      <RecoveryPanel state={recovery} />
      <ProtectionPanel state={protection} />
      <RunbooksPanel state={runbooks} />
      <div className="lg:col-span-2 xl:col-span-2">
        <IncidentTimelinePanel />
      </div>
      <AuditPanel />
    </div>
  );
}
