import type { NextFunction, Request, Response } from "express";
import { ZodError } from "zod";
import { logger } from "./logger";

export class HttpError extends Error {
  statusCode: number;
  /** Whether `message` is safe to show to the client. 5xx messages are hidden by default. */
  expose: boolean;

  constructor(statusCode: number, message: string, options?: { expose?: boolean }) {
    super(message);
    this.name = "HttpError";
    this.statusCode = statusCode;
    this.expose = options?.expose ?? (statusCode < 500 || statusCode === 502 || statusCode === 503);
  }
}

export function statusForError(error: unknown) {
  if (error instanceof HttpError) return error.statusCode;
  if (error instanceof ZodError) return 400;
  if (typeof error === "object" && error && "type" in error && (error as { type?: string }).type === "entity.too.large") return 413;
  if (typeof error === "object" && error && "type" in error && (error as { type?: string }).type === "entity.parse.failed") return 400;
  return 500;
}

export function errorBody(error: unknown) {
  if (error instanceof HttpError && error.expose) return { success: false, error: error.message };
  if (error instanceof ZodError) {
    return {
      success: false,
      error: "Invalid request.",
      details: error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
    };
  }
  const status = statusForError(error);
  if (status === 413) return { success: false, error: "Request body is too large." };
  if (status === 400) return { success: false, error: "Malformed JSON body." };
  return { success: false, error: "Unexpected server error." };
}

export function errorHandler(error: unknown, req: Request, res: Response, _next: NextFunction) {
  const status = statusForError(error);
  if (status >= 500) {
    logger.error({ err: error instanceof Error ? { message: error.message, stack: error.stack } : error, path: req.path }, "request failed");
  } else {
    logger.warn({ status, msg: error instanceof Error ? error.message : String(error), path: req.path }, "request rejected");
  }
  res.status(status).json(errorBody(error));
}

/** 404 for unknown /api routes, so they never fall through to the SPA's index.html. */
export function apiNotFound(req: Request, res: Response) {
  res.status(404).json({ success: false, error: `No API route for ${req.method} ${req.originalUrl.split("?")[0]}` });
}
