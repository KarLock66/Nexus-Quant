import { MobileNav, Sidebar } from "@/components/sidebar";
import { HeaderStatus } from "@/components/header-status";

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div>
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded-md focus:bg-(--color-surface-800) focus:px-3 focus:py-2 focus:text-sm focus:text-white"
      >
        Skip to content
      </a>
      <Sidebar />
      <div className="lg:pl-60">
        <header className="sticky top-0 z-10 flex h-14 items-center justify-between gap-3 border-b border-(--color-line) bg-(--color-surface-950)/80 px-4 backdrop-blur-xl sm:px-6">
          <div className="flex items-center gap-3">
            <MobileNav />
            <div className="hidden font-mono text-[11px] uppercase tracking-widest text-slate-500 sm:block">
              BTC · ETH — spot / perp / options
            </div>
          </div>
          <HeaderStatus />
        </header>
        <main id="main" className="mx-auto max-w-7xl p-4 sm:p-6">{children}</main>
      </div>
    </div>
  );
}
