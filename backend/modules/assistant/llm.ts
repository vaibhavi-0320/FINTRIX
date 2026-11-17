import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { ZodType } from "zod";
import { getConfig } from "../../config";
import { HttpError } from "../../errors";
import { logger } from "../../logger";

/**
 * Provider-agnostic LLM interface. The assistant and document extraction depend only
 * on this, so another provider can be added without touching them.
 */
export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}

export type ChatEvent =
  | { type: "text"; text: string }
  | { type: "done"; model: string; inputTokens: number | null; outputTokens: number | null; stopReason: string | null };

export interface LlmProvider {
  readonly name: string;
  readonly model: string;
  streamChat(input: { system: string; messages: ChatTurn[]; maxTokens?: number; signal?: AbortSignal }): AsyncIterable<ChatEvent>;
  extractStructured<T>(input: { schema: ZodType<T>; prompt: string; file?: { mime: string; base64: string } }): Promise<T>;
}

function mapProviderError(error: unknown): never {
  if (error instanceof HttpError) throw error;
  if (error instanceof Anthropic.RateLimitError) throw new HttpError(429, "The AI service is rate limited. Please retry shortly.");
  if (error instanceof Anthropic.AuthenticationError || error instanceof Anthropic.PermissionDeniedError) {
    throw new HttpError(503, "The AI service rejected the server's API key.");
  }
  if (error instanceof Anthropic.BadRequestError) {
    logger.warn({ msg: error.message }, "anthropic bad request");
    throw new HttpError(400, "The AI service could not process this request.");
  }
  if (error instanceof Anthropic.APIConnectionError) throw new HttpError(502, "Could not reach the AI service. Please retry.");
  if (error instanceof Anthropic.APIError) {
    logger.error({ status: error.status }, "anthropic api error");
    throw new HttpError(502, "The AI service returned an error. Please retry.");
  }
  if ((error as Error)?.name === "AbortError") throw error;
  logger.error({ err: error instanceof Error ? error.message : String(error) }, "llm call failed");
  throw new HttpError(502, "The AI service is unavailable. Please retry.");
}

export class AnthropicProvider implements LlmProvider {
  readonly name = "anthropic";
  readonly model: string;
  private client: Anthropic;

  constructor(apiKey: string, model: string) {
    this.client = new Anthropic({ apiKey, maxRetries: 2, timeout: 120_000 });
    this.model = model;
  }

  async *streamChat(input: { system: string; messages: ChatTurn[]; maxTokens?: number; signal?: AbortSignal }): AsyncIterable<ChatEvent> {
    try {
      // Server-side refusal fallback: if the primary model declines, the API reroutes
      // the same request instead of returning an empty refusal.
      const stream = this.client.beta.messages.stream(
        {
          model: this.model,
          max_tokens: input.maxTokens ?? 8000,
          betas: ["server-side-fallback-2026-07-01"],
          fallbacks: "default",
          // medium: the assistant reasons over the user's live invoices and balances, not just docs.
          output_config: { effort: "medium" },
          system: [{ type: "text", text: input.system, cache_control: { type: "ephemeral" } }],
          messages: input.messages.map((message) => ({ role: message.role, content: message.content })),
        } as unknown as Parameters<typeof this.client.beta.messages.stream>[0],
        { signal: input.signal },
      );
      for await (const event of stream) {
        if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
          yield { type: "text", text: event.delta.text };
        }
      }
      const final = await stream.finalMessage();
      if (final.stop_reason === "refusal") {
        throw new HttpError(422, "The assistant declined to answer this request.");
      }
      yield {
        type: "done",
        model: final.model,
        inputTokens: final.usage?.input_tokens ?? null,
        outputTokens: final.usage?.output_tokens ?? null,
        stopReason: final.stop_reason ?? null,
      };
    } catch (error) {
      mapProviderError(error);
    }
  }

  async extractStructured<T>(input: { schema: ZodType<T>; prompt: string; file?: { mime: string; base64: string } }): Promise<T> {
    const content: Anthropic.ContentBlockParam[] = [];
    if (input.file) {
      content.push(
        input.file.mime === "application/pdf"
          ? { type: "document", source: { type: "base64", media_type: "application/pdf", data: input.file.base64 } }
          : { type: "image", source: { type: "base64", media_type: input.file.mime as "image/png" | "image/jpeg" | "image/webp", data: input.file.base64 } },
      );
    }
    content.push({ type: "text", text: input.prompt });
    try {
      const response = await this.client.messages.parse({
        model: this.model,
        max_tokens: 16000,
        output_config: { effort: "medium", format: zodOutputFormat(input.schema as ZodType<T> & Parameters<typeof zodOutputFormat>[0]) },
        messages: [{ role: "user", content }],
      });
      if (response.stop_reason === "refusal") throw new HttpError(422, "The AI declined to process this document.");
      if (response.stop_reason === "max_tokens") throw new HttpError(422, "The document is too long to extract in one pass.");
      if (!response.parsed_output) throw new HttpError(502, "The AI returned output that did not match the expected format.");
      return response.parsed_output as T;
    } catch (error) {
      mapProviderError(error);
    }
  }
}

let provider: LlmProvider | null = null;

/** Returns the configured provider, or throws 503 when no AI key is configured (never a silent fallback). */
export function getLlm(): LlmProvider {
  if (provider) return provider;
  const config = getConfig();
  if (!config.ANTHROPIC_API_KEY) {
    throw new HttpError(503, "AI is not configured on this server (ANTHROPIC_API_KEY is not set).");
  }
  provider = new AnthropicProvider(config.ANTHROPIC_API_KEY, config.ANTHROPIC_MODEL);
  return provider;
}

export function isLlmConfigured() {
  return Boolean(provider) || Boolean(getConfig().ANTHROPIC_API_KEY);
}

export function setLlmForTests(fake: LlmProvider | null) {
  provider = fake;
}
