import path from "path";
import { getConfig } from "../../config";
import { HttpError } from "../../errors";
import { logger } from "../../logger";

/**
 * Embedding providers for retrieval.
 *  - local:  sentence-transformers/all-MiniLM-L6-v2 (384-d) run on-device via transformers.js.
 *            No API key; the ~23 MB quantised model downloads once to .data/models.
 *  - voyage: Voyage AI API (voyage-3.5-lite, 512-d). Recommended on serverless hosts.
 *  - none:   vector search disabled; retrieval uses Postgres full-text search only.
 */
export interface EmbeddingProvider {
  readonly model: string;
  embed(texts: string[], kind: "query" | "document"): Promise<number[][]>;
}

type FeatureExtractor = (texts: string[], options: { pooling: "mean"; normalize: boolean }) => Promise<{ tolist(): number[][] }>;

class LocalEmbeddings implements EmbeddingProvider {
  readonly model = "local:all-MiniLM-L6-v2";
  private extractor: Promise<FeatureExtractor> | null = null;

  private load() {
    this.extractor ??= (async () => {
      // Indirect specifier keeps serverless bundlers from tracing the heavy ONNX runtime.
      const moduleName = "@huggingface/transformers";
      const transformers = await import(moduleName);
      transformers.env.cacheDir = path.resolve(process.cwd(), getConfig().FINTRIX_CACHE_DIR, "models");
      transformers.env.allowRemoteModels = true;
      return (await transformers.pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2", { dtype: "q8" })) as unknown as FeatureExtractor;
    })().catch((error) => {
      this.extractor = null;
      throw error;
    });
    return this.extractor;
  }

  async embed(texts: string[]) {
    const extractor = await this.load();
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += 16) {
      const batch = await extractor(texts.slice(i, i + 16), { pooling: "mean", normalize: true });
      out.push(...batch.tolist());
    }
    return out;
  }
}

class VoyageEmbeddings implements EmbeddingProvider {
  readonly model = "voyage:voyage-3.5-lite";
  constructor(private apiKey: string) {}

  async embed(texts: string[], kind: "query" | "document") {
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += 64) {
      const response = await fetch("https://api.voyageai.com/v1/embeddings", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify({ input: texts.slice(i, i + 64), model: "voyage-3.5-lite", input_type: kind, output_dimension: 512 }),
      });
      if (!response.ok) {
        logger.error({ status: response.status }, "voyage embeddings failed");
        throw new HttpError(502, "Embedding service request failed.");
      }
      const json = (await response.json()) as { data: { embedding: number[]; index: number }[] };
      out.push(...json.data.sort((a, b) => a.index - b.index).map((item) => item.embedding));
    }
    return out;
  }
}

let provider: EmbeddingProvider | null | undefined;

export function getEmbeddings(): EmbeddingProvider | null {
  if (provider !== undefined) return provider;
  const config = getConfig();
  if (config.EMBEDDINGS_PROVIDER === "none") provider = null;
  else if (config.EMBEDDINGS_PROVIDER === "voyage") {
    if (!config.VOYAGE_API_KEY) throw new HttpError(503, "EMBEDDINGS_PROVIDER=voyage requires VOYAGE_API_KEY.");
    provider = new VoyageEmbeddings(config.VOYAGE_API_KEY);
  } else provider = new LocalEmbeddings();
  return provider;
}

export function setEmbeddingsForTests(fake: EmbeddingProvider | null | undefined) {
  provider = fake;
}

export function toVectorLiteral(vector: number[]) {
  return `[${vector.map((value) => (Number.isFinite(value) ? value.toFixed(6) : "0")).join(",")}]`;
}
