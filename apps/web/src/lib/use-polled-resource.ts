"use client";

import { useCallback, useSyncExternalStore } from "react";

/**
 * The single polling primitive behind every live panel in the app.
 *
 * One registry entry per URL, shared by every subscriber of that URL:
 *  - exactly one interval + one in-flight request per endpoint, no matter how
 *    many components consume it (no duplicate polling);
 *  - every request carries a hard timeout: a hung backend response settles as a
 *    visible "timed out" error instead of freezing panels at their last state;
 *  - a monotonic sequence guard makes out-of-order commits impossible, and
 *    in-flight requests are aborted when the last consumer unmounts or an
 *    explicit refetch supersedes them (no stale-overwrites-fresh races);
 *  - consecutive failures back off exponentially (capped) so a dead endpoint is
 *    probed gently instead of hammered at full cadence forever;
 *  - polling pauses while the tab is hidden and refreshes immediately when it
 *    becomes visible again (no background request burn);
 *  - failures are logged once per distinct error, not once per poll cycle, and
 *    previously-fetched data is retained so panels degrade to "stale" instead
 *    of blanking.
 *
 * SSR note (deliberate architecture): `getServerSnapshot` always returns the
 * INITIAL loading snapshot, so server HTML contains only skeletons and ALL data
 * arrives via client polling after hydration. This is a pure client-side
 * operator console by design — it eliminates the entire class of time/locale
 * hydration mismatches at the cost of no server-rendered data.
 */

export interface PollState<T> {
  data: T | null;
  error: string | null;
  /** True only until the first settle (success or failure) for this URL. */
  loading: boolean;
  lastUpdated: number | null;
  refetch: () => void;
}

type Snapshot<T> = Omit<PollState<T>, "refetch">;

const INITIAL: Snapshot<unknown> = Object.freeze({
  data: null,
  error: null,
  loading: true,
  lastUpdated: null,
});

/** Hard per-request timeout — a black-holed response must settle visibly. */
const FETCH_TIMEOUT_MS = 15_000;
/** Ceiling for the consecutive-failure backoff window. */
const MAX_BACKOFF_MS = 60_000;
/** Timeout for one-shot command POSTs (kill/resume/actions). */
const COMMAND_TIMEOUT_MS = 15_000;

interface ApiEnvelope<T> {
  data: T;
}

interface Entry {
  name: string;
  snapshot: Snapshot<unknown>;
  settled: boolean;
  subscribers: Set<() => void>;
  /** Requested cadence per subscriber; the effective cadence is the minimum. */
  intervals: Map<symbol, number>;
  timer: ReturnType<typeof setInterval> | null;
  timerMs: number | null;
  seq: number;
  applied: number;
  controller: AbortController | null;
  lastLoggedError: string | null;
  /** Consecutive failed settles; reset to 0 on success. */
  failures: number;
  /** Epoch ms before which scheduled poll cycles are skipped (failure backoff). */
  backoffUntil: number;
}

const registry = new Map<string, Entry>();

/** Fetch + unwrap the `{ data }` envelope; abortable; hard timeout; typed errors. */
async function fetchEnvelope<T>(url: string, name: string, signal: AbortSignal): Promise<T> {
  const timeout = AbortSignal.timeout(FETCH_TIMEOUT_MS);
  const merged = AbortSignal.any([signal, timeout]);
  let res: Response;
  try {
    res = await fetch(url, {
      cache: "no-store",
      headers: { accept: "application/json" },
      signal: merged,
    });
  } catch (cause) {
    if (signal.aborted) throw cause; // superseded/unmounted — discarded by load()
    if (timeout.aborted) throw new Error(`${name}: timed out after ${FETCH_TIMEOUT_MS / 1000}s`);
    throw new Error(`${name}: unreachable`);
  }
  if (res.status === 404) throw new Error(`${name}: not found (404)`);
  if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);

  let json: Partial<ApiEnvelope<T>> & { error?: string };
  try {
    // The merged signal also aborts a stalled body read, so parsing can't hang.
    json = (await res.json()) as Partial<ApiEnvelope<T>> & { error?: string };
  } catch (cause) {
    if (signal.aborted) throw cause;
    if (timeout.aborted) throw new Error(`${name}: timed out after ${FETCH_TIMEOUT_MS / 1000}s`);
    throw new Error(`${name}: invalid JSON response`);
  }
  if (json.error) throw new Error(`${name}: ${json.error}`);
  if (json.data === undefined) throw new Error(`${name}: malformed response`);
  return json.data;
}

function publish(entry: Entry, next: Snapshot<unknown>): void {
  entry.snapshot = next;
  for (const notify of entry.subscribers) notify();
}

