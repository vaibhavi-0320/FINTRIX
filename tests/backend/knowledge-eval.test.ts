/**
 * Retrieval-quality evaluation using the REAL local embedding model (all-MiniLM-L6-v2)
 * plus full-text search. Each question has the knowledge article that must be retrieved.
 * Reports hit@1 and hit@3; fails if hit@3 drops below 85%.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { retrieve } from "../../backend/modules/assistant/knowledge";
import { setupApp, teardown, type TestContext } from "./helpers";

const EVAL: Array<[string, string]> = [
  ["What does Fintrix do?", "01-product-overview"],
  ["How does the backend talk to Stellar?", "02-architecture"],
  ["Which pages are in the app?", "03-features"],
  ["How do I list my invoice on the marketplace?", "04-seller-guide"],
  ["How do I fund an invoice as an investor?", "05-investor-guide"],
  ["What is invoice factoring?", "06-financial-concepts"],
  ["What is the difference between testnet and mainnet?", "07-stellar-and-wallets"],
  ["Which contract method moves the repayment into escrow?", "08-smart-contract"],
  ["What does a pending transaction status mean?", "09-transaction-lifecycle"],
  ["How is the late payment risk score calculated?", "10-ai-and-ml"],
  ["How are sessions and cookies protected?", "11-security"],
  ["Can the same invoice be listed twice?", "12-faq"],
  ["Freighter is on the wrong network, what do I do?", "13-troubleshooting"],
  ["How will Fintrix make money?", "14-business-model"],
  ["What are the current limitations?", "15-limitations"],
  ["What is a stroop?", "16-glossary"],
  ["What is technically novel about this project for judges?", "17-hackathon-summary"],
  ["My extraction failed on a scanned PDF", "13-troubleshooting"],
  ["Who can call mark_defaulted?", "08-smart-contract"],
  ["What happens if the seller never repays?", "05-investor-guide"],
  // Questions phrased the way the original UI (and its quick-question chips) asks them.
  ["What is a Trust Score?", "05-investor-guide"],
  ["How do I connect my wallet?", "03-features"],
  ["How do I claim my repayment?", "05-investor-guide"],
  ["What does Simulate on Testnet do?", "12-faq"],
  ["Can I use Albedo instead of Freighter?", "07-stellar-and-wallets"],
  ["Where do I upload my invoice and set the discount?", "04-seller-guide"],
  ["The page went back to the landing page after I refreshed", "13-troubleshooting"],
  ["What does the REPAY INTO ESCROW button do?", "04-seller-guide"],
];

let ctx: TestContext;
beforeAll(async () => {
  // null embeddings override = use the configured real provider (local model).
  ctx = await setupApp({ embeddings: undefined });
  const { setEmbeddingsForTests } = await import("../../backend/modules/assistant/embeddings");
  setEmbeddingsForTests(undefined);
}, 300_000);
afterAll(() => teardown(ctx));

describe("knowledge retrieval quality (real embeddings)", () => {
  it("retrieves the expected article for each evaluation question", async () => {
    let hit1 = 0;
    let hit3 = 0;
    const misses: string[] = [];
    for (const [question, slug] of EVAL) {
      const results = await retrieve(question, 3);
      const slugs = results.map((result) => result.slug);
      if (slugs[0] === slug) hit1++;
      if (slugs.includes(slug)) hit3++;
      else misses.push(`${question} -> ${slugs.join(", ")}`);
    }
    const report = { questions: EVAL.length, hitAt1: hit1 / EVAL.length, hitAt3: hit3 / EVAL.length, misses };
    console.log("retrieval eval:", JSON.stringify(report));
    expect(report.hitAt3).toBeGreaterThanOrEqual(0.85);
  }, 300_000);
});
