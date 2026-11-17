import cors from "cors";
import helmet from "helmet";
import pinoHttp from "pino-http";
import type { Express } from "express";
import { getConfig } from "./config";
import { logger } from "./logger";

/**
 * Baseline HTTP hardening: proxy trust, request logging without bodies, security
 * headers and a strict CORS allow-list. Authentication lives in http/middleware.ts.
 */
export function configureSecurity(app: Express) {
  const config = getConfig();

  app.disable("x-powered-by");
  // Only trust X-Forwarded-For when a proxy is actually in front (Vercel: 1 hop). Otherwise a
  // client could spoof its IP and evade per-IP rate limits.
  app.set("trust proxy", config.TRUST_PROXY_HOPS);

  app.use(
    pinoHttp({
      logger,
      // Never log bodies (they can contain signed XDR or document data).
      serializers: {
        req: (req) => ({ method: req.method, url: req.url }),
        res: (res) => ({ statusCode: res.statusCode }),
      },
      autoLogging: { ignore: (req) => !req.url?.startsWith("/api") },
    }),
  );

  // The SPA's CSP lives in index.html / vercel.json; the API only serves JSON.
  app.use(
    helmet({
      contentSecurityPolicy: false,
      crossOriginEmbedderPolicy: false,
      // Freighter/Albedo use popups; same-origin-allow-popups keeps them working.
      crossOriginOpenerPolicy: { policy: "same-origin-allow-popups" },
    }),
  );

  app.use((_req, res, next) => {
    res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=()");
    next();
  });

  // Same-origin requests (the normal case) send no Origin header for GET and are always allowed.
  // Cross-origin callers must be listed explicitly in APP_ORIGIN — no wildcard domains.
  app.use(
    "/api",
    cors({
      origin(origin, callback) {
        if (!origin || config.allowedOrigins.includes(origin)) return callback(null, true);
        return callback(null, false);
      },
      credentials: true,
      methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
      allowedHeaders: ["Content-Type"],
    }),
  );
}
