/**
 * Vercel serverless entry point. vercel.json rewrites every /api/* request here,
 * and the shared Express app (backend/app.ts) handles routing.
 */
import { createApp } from "../backend/app";

export default createApp();
