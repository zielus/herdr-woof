import { resolve } from "node:path";

import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/**
 * The Web UI is a plain SPA built into `dist-ui/` next to the CLI's `dist/`, so
 * `rm -rf dist` in the root build never deletes it. Its dependencies live in the
 * root package.json (one lockfile), so this directory has no package.json of its
 * own and Vite's root is this directory.
 *
 * In development `bun run dev:ui` proxies `/api` to the `woof ui` server, which
 * must run in another terminal. `allowedHosts` is an explicit list: Vite's own
 * CVE-2025-24010 showed a dev server reachable through a victim's browser when
 * the Host header is unvalidated, so this is never `true`.
 */
export default defineConfig({
  // Explicit: Vite's root defaults to the working directory, and the root
  // package scripts run it from the repository root with --config.
  root: import.meta.dirname,
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": resolve(import.meta.dirname, "src") } },
  server: {
    host: "127.0.0.1",
    allowedHosts: ["localhost", ".localhost"],
    // The brand mark is imported from assets/ rather than copied, so the dev
    // server has to be allowed to read the repository root.
    fs: { allow: [resolve(import.meta.dirname, "..")] },
    proxy: {
      "/api": {
        target: "http://127.0.0.1:4317",
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: resolve(import.meta.dirname, "..", "dist-ui"),
    emptyOutDir: true,
  },
});
