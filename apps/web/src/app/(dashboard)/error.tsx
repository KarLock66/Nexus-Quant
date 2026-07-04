"use client";

import { useEffect } from "react";

/**
 * Route-segment error boundary for every dashboard page. A rendering/runtime
 * failure inside a page degrades to this recoverable state (the shell and
 * navigation stay usable) instead of a blank screen. The error is logged for
 * observability; the digest identifies the server-side occurrence.
 */
export default function DashboardError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("dashboard page error:", error);
  }, [error]);

  return (
    <div className="glass mx-auto mt-10 max-w-lg space-y-4 p-6" role="alert">
      <div>
        <h1 className="text-base font-semibold text-slate-100">Something went wrong</h1>
        <p className="mt-1 text-sm leading-relaxed text-slate-400">
          This page failed to render. The rest of the platform is unaffected — you can retry
          this view or navigate elsewhere via the sidebar.
        </p>
      </div>
      <div className="rounded-md border border-(--color-negative)/30 bg-(--color-negative)/5 px-3 py-2 font-mono text-[11px] text-(--color-negative)">
        {error.message || "unknown error"}
        {error.digest ? ` · digest ${error.digest}` : ""}
      </div>
      <button
        type="button"
        onClick={reset}
        className="rounded-md border border-(--color-accent-500)/40 bg-(--color-accent-500)/10 px-4 py-2 text-[13px] font-semibold text-(--color-accent-500) transition-colors hover:bg-(--color-accent-500)/20"
      >
        Try again
      </button>
    </div>
  );
}
