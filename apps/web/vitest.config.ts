import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

/**
 * Phase 9.6 — vitest for the web app (Section I). Node environment (the ops
 * logic under test is server-side and pure). The `@` alias mirrors tsconfig so
 * route modules that import `@/lib/*` resolve under test.
 */
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
  },
  // Use React's automatic JSX runtime (matches the app's tsconfig `react-jsx`) so the
  // presentational panels can be rendered to static markup in tests without importing
  // React in every component (Phase 10A-2 UI render tests via react-dom/server).
  esbuild: { jsx: "automatic" },
  resolve: {
    alias: { "@": resolve(__dirname, "src") },
  },
});
