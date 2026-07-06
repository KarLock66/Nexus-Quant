"use client";

import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";

/**
 * Operator login — exchange an operator token for a session cookie (B1). This is
 * the only page reachable while unauthenticated; the middleware redirects here
 * with a `?next=` return path. On success the httpOnly session cookie is set by
 * the server and every gated read/page/command authenticates via that cookie.
 */
function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const [token, setToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function safeNext(): string {
    const next = params.get("next");
    // Only same-site absolute paths; reject protocol-relative (`//host`) to avoid
    // an open redirect.
    return next && next.startsWith("/") && !next.startsWith("//") ? next : "/";
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/v1/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token }),
      });
      const json = (await res.json().catch(() => null)) as { error?: string } | null;
      if (!res.ok) {
        setError(json?.error ?? `login failed (HTTP ${res.status})`);
        return;
      }
      router.replace(safeNext());
      router.refresh();
    } catch {
      setError("login failed: server unreachable");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="w-full max-w-sm space-y-4">
      <div className="space-y-1">
        <h1 className="text-lg font-semibold text-white">Operator sign-in</h1>
        <p className="text-xs leading-relaxed text-slate-500">
          Enter your operator token to open the console. The token is exchanged for a
          per-session cookie; it is never stored in the browser.
        </p>
      </div>

      <div>
        <label
          htmlFor="operator-token"
          className="mb-1 block font-mono text-[10px] uppercase tracking-wider text-slate-500"
        >
          operator token
        </label>
        <input
          id="operator-token"
          type="password"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder="operator token"
          autoComplete="off"
          autoFocus
          className="w-full rounded-md border border-(--color-line) bg-(--color-surface-900) px-3 py-2 text-[13px] text-slate-200 outline-none focus:border-(--color-accent-500)/50"
        />
      </div>

      {error && (
        <p role="alert" className="font-mono text-[11px] text-(--color-negative)">
          {error}
        </p>
      )}

      <button
        type="submit"
        disabled={busy || token.trim() === ""}
        className="w-full rounded-md border border-(--color-accent-500)/40 bg-(--color-accent-500)/10 px-3 py-2 text-sm font-medium text-(--color-accent-500) transition disabled:cursor-not-allowed disabled:opacity-40"
      >
        {busy ? "signing in…" : "sign in"}
      </button>
    </form>
  );
}

export default function LoginPage() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-(--color-surface-950) p-6">
      <Suspense>
        <LoginForm />
      </Suspense>
    </main>
  );
}
