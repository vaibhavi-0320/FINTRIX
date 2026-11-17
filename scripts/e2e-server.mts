/**
 * Starts Fintrix for Playwright: a fresh embedded database and the E2E test-signer
 * bridge enabled. Never use this for anything but automated tests.
 */
import fs from "fs";
import path from "path";

const dir = path.resolve(process.cwd(), ".data", "e2e-pglite");
fs.rmSync(dir, { recursive: true, force: true });
process.env.PGLITE_DIR = ".data/e2e-pglite";
process.env.PORT = process.env.E2E_PORT ?? "3100";
process.env.VITE_E2E_WALLET = "true";
// Deterministic and free: E2E never calls paid AI APIs (empty stops dotenv reading .env's key).
process.env.ANTHROPIC_API_KEY = "";
process.env.VOYAGE_API_KEY = "";
process.env.APP_ORIGIN = `http://127.0.0.1:${process.env.PORT}`;

await import("../backend/dev-server.ts");
