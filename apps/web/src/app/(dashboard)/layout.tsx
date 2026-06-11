import { Sidebar } from "@/components/sidebar";

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div>
      <Sidebar />
      <div className="pl-60">
        <header className="sticky top-0 z-10 flex h-14 items-center justify-between border-b border-(--color-line) bg-(--color-surface-950)/80 px-6 backdrop-blur-xl">
          <div className="font-mono text-[11px] uppercase tracking-widest text-slate-500">
            BTC · ETH — spot / perp / options
          </div>
          <div className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-widest">
            <span className="inline-block h-1.5 w-1.5 rounded-full bg-(--color-positive)" />
            <span className="text-slate-400">risk mode: NORMAL</span>
          </div>
        </header>
        <main className="mx-auto max-w-7xl p-6">{children}</main>
      </div>
    </div>
  );
}
