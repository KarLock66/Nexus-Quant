import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "Nexus Quant",
    template: "%s · Nexus Quant",
  },
  description:
    "AI-Powered Quant Research, Signal Intelligence & Risk Governance Platform",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="dark">
      {/* suppressHydrationWarning: browser extensions (password managers, Grammarly,
          dark-mode injectors) mutate <body> attributes before React hydrates. The
          suppression is one level deep (attributes of <body> only) and nothing
          in-repo renders time/locale/random-dependent markup during SSR. */}
      <body className="min-h-screen antialiased" suppressHydrationWarning>{children}</body>
    </html>
  );
}
