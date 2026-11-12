import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { existsSync, readFileSync } from "node:fs";
const assetsFile = new URL("./transport/.build/assets.json", import.meta.url);
const transportAssets = existsSync(assetsFile)
  ? JSON.parse(readFileSync(assetsFile, "utf8"))
  : null;
export default defineConfig({
  base: "./",
  build: { assetsInlineLimit: 0 },
  define: { __TRANSPORT_ASSETS__: JSON.stringify(transportAssets) },
  worker: { format: "es" },
  plugins: [
    {
      name: "require-transport-assets",
      apply: "build",
      buildStart() {
        if (!transportAssets)
          throw new Error(
            "Run npm run build:wasm before building the web app.",
          );
      },
    },
    react(),
    {
      name: "development-csp",
      apply: "serve",
      transformIndexHtml(html) {
        // Vite injects development styles/scripts. Production retains the strict static CSP.
        return html.replace(
          /<meta\s+http-equiv="Content-Security-Policy"[^>]+>/i,
          "",
        );
      },
    },
  ],
  server: { host: "127.0.0.1" },
  test: { include: ["tests/**/*.test.ts"], environment: "node" },
});