async function load(url: string, entry: Entry): Promise<void> {
  const seq = ++entry.seq;
  // Explicit loads (refetch / visibility return) win outright: anything still in
  // flight is superseded. Scheduled cycles never reach here while one is in
  // flight — the timer skips instead, so the timeout above can actually fire.
  entry.controller?.abort();
  const controller = new AbortController();
  entry.controller = controller;
  try {
    const data = await fetchEnvelope(url, entry.name, controller.signal);
    if (controller.signal.aborted || seq <= entry.applied) return;
    entry.applied = seq;
    entry.settled = true;
    entry.lastLoggedError = null;
    entry.failures = 0;
    entry.backoffUntil = 0;
    publish(entry, { data, error: null, loading: false, lastUpdated: Date.now() });
  } catch (err) {
    if (controller.signal.aborted || seq <= entry.applied) return;
    entry.applied = seq;
    entry.settled = true;
    const message = err instanceof Error ? err.message : String(err);
    if (entry.lastLoggedError !== message) {
      entry.lastLoggedError = message;
      console.warn(`[poll] ${message} (${url})`);
    }
    // Exponential backoff on consecutive failures (2x, 4x, ... capped) so a dead
    // endpoint is probed gently; success resets it, refetch/visibility bypass it.
    entry.failures += 1;
    const base = entry.timerMs ?? 7_000;
    entry.backoffUntil =
      Date.now() + Math.min(base * 2 ** Math.min(entry.failures, 5), MAX_BACKOFF_MS);
    // Retain the previous data — the panel shows a "stale" banner, not a blank.
    publish(entry, {
      data: entry.snapshot.data,
      error: message,
      loading: false,
      lastUpdated: entry.snapshot.lastUpdated,
    });
  } finally {
    if (entry.controller === controller) entry.controller = null;
  }
}

function ensureTimer(url: string, entry: Entry): void {
  const ms = Math.min(...entry.intervals.values());
  if (entry.timer !== null && entry.timerMs === ms) return;
  if (entry.timer !== null) clearInterval(entry.timer);
  entry.timerMs = ms;
  entry.timer = setInterval(() => {
    // Skip cycles while hidden; the visibility listener catches up on return.
    if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
    // A poll is already in flight: let it settle (or time out) instead of
    // superseding it forever — superseding would mask a hung backend.
    if (entry.controller !== null) return;
    // Failure backoff window: skip scheduled cycles until it elapses.
    if (Date.now() < entry.backoffUntil) return;
    void load(url, entry);
  }, ms);
}

let visibilityHooked = false;
function hookVisibility(): void {
  if (visibilityHooked || typeof document === "undefined") return;
  visibilityHooked = true;
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") return;
    for (const [url, entry] of registry) {
      // Immediate catch-up on return, bypassing the backoff window; don't abort
      // a request that is already in flight.
      if (entry.subscribers.size > 0 && entry.controller === null) void load(url, entry);
    }
  });
}

function obtain(url: string, name: string): Entry {
  let entry = registry.get(url);
  if (!entry) {
    entry = {
      name,
      snapshot: INITIAL,
      settled: false,
      subscribers: new Set(),
      intervals: new Map(),
      timer: null,
      timerMs: null,
      seq: 0,
      applied: 0,
      controller: null,
      lastLoggedError: null,
      failures: 0,
      backoffUntil: 0,
    };
    registry.set(url, entry);
  }
  return entry;
}

const getServerSnapshot = (): Snapshot<unknown> => INITIAL;

/**
 * Poll `url` at `intervalMs`, sharing the poll with every other subscriber of
 * the same URL. On error the previously-fetched data is retained (graceful
 * degradation) and the error surfaced alongside it.
 */
export function usePolledResource<T>(
  url: string,
  name: string,
  intervalMs = 7_000,
): PollState<T> {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const entry = obtain(url, name);
      const token = Symbol(name);
      entry.subscribers.add(onChange);
      entry.intervals.set(token, intervalMs);
      ensureTimer(url, entry);
      hookVisibility();
      // Newly created entry (or an idle one with nothing in flight): load now.
      if (!entry.settled && entry.controller === null) void load(url, entry);
      return () => {
        entry.subscribers.delete(onChange);
        entry.intervals.delete(token);
        if (entry.subscribers.size === 0) {
          entry.controller?.abort();
          entry.controller = null;
          if (entry.timer !== null) clearInterval(entry.timer);
          registry.delete(url);
        } else {
          ensureTimer(url, entry);
        }
      };
    },
    [url, name, intervalMs],
  );

  const getSnapshot = useCallback(
    () => (registry.get(url)?.snapshot ?? INITIAL) as Snapshot<T>,
    [url],
  );

  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot as () => Snapshot<T>);

  const refetch = useCallback(() => {
    const entry = registry.get(url);
    if (entry) void load(url, entry);
  }, [url]);

  return { ...snapshot, refetch };
}

/**
 * POST JSON to `url` and unwrap the `{ data }` envelope (shared by command
 * clients). Hardened for the path where it matters most — commands issued while
 * the web tier is degraded: a hard timeout, a non-JSON response (proxy/HTML
 * error page) surfaces as `HTTP <status>` instead of a JSON parse error, and
 * the server's own `{ error }` message wins when present. `opts.authToken` is
 * attached as a Bearer header (the mutating control-plane routes require it).
 */
export async function postCommand<T>(
  url: string,
  body: unknown,
  opts?: { authToken?: string },
): Promise<T> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json",
  };
  const token = opts?.authToken?.trim();
  if (token) headers["authorization"] = `Bearer ${token}`;

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(COMMAND_TIMEOUT_MS),
    });
  } catch (cause) {
    const timedOut = cause instanceof DOMException && cause.name === "TimeoutError";
    throw new Error(
      timedOut
        ? `command timed out after ${COMMAND_TIMEOUT_MS / 1000}s`
        : "command failed: server unreachable",
    );
  }

  let json: (Partial<ApiEnvelope<T>> & { error?: string }) | null = null;
  try {
    json = (await res.json()) as Partial<ApiEnvelope<T>> & { error?: string };
  } catch {
    json = null; // non-JSON body (gateway/HTML error page) — fall through to status
  }
  if (json?.error) throw new Error(json.error);
  if (!res.ok) throw new Error(`command failed: HTTP ${res.status}`);
  if (json?.data === undefined) throw new Error("command failed: malformed response");
  return json.data;
}
