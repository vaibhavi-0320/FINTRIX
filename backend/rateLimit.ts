import rateLimit, { ipKeyGenerator, type Options } from "express-rate-limit";
import type { Request } from "express";
import { getConfig } from "./config";
import { PostgresRateLimitStore } from "./http/middleware";

const json = (message: string) => ({ success: false, error: message });

/** Signed-in users are limited per account; anonymous callers per IP. */
function keyFor(req: Request) {
  return req.user?.id ? `u:${req.user.id}` : `ip:${ipKeyGenerator(req.ip ?? "unknown")}`;
}

function limiter(name: string, windowMs: number, limit: number, message: string) {
  const options: Partial<Options> = {
    windowMs,
    limit,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    keyGenerator: keyFor,
    message: json(message),
    // Rate limits are disabled in the automated test suite unless a test opts in.
    skip: () => getConfig().NODE_ENV === "test" && process.env.FINTRIX_TEST_RATE_LIMITS !== "1",
    store: new PostgresRateLimitStore(name),
  };
  return rateLimit(options);
}

export const generalLimiter = limiter("api", 60_000, 300, "Rate limit exceeded. Please slow down.");
export const authLimiter = limiter("auth", 60_000, 10, "Too many sign-in attempts. Please wait a minute.");
export const chainLimiter = limiter("chain", 60_000, 20, "Too many transaction requests. Please wait a minute.");
export const aiLimiter = limiter("ai", 60_000, 12, "Too many AI requests. Please wait a minute.");
export const uploadLimiter = limiter("upload", 10 * 60_000, 20, "Too many uploads. Please wait a few minutes.");
