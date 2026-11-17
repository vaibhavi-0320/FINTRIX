import { API_BASE } from "../config";

export class ApiError extends Error {
  status: number;
  details?: Array<{ path: string; message: string }>;
  constructor(status: number, message: string, details?: Array<{ path: string; message: string }>) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.details = details;
  }
}

type Json = Record<string, unknown> | unknown[];

/**
 * Calls the Fintrix API. Sends the session cookie and the CSRF header, unwraps the
 * `{ success, data | error }` envelope and throws ApiError on any failure.
 */
export async function api<T>(path: string, options: { method?: string; body?: Json | FormData; signal?: AbortSignal } = {}): Promise<T> {
  const method = options.method ?? (options.body ? "POST" : "GET");
  const headers: Record<string, string> = { "x-fintrix-csrf": "1" };
  let body: BodyInit | undefined;
  if (options.body instanceof FormData) body = options.body;
  else if (options.body !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(options.body);
  }

  let response: Response;
  try {
    response = await fetch(`${API_BASE}${path}`, { method, headers, body, credentials: "include", signal: options.signal });
  } catch (error) {
    if ((error as Error).name === "AbortError") throw error;
    throw new ApiError(0, "Cannot reach the Fintrix server. Check your connection.");
  }

  const text = await response.text();
  let payload: { success?: boolean; data?: T; error?: string; details?: Array<{ path: string; message: string }> } | null = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    throw new ApiError(response.status, `Unexpected response from the server (HTTP ${response.status}).`);
  }
  if (!response.ok || !payload?.success) {
    throw new ApiError(response.status, payload?.error ?? `Request failed (HTTP ${response.status}).`, payload?.details);
  }
  return payload.data as T;
}

/** Describes an error for display, including field-level validation details. */
export function errorMessage(error: unknown) {
  if (error instanceof ApiError && error.details?.length) {
    return `${error.message} ${error.details.map((detail) => `${detail.path || "request"}: ${detail.message}`).join("; ")}`;
  }
  return error instanceof Error ? error.message : String(error);
}

export interface SseEvent {
  type: string;
  [key: string]: unknown;
}

/** Parses a text/event-stream body incrementally. Exported for tests. */
export function createSseParser(onEvent: (event: SseEvent) => void) {
  let buffer = "";
  return (chunk: string) => {
    buffer += chunk.replace(/\r\n/g, "\n");
    let index: number;
    while ((index = buffer.indexOf("\n\n")) >= 0) {
      const block = buffer.slice(0, index);
      buffer = buffer.slice(index + 2);
      const data = block
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");
      if (!data) continue;
      try {
        onEvent(JSON.parse(data));
      } catch {
        // ignore malformed event
      }
    }
  };
}

/** POSTs JSON and streams server-sent events back to `onEvent`. */
export async function streamEvents(path: string, body: Json, onEvent: (event: SseEvent) => void, signal?: AbortSignal) {
  const response = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-fintrix-csrf": "1", Accept: "text/event-stream" },
    body: JSON.stringify(body),
    credentials: "include",
    signal,
  });
  if (!response.ok || !response.body) {
    let message = `Request failed (HTTP ${response.status}).`;
    try {
      message = (await response.json()).error ?? message;
    } catch {
      // keep default
    }
    throw new ApiError(response.status, message);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const parse = createSseParser(onEvent);
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parse(decoder.decode(value, { stream: true }));
  }
  parse("\n\n");
}
