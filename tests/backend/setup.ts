// Runs before every backend test file.
process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "silent";
// Tests must never call real paid AI services by accident. An empty value (not delete) stops
// dotenv from re-reading the key from .env. Only the opt-in live evaluation keeps the real key.
if (process.env.FINTRIX_LIVE_AI !== "1") {
  process.env.ANTHROPIC_API_KEY = "";
  process.env.VOYAGE_API_KEY = "";
}
process.env.EMBEDDINGS_PROVIDER = process.env.EMBEDDINGS_PROVIDER_FOR_TESTS ?? "local";
