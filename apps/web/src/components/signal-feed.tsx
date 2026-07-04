"use client";

import { useEffect, useRef, useState } from "react";

interface SignalDTO {
  id: string;
  symbol: string;
  side: string;
  decision: string;
  confidence: string;
  featureHash: string;
  datasetHash: string;
  strategyVersionId: string;
  featureSnapshotId: string;
  createdAt: string;
  /** Origin venue of the admitting FeatureSnapshot; "DEMO" = synthetic lineage. */
  origin: string;
}

type ConnState = "connecting" | "live" | "polling" | "error";

/** Upper bound on rendered/retained signals (newest kept). */
const MAX_RENDER = 500;

/** Fallback poll cadence while the SSE stream is down (ms). */
const FALLBACK_POLL_MS = 5_000;

/** Re-attempt cadence after the browser CLOSES the EventSource permanently (ms). */
const SSE_RETRY_MS = 30_000;

const DECISION_STYLE: Record<string, string> = {
  LONG: "text-(--color-positive) border-(--color-positive)/40 bg-(--color-positive)/10",
  SHORT: "text-(--color-negative) border-(--color-negative)/40 bg-(--color-negative)/10",
  FLAT: "text-slate-400 border-(--color-line) bg-(--color-surface-800)",
};

function StatusPill({ state }: { state: ConnState }) {
  const map: Record<ConnState, { label: string; dot: string }> = {
    connecting: { label: "connecting", dot: "bg-(--color-warning)" },
    live: { label: "live · SSE", dot: "bg-(--color-positive)" },
    polling: { label: "polling", dot: "bg-(--color-warning)" },
    error: { label: "disconnected", dot: "bg-(--color-negative)" },
  };
  const { label, dot } = map[state];
  return (
    <span
      role="status"
      className="inline-flex items-center gap-2 font-mono text-[11px] uppercase tracking-widest text-slate-400"
    >
      <span className={`inline-block h-1.5 w-1.5 rounded-full ${dot}`} />
      {label}
    </span>
  );
}

