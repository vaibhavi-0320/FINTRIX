/**
 * Local entry point: serves the API and the React app from one origin.
 *   npm run dev    -> Vite middleware with HMR
 *   npm run serve  -> NODE_ENV=production, serves the built frontend/dist
 */
import express from "express";
import http from "http";
import path from "path";
import { createApp } from "./app";
import { getConfig } from "./config";
import { ensureKnowledge } from "./modules/assistant/knowledge";
import { logger } from "./logger";

async function main() {
  const config = getConfig();
  const app = createApp();
  const server = http.createServer(app);
  const frontendRoot = path.resolve(process.cwd(), "frontend");

  if (config.NODE_ENV === "production") {
    const dist = path.join(frontendRoot, "dist");
    app.use(express.static(dist, { index: false, maxAge: "1h" }));
    app.get(/^(?!\/api\/).*/, (_req, res) => res.sendFile(path.join(dist, "index.html")));
  } else {
    const { createServer } = await import("vite");
    const vite = await createServer({
      root: frontendRoot,
      configFile: path.join(frontendRoot, "vite.config.ts"),
      server: { middlewareMode: true, hmr: { server } },
      appType: "spa",
    });
    app.use(vite.middlewares);
  }

  server.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code === "EADDRINUSE") {
      logger.fatal(`Port ${config.PORT} is already in use. Stop the other process or set PORT in .env.`);
    } else {
      logger.fatal({ err: error.message }, "server failed to start");
    }
    process.exit(1);
  });

  server.listen(config.PORT, "127.0.0.1", () => {
    logger.info(
      {
        url: `http://127.0.0.1:${config.PORT}`,
        mode: config.NODE_ENV,
        network: config.stellar.network,
        ai: Boolean(config.ANTHROPIC_API_KEY),
        contract: config.FINTRIX_CONTRACT_ID ?? "not configured",
      },
      "Fintrix running",
    );
    // Warm the knowledge base (migrations + ingestion + embedding model) without blocking startup.
    ensureKnowledge().catch((error) => logger.error({ err: error instanceof Error ? error.message : String(error) }, "knowledge ingestion failed"));
  });
}

main().catch((error) => {
  logger.fatal({ err: error instanceof Error ? error.message : String(error) }, "startup failed");
  process.exit(1);
});
