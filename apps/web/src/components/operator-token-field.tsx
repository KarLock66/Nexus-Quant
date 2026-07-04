"use client";

import { useEffect, useId, useState } from "react";
import { getOperatorToken, setOperatorToken } from "@/lib/operator-token";

/**
 * Operator-token input shared by every command surface (kill switch, operator
 * actions). Commands are refused by the server without a valid token
 * (OPS_CONTROL_TOKEN), so this field is the operator's way to authorize them.
 * The value is loaded from sessionStorage AFTER mount (never during render) so
 * the server HTML and the hydration render stay byte-identical.
 */
export function OperatorTokenField() {
  const id = useId();
  const [token, setToken] = useState("");

  useEffect(() => {
    setToken(getOperatorToken());
  }, []);

  return (
    <div>
      <label
        htmlFor={id}
        className="mb-1 block font-mono text-[10px] uppercase tracking-wider text-slate-500"
      >
        operator token <span className="text-(--color-negative)">*</span>
      </label>
      <input
        id={id}
        type="password"
        value={token}
        onChange={(e) => {
          setToken(e.target.value);
          setOperatorToken(e.target.value);
        }}
        placeholder="OPS_CONTROL_TOKEN"
        autoComplete="off"
        aria-required="true"
        className="w-full rounded-md border border-(--color-line) bg-(--color-surface-900) px-3 py-2 text-[13px] text-slate-200 outline-none focus:border-(--color-accent-500)/50"
      />
      <p className="mt-1 text-[10px] leading-relaxed text-slate-600">
        Sent as a Bearer header with each command; kept per-tab, never persisted to disk.
      </p>
    </div>
  );
}