export function SignalFeed() {
  const [signals, setSignals] = useState<SignalDTO[]>([]);
  const [conn, setConn] = useState<ConnState>("connecting");
  const [loaded, setLoaded] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const mapRef = useRef<Map<string, SignalDTO>>(new Map());

  function merge(incoming: SignalDTO[]) {
    const m = mapRef.current;
    // Dedup by signalId — re-delivery (poll overlap, SSE reconnect, refresh)
    // overwrites in place and never renders a second row.
    for (const s of incoming) m.set(s.id, s);
    // Stable newest-first order; id breaks createdAt ties deterministically.
    let arr = [...m.values()].sort(
      (a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id),
    );
    // Bound memory: keep only the newest MAX_RENDER and prune the dedup map to match.
    if (arr.length > MAX_RENDER) {
      arr = arr.slice(0, MAX_RENDER);
      m.clear();
      for (const s of arr) m.set(s.id, s);
    }
    setSignals(arr);
  }

  useEffect(() => {
    let es: EventSource | null = null;
    let poll: ReturnType<typeof setInterval> | null = null;
    let sseRetry: ReturnType<typeof setTimeout> | null = null;
    let cancelled = false;

    async function loadOnce() {
      try {
        const res = await fetch("/api/v1/signals?limit=100", { cache: "no-store" });
        if (!res.ok) throw new Error(`signals: HTTP ${res.status}`);
        const json = (await res.json()) as { data?: SignalDTO[]; error?: string };
        if (json.error) throw new Error(json.error);
        if (!cancelled && Array.isArray(json.data)) {
          merge(json.data);
          setFetchError(null);
          // A REST recovery while the stream is down goes back to "polling".
          setConn((c) => (c === "error" ? "polling" : c));
        }
      } catch (err) {
        if (!cancelled) {
          setFetchError(err instanceof Error ? err.message : String(err));
          // Both the stream and the fallback poll failing = disconnected.
          setConn((c) => (c === "live" ? c : "error"));
        }
      } finally {
        if (!cancelled) setLoaded(true);
      }
    }

    function stopPolling() {
      if (poll) {
        clearInterval(poll);
        poll = null;
      }
    }

    function startPolling() {
      if (cancelled || poll) return;
      poll = setInterval(() => {
        if (document.visibilityState === "hidden") return;
        void loadOnce();
      }, FALLBACK_POLL_MS);
    }

    function startSse() {
      try {
        const source = new EventSource("/api/v1/signals/stream");
        es = source;
        source.addEventListener("open", () => {
          if (cancelled) return;
          // The stream is (back) up — stop the fallback poll and go live.
          stopPolling();
          setConn("live");
          setFetchError(null);
        });
        source.addEventListener("signal", (e) => {
          try {
            const s = JSON.parse((e as MessageEvent).data) as SignalDTO;
            if (!cancelled) {
              merge([s]);
              // Data is flowing over the live stream — clear any stale banner a
              // server-side degradation frame left behind.
              setFetchError(null);
            }
          } catch {
            // ignore malformed frame
          }
        });
        source.addEventListener("stream-error", (e) => {
          // Server-side degradation frame (e.g. a DB read failed while the SSE
          // connection itself stayed up): surface a stale banner but do NOT
          // start the fallback poll — the stream is still live and recovers on
          // its own. (Named "stream-error" server-side because a frame named
          // "error" is indistinguishable from the browser's connection-error.)
          if (cancelled) return;
          try {
            const detail = (JSON.parse((e as MessageEvent).data) as { detail?: string }).detail;
            setFetchError(detail ?? "signal stream degraded");
          } catch {
            setFetchError("signal stream degraded");
          }
        });
        source.addEventListener("error", () => {
          if (cancelled) return;
          // readyState OPEN means the connection survived (transient hiccup) —
          // nothing to bridge. Otherwise EventSource is retrying on its own;
          // bridge the gap with polling instead of tearing the stream down.
          if (source.readyState === EventSource.OPEN) return;
          setConn("polling");
          startPolling();
          // CLOSED is permanent (the browser never retries a non-200/non-SSE
          // response, e.g. a proxy error page during a deploy). Re-attempt the
          // stream on a slow cadence; the fallback poll bridges the gap so data
          // keeps flowing either way.
          if (source.readyState === EventSource.CLOSED) scheduleSseRetry();
        });
      } catch {
        setConn("polling");
        startPolling();
      }
    }

    function scheduleSseRetry() {
      if (cancelled || sseRetry) return;
      sseRetry = setTimeout(() => {
        sseRetry = null;
        if (cancelled) return;
        // Don't burn connections while the tab is hidden — try again later.
        if (document.visibilityState === "hidden") {
          scheduleSseRetry();
          return;
        }
        es?.close();
        startSse();
      }, SSE_RETRY_MS);
    }

    void loadOnce().then(() => {
      if (!cancelled) startSse();
    });

    return () => {
      cancelled = true;
      if (es) es.close();
      if (sseRetry) clearTimeout(sseRetry);
      stopPolling();
    };
  }, []);

  const showBackendDown = loaded && signals.length === 0 && fetchError !== null;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="font-mono text-[11px] uppercase tracking-widest text-slate-500">
          {signals.length} signal{signals.length === 1 ? "" : "s"}
        </div>
        <StatusPill state={conn} />
      </div>

      {fetchError && signals.length > 0 && (
        <div
          role="status"
          className="rounded-md border border-(--color-warning)/30 bg-(--color-warning)/5 px-3 py-2 font-mono text-[11px] text-(--color-warning)"
        >
          stale — {fetchError}
        </div>
      )}

      {!loaded ? (
        <div className="space-y-2" aria-busy="true" role="status" aria-label="Loading signals">
          {[0, 1, 2].map((i) => (
            <div key={i} className="glass h-16 animate-pulse" />
          ))}
        </div>
      ) : showBackendDown ? (
        <div className="glass p-6 text-sm text-slate-400" role="alert">
          <p className="mb-1 text-slate-200">Signal feed unavailable.</p>
          <p>
            The signals API could not be reached — this is a backend failure, not an empty feed.
          </p>
          <p className="mt-2 font-mono text-[11px] text-(--color-warning)">{fetchError}</p>
        </div>
      ) : signals.length === 0 ? (
        <div className="glass p-6 text-sm text-slate-400">
          <p className="mb-1 text-slate-200">No signals yet.</p>
          <p>
            The signal engine has not published any{" "}
            <span className="font-mono text-slate-300">EngineSignal</span> rows. The
            pipeline generates them only from real ingested market data and an
            approved ACTIVE strategy — run the ingestion daemon and the worker:
          </p>
          <pre className="mt-3 overflow-x-auto rounded-md border border-(--color-line) bg-(--color-surface-900) p-3 font-mono text-xs text-slate-300">
            pnpm --filter @nexus/ingestion dev{"\n"}pnpm --filter @nexus/workers dev
          </pre>
        </div>
      ) : (
        <div className="space-y-2">
          {signals.map((s) => {
            const badge = DECISION_STYLE[s.decision] ?? DECISION_STYLE["FLAT"];
            return (
              <div
                key={s.id}
                className="glass glass-hover flex flex-wrap items-center justify-between gap-x-4 gap-y-2 p-4"
              >
                <div className="flex items-center gap-4">
                  <span
                    className={`rounded-md border px-2.5 py-1 font-mono text-xs font-semibold tracking-wider ${badge}`}
                  >
                    {s.decision}
                  </span>
                  <div>
                    <div className="flex items-center gap-2 text-sm font-medium text-slate-100">
                      {s.symbol}
                      {s.origin === "DEMO" && (
                        <span
                          title="generated from the synthetic DEMO lineage, not market data"
                          className="rounded border border-(--color-warning)/40 bg-(--color-warning)/10 px-1 py-px font-mono text-[9px] uppercase tracking-wider text-(--color-warning)"
                        >
                          demo
                        </span>
                      )}
                    </div>
                    <div className="font-mono text-[11px] text-slate-500">
                      bias {s.side} · conf {s.confidence}
                    </div>
                  </div>
                </div>
                <div className="text-right">
                  <div className="font-mono text-[11px] text-slate-500">
                    {new Date(s.createdAt).toLocaleString()}
                  </div>
                  <div
                    className="font-mono text-[10px] text-slate-600"
                    title={`featureHash ${s.featureHash} · datasetHash ${s.datasetHash}`}
                  >
                    fh:{s.featureHash.slice(0, 10)}… · ds:{s.datasetHash.slice(0, 10)}…
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
