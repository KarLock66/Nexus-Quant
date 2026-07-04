import type { NextConfig } from "next";

/**
 * Baseline security headers on every response. `frame-ancestors 'none'` +
 * X-Frame-Options cover clickjacking; a full script-src CSP is not set because
 * Next.js inline bootstrap scripts require nonce plumbing (middleware) — the
 * app loads no third-party scripts, so the exposure is limited to what a
 * script-src policy would add. HSTS is a no-op over plain HTTP and applies
 * when served behind TLS.
 */
const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
  { key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" },
];

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  transpilePackages: ["@nexus/core", "@nexus/db"],
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
  // standalone tracing creates symlinks, which Windows blocks without
  // Developer Mode — so it is opt-in and only enabled in the Docker build
  ...(process.env.NEXT_OUTPUT_STANDALONE === "1" ? { output: "standalone" as const } : {}),
  // Optional out-of-place build dir so `next build` can run for verification
  // while `next dev` holds .next (Windows file locks).
  ...(process.env.NEXT_DIST_DIR ? { distDir: process.env.NEXT_DIST_DIR } : {}),
};

export default nextConfig;
