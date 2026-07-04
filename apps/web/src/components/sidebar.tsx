"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import clsx from "clsx";
import {
  Activity,
  BarChart3,
  FlaskConical,
  Gauge,
  LayoutDashboard,
  Menu,
  Radio,
  ServerCog,
  ShieldAlert,
  ShieldCheck,
  Workflow,
  X,
} from "lucide-react";

const NAV = [
  { href: "/", label: "Dashboard", icon: LayoutDashboard },
  { href: "/signals", label: "Trading Terminal", icon: Radio },
  { href: "/research", label: "Research Lab", icon: FlaskConical },
  { href: "/backtesting", label: "Backtesting Studio", icon: Gauge },
  { href: "/risk", label: "Risk Engine", icon: ShieldAlert },
  { href: "/portfolio", label: "Portfolio Terminal", icon: BarChart3 },
  { href: "/governance", label: "Strategy Governance", icon: Workflow },
  { href: "/system", label: "System Monitoring", icon: Activity },
  { href: "/ops", label: "Operations", icon: ServerCog },
  { href: "/control", label: "Control Center", icon: ShieldCheck },
] as const;

function Brand() {
  return (
    <div className="flex h-14 items-center gap-2 px-4">
      <span className="inline-block h-2.5 w-2.5 rounded-full bg-(--color-accent-500) shadow-[0_0_12px_var(--color-accent-500)]" />
      <div>
        <div className="text-sm font-semibold tracking-wide text-white">NEXUS QUANT</div>
        <div className="text-[10px] uppercase tracking-widest text-slate-500">
          Risk-first intelligence
        </div>
      </div>
    </div>
  );
}

function NavLinks({ pathname }: { pathname: string }) {
  return (
    <nav aria-label="Primary" className="flex-1 space-y-0.5 overflow-y-auto p-2">
      {NAV.map(({ href, label, icon: Icon }) => {
        const active = href === "/" ? pathname === "/" : pathname.startsWith(href);
        return (
          <Link
            key={href}
            href={href}
            aria-current={active ? "page" : undefined}
            className={clsx(
              "flex items-center gap-2.5 rounded-md px-3 py-2 text-[13px] transition-colors",
              active
                ? "bg-(--color-surface-700) text-white"
                : "text-slate-400 hover:bg-(--color-surface-800) hover:text-slate-200",
            )}
          >
            <Icon size={15} strokeWidth={1.8} aria-hidden="true" />
            {label}
          </Link>
        );
      })}
    </nav>
  );
}

function Disclaimer() {
  return (
    <div className="border-t border-(--color-line) p-3 text-[10px] leading-relaxed text-slate-600">
      Human is the final decision maker.
      <br />
      No live trading. Ever.
    </div>
  );
}

/** Fixed desktop sidebar — hidden below `lg`, where MobileNav takes over. */
export function Sidebar() {
  const pathname = usePathname();

  return (
    <aside className="fixed inset-y-0 left-0 z-20 hidden w-60 flex-col border-r border-(--color-line) bg-(--color-surface-900)/80 backdrop-blur-xl lg:flex">
      <div className="border-b border-(--color-line)">
        <Brand />
      </div>
      <NavLinks pathname={pathname} />
      <Disclaimer />
    </aside>
  );
}

/**
 * Mobile navigation — a hamburger button (shown below `lg`) opening a slide-over
 * drawer with the same primary nav. Closes on route change, Escape, and backdrop
 * click; focus moves into the drawer on open and returns to the trigger on close.
 */
export function MobileNav() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const closeRef = useRef<HTMLButtonElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);

  // Close when navigation happens.
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (!open) return;
    closeRef.current?.focus();
    // The drawer is aria-modal: lock background scroll while it is open.
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
        return;
      }
      // Focus trap: aria-modal promises focus stays inside the overlay, so Tab
      // and Shift+Tab wrap within it instead of escaping to obscured content.
      if (e.key === "Tab") {
        const root = overlayRef.current;
        if (!root) return;
        const focusables = root.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), input, select, textarea, [tabindex]:not([tabindex="-1"])',
        );
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        if (!first || !last) return;
        const active = document.activeElement;
        if (e.shiftKey) {
          if (active === first || !root.contains(active)) {
            e.preventDefault();
            last.focus();
          }
        } else if (active === last || !root.contains(active)) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [open]);

  return (
    <div className="lg:hidden">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Open navigation"
        aria-expanded={open}
        className="flex h-9 w-9 items-center justify-center rounded-md border border-(--color-line) text-slate-400 transition-colors hover:text-slate-200"
      >
        <Menu size={16} aria-hidden="true" />
      </button>

      {open && (
        <div ref={overlayRef} className="fixed inset-0 z-40">
          <button
            type="button"
            aria-label="Close navigation"
            onClick={() => setOpen(false)}
            className="absolute inset-0 bg-black/60 backdrop-blur-sm"
          />
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Navigation"
            className="absolute inset-y-0 left-0 flex w-64 flex-col border-r border-(--color-line) bg-(--color-surface-900)"
          >
            <div className="flex items-center justify-between border-b border-(--color-line) pr-2">
              <Brand />
              <button
                ref={closeRef}
                type="button"
                onClick={() => {
                  setOpen(false);
                  triggerRef.current?.focus();
                }}
                aria-label="Close navigation"
                className="flex h-9 w-9 items-center justify-center rounded-md text-slate-400 transition-colors hover:text-slate-200"
              >
                <X size={16} aria-hidden="true" />
              </button>
            </div>
            <NavLinks pathname={pathname} />
            <Disclaimer />
          </div>
        </div>
      )}
    </div>
  );
}
