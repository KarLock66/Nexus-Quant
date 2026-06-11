"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import clsx from "clsx";
import {
  Activity,
  BarChart3,
  FlaskConical,
  Gauge,
  LayoutDashboard,
  Radio,
  ShieldAlert,
  Workflow,
} from "lucide-react";

const NAV = [
  { href: "/", label: "Dashboard", icon: LayoutDashboard },
  { href: "/signals", label: "Signal Center", icon: Radio },
  { href: "/research", label: "Research Lab", icon: FlaskConical },
  { href: "/backtesting", label: "Backtesting Studio", icon: Gauge },
  { href: "/risk", label: "Risk Engine", icon: ShieldAlert },
  { href: "/portfolio", label: "Portfolio Analytics", icon: BarChart3 },
  { href: "/governance", label: "Strategy Governance", icon: Workflow },
  { href: "/system", label: "System Monitoring", icon: Activity },
] as const;

export function Sidebar() {
  const pathname = usePathname();

  return (
    <aside className="fixed inset-y-0 left-0 z-20 flex w-60 flex-col border-r border-(--color-line) bg-(--color-surface-900)/80 backdrop-blur-xl">
      <div className="flex h-14 items-center gap-2 border-b border-(--color-line) px-4">
        <span className="inline-block h-2.5 w-2.5 rounded-full bg-(--color-accent-500) shadow-[0_0_12px_var(--color-accent-500)]" />
        <div>
          <div className="text-sm font-semibold tracking-wide text-white">
            NEXUS QUANT
          </div>
          <div className="text-[10px] uppercase tracking-widest text-slate-500">
            Risk-first intelligence
          </div>
        </div>
      </div>

      <nav className="flex-1 space-y-0.5 overflow-y-auto p-2">
        {NAV.map(({ href, label, icon: Icon }) => {
          const active =
            href === "/" ? pathname === "/" : pathname.startsWith(href);
          return (
            <Link
              key={href}
              href={href}
              className={clsx(
                "flex items-center gap-2.5 rounded-md px-3 py-2 text-[13px] transition-colors",
                active
                  ? "bg-(--color-surface-700) text-white"
                  : "text-slate-400 hover:bg-(--color-surface-800) hover:text-slate-200",
              )}
            >
              <Icon size={15} strokeWidth={1.8} />
              {label}
            </Link>
          );
        })}
      </nav>

      <div className="border-t border-(--color-line) p-3 text-[10px] leading-relaxed text-slate-600">
        Human is the final decision maker.
        <br />
        No live trading. Ever.
      </div>
    </aside>
  );
}
