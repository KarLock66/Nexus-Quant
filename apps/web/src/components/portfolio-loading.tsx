/**
 * Phase 10C-2B-1 — Portfolio Terminal loading state. Pure, props-only skeleton shown while
 * the first poll is in flight. No clock, no data — deterministic markup.
 */

export function PortfolioLoading() {
  return (
    <div className="space-y-4" aria-busy="true">
      <div className="glass h-16 animate-pulse rounded-xl bg-(--color-surface-800)/40" />
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="glass space-y-3 p-5">
            <div className="h-4 w-40 animate-pulse rounded bg-(--color-surface-800)" />
            <div className="h-24 animate-pulse rounded-md bg-(--color-surface-800)/60" />
          </div>
        ))}
      </div>
    </div>
  );
}
