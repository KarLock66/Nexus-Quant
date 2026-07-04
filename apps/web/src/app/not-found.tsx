import Link from "next/link";

export const metadata = { title: "Not found" };

/** Styled 404 for unknown routes — no dead ends, always a way back. */
export default function NotFound() {
  return (
    <div className="flex min-h-screen items-center justify-center p-6">
      <div className="glass max-w-md space-y-4 p-8 text-center">
        <div className="font-mono text-4xl font-bold text-(--color-accent-500)">404</div>
        <div>
          <h1 className="text-base font-semibold text-slate-100">Page not found</h1>
          <p className="mt-1 text-sm leading-relaxed text-slate-400">
            The page you requested does not exist on this platform.
          </p>
        </div>
        <Link
          href="/"
          className="inline-block rounded-md border border-(--color-accent-500)/40 bg-(--color-accent-500)/10 px-4 py-2 text-[13px] font-semibold text-(--color-accent-500) transition-colors hover:bg-(--color-accent-500)/20"
        >
          Back to Dashboard
        </Link>
      </div>
    </div>
  );
}
