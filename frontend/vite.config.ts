import react from "@vitejs/plugin-react";
import path from "path";
import { fileURLToPath } from "url";
import { defineConfig } from "vite";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// In development the app is served by backend/dev-server.ts (Vite in middleware
// mode), so the API and the UI share one origin and no proxy is needed.
export default defineConfig({
  plugins: [react()],
  // Single .env at the repository root. Only VITE_* variables reach the browser.
  envDir: repoRoot,
  build: {
    outDir: "dist",
    // Source maps are generated for error reporting but not referenced from the bundle.
    sourcemap: "hidden",
    rollupOptions: {
      output: {
        manualChunks(id: string) {
          const path = id.replace(/\\/g, "/");
          if (/node_modules\/(react|react-dom|react-router|scheduler)\//.test(path)) return "react";
          if (path.includes("node_modules/@stellar/")) return "stellar";
          if (/node_modules\/(react-markdown|remark-|micromark|mdast-|unified|hast-|vfile)/.test(path)) return "markdown";
          return undefined;
        },
      },
    },
  },
});
