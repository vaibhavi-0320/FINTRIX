/**
 * Vercel serverless entry point, bundled by scripts/build-vercel.mts into the
 * /api function. It deliberately lives outside an `api/` folder: Vercel would
 * otherwise auto-compile it and overwrite the prebuilt bundle.
 */
import { createApp } from "./app";

export default createApp();
