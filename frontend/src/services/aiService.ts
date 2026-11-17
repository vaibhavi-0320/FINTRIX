import { api, ApiError, streamEvents, type SseEvent } from "../lib/api";

export interface AssistantHistoryMessage {
  role: "assistant" | "user";
  text: string;
}

export interface AssistantSource {
  index: number;
  slug: string;
  title: string;
  heading: string;
}

export interface AssistantReply {
  answer: string;
  sources: AssistantSource[];
  followups: string[];
}

const KNOWN_VIEWS = new Set(["landing", "wallet", "dashboard", "marketplace", "deal-detail", "simulation", "resources", "funding-success", "repayment"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Server-side conversation backing the floating assistant (kept per page session). */
let conversationId: string | null = null;

export function resetAssistantConversation() {
  conversationId = null;
}

/**
 * Asks the Fintrix assistant (Claude + retrieval over the Fintrix knowledge base).
 * Text streams through `onDelta`. Errors are thrown as-is: there is no canned fallback,
 * but the retrieved sources are attached to the error so the UI can still show them.
 */
export async function askFintrixAssistant(
  input: { question: string; view: string; invoiceId?: string | null; walletAddress?: string | null; history?: AssistantHistoryMessage[] },
  onDelta?: (text: string) => void,
): Promise<AssistantReply> {
  // The server reads the user's data itself; the page only says where the user is.
  const context = {
    ...(KNOWN_VIEWS.has(input.view) ? { view: input.view } : {}),
    ...(input.invoiceId && UUID.test(input.invoiceId) ? { invoiceId: input.invoiceId } : {}),
  };
  if (!conversationId) {
    const created = await api<{ id: string }>("/api/assistant/conversations", { body: { audience: "user" } });
    conversationId = created.id;
  }

  let answer = "";
  let sources: AssistantSource[] = [];
  let followups: string[] = [];
  let failure: { message: string; status: number } | null = null;

  try {
    await streamEvents(`/api/assistant/conversations/${conversationId}/messages`, { content: input.question, context }, (event: SseEvent) => {
      if (event.type === "sources") sources = event.sources as AssistantSource[];
      else if (event.type === "text") {
        answer += String(event.delta);
        onDelta?.(String(event.delta));
      } else if (event.type === "followups") followups = event.items as string[];
      else if (event.type === "error") failure = { message: String(event.message), status: Number(event.status) };
    });
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) conversationId = null; // conversation removed: start a new one next time
    throw error;
  }

  if (failure) {
    const error = new Error((failure as { message: string }).message) as Error & { sources?: AssistantSource[] };
    error.sources = sources;
    throw error;
  }
  return { answer, sources, followups };
}
