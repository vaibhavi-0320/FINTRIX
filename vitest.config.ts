import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "backend",
          environment: "node",
          include: ["tests/backend/**/*.test.ts"],
          setupFiles: ["tests/backend/setup.ts"],
          testTimeout: 30_000,
          hookTimeout: 60_000,
          // Each file gets its own in-memory database; files run in separate workers.
          pool: "forks",
        },
      },
      {
        plugins: [react()],
        test: {
          name: "frontend",
          environment: "jsdom",
          include: ["frontend/src/**/*.test.{ts,tsx}"],
          setupFiles: ["frontend/src/test/setup.ts"],
          css: false,
        },
      },
    ],
  },
});
