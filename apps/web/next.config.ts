import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  transpilePackages: ["@nexus/core", "@nexus/db"],
  // standalone tracing creates symlinks, which Windows blocks without
  // Developer Mode — so it is opt-in and only enabled in the Docker build
  ...(process.env.NEXT_OUTPUT_STANDALONE === "1" ? { output: "standalone" as const } : {}),
};

export default nextConfig;
