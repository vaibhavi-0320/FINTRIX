import type { NextFunction, Request, Response } from "express";
import type { Store, Options, ClientRateLimitInfo } from "express-rate-limit";
import { getConfig } from "../config";
import { getDb } from "../db";
import { HttpError } from "../errors";
import { getSessionUser, SESSION_COOKIE, type SessionUser } from "../modules/auth/service";

declare module "express-serve-static-core" {
  interface Request {
    user?: SessionUser | null;
  }
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (key) {
      try {
        out[key] = decodeURIComponent(value);
      } catch {
        out[key] = value;
      }
    }
  }
  return out;
}

function isSecureRequest(req: Request) {
  return getConfig().NODE_ENV === "production" || req.secure;
}

export function setSessionCookie(req: Request, res: Response, token: string, expiresAt: Date) {
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: isSecureRequest(req),
    sameSite: "lax",
    path: "/",
    expires: expiresAt,
  });
}

export function clearSessionCookie(req: Request, res: Response) {
  res.clearCookie(SESSION_COOKIE, { httpOnly: true, secure: isSecureRequest(req), sameSite: "lax", path: "/" });
}

/** Resolves the signed-in user (if any) from the session cookie. */
export async function attachUser(req: Request, _res: Response, next: NextFunction) {
  try {
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    req.user = token ? await getSessionUser(token) : null;
    next();
  } catch (error) {
    next(error);
  }
}

export function requireUser(req: Request, _res: Response, next: NextFunction) {
  if (!req.user) return next(new HttpError(401, "Sign in with your Stellar wallet to continue."));
  next();
}

export function currentUser(req: Request): SessionUser {
  if (!req.user) throw new HttpError(401, "Sign in with your Stellar wallet to continue.");
  return req.user;
}

/**
 * CSRF defence for cookie-authenticated, state-changing requests:
 *  1. a custom header that HTML forms cannot send and cross-origin JS cannot add
 *     without passing the CORS preflight (which only allows APP_ORIGIN), and
 *  2. if the browser sends an Origin header, it must be this host or an allowed origin.
 */
export function csrfGuard(req: Request, _res: Response, next: NextFunction) {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
  if (req.get("x-fintrix-csrf") !== "1") {
    return next(new HttpError(403, "Missing CSRF header."));
  }
  const origin = req.get("origin");
  if (origin) {
    const host = (getConfig().TRUST_PROXY_HOPS > 0 && req.get("x-forwarded-host")) || req.get("host");
    let originHost = "";
    try {
      originHost = new URL(origin).host;
    } catch {
      return next(new HttpError(403, "Invalid Origin header."));
    }
    if (originHost !== host && !getConfig().allowedOrigins.includes(origin)) {
      return next(new HttpError(403, "Cross-site request rejected."));
    }
  }
  next();
}

/**
 * express-rate-limit store persisted in Postgres so limits hold across
 * serverless instances (the default memory store resets per instance).
 */
export class PostgresRateLimitStore implements Store {
  windowMs = 60_000;
  prefix: string;
  constructor(prefix: string) {
    this.prefix = prefix;
  }
  init(options: Options) {
    this.windowMs = options.windowMs;
  }
  async increment(key: string): Promise<ClientRateLimitInfo> {
    const db = await getDb();
    const resetAt = new Date(Date.now() + this.windowMs);
    const { rows } = await db.query<{ hits: number; reset_at: Date }>(
      `INSERT INTO rate_limits (key, hits, reset_at) VALUES ($1, 1, $2)
       ON CONFLICT (key) DO UPDATE SET
         hits = CASE WHEN rate_limits.reset_at <= now() THEN 1 ELSE rate_limits.hits + 1 END,
         reset_at = CASE WHEN rate_limits.reset_at <= now() THEN EXCLUDED.reset_at ELSE rate_limits.reset_at END
       RETURNING hits, reset_at`,
      [`${this.prefix}:${key}`, resetAt],
    );
    return { totalHits: Number(rows[0].hits), resetTime: new Date(rows[0].reset_at) };
  }
  async decrement(key: string) {
    const db = await getDb();
    await db.query(`UPDATE rate_limits SET hits = GREATEST(hits - 1, 0) WHERE key = $1`, [`${this.prefix}:${key}`]);
  }
  async resetKey(key: string) {
    const db = await getDb();
    await db.query(`DELETE FROM rate_limits WHERE key = $1`, [`${this.prefix}:${key}`]);
  }
}
