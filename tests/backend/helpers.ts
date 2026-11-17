import { Keypair } from "@stellar/stellar-sdk";
import request from "supertest";
import type { Express } from "express";
import { createApp } from "../../backend/app";
import { resetConfigForTests } from "../../backend/config";
import { createTestDb, setDbForTests, type Db } from "../../backend/db";
import { setEmbeddingsForTests, type EmbeddingProvider } from "../../backend/modules/assistant/embeddings";
import { resetKnowledgeForTests } from "../../backend/modules/assistant/knowledge";
import { setLlmForTests, type LlmProvider } from "../../backend/modules/assistant/llm";

/**
 * Deterministic bag-of-words embedding for tests: fast, offline, and similar texts
 * share dimensions. (The real local model is exercised in knowledge-eval.test.ts.)
 */
export const hashEmbeddings: EmbeddingProvider = {
  model: "test:hash-64",
  async embed(texts: string[]) {
    return texts.map((text) => {
      const vector = new Array(64).fill(0);
      for (const word of text.toLowerCase().match(/[a-z]{3,}/g) ?? []) {
        let h = 0;
        for (const char of word) h = (h * 31 + char.charCodeAt(0)) >>> 0;
        vector[h % 64] += 1;
      }
      const norm = Math.hypot(...vector) || 1;
      return vector.map((value) => value / norm);
    });
  },
};

export interface TestContext {
  app: Express;
  db: Db;
}

export async function setupApp(options: { embeddings?: EmbeddingProvider | null; llm?: LlmProvider | null } = {}): Promise<TestContext> {
  resetConfigForTests();
  const db = await createTestDb();
  setDbForTests(db);
  setEmbeddingsForTests(options.embeddings === undefined ? hashEmbeddings : options.embeddings);
  setLlmForTests(options.llm ?? null);
  resetKnowledgeForTests();
  return { app: createApp(), db };
}

export async function teardown(ctx: TestContext) {
  setDbForTests(null);
  setLlmForTests(null);
  setEmbeddingsForTests(undefined);
  await ctx.db.close();
}

/** Signs in through the real challenge/verify flow using SEP-53 message signing. */
export async function signIn(app: Express, keypair = Keypair.random()) {
  const agent = request.agent(app);
  const challenge = await agent.post("/api/auth/challenge").set("x-fintrix-csrf", "1").send({ address: keypair.publicKey() }).expect(200);
  const signature = Buffer.from(keypair.signMessage(challenge.body.data.message)).toString("base64");
  const verified = await agent
    .post("/api/auth/verify")
    .set("x-fintrix-csrf", "1")
    .send({ address: keypair.publicKey(), nonce: challenge.body.data.nonce, signature });
  if (verified.status !== 200) throw new Error(`sign-in failed: ${verified.status} ${JSON.stringify(verified.body)}`);
  return { agent, keypair, address: keypair.publicKey() };
}

export function futureDate(days: number) {
  return new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
}

export function invoiceBody(overrides: Record<string, unknown> = {}) {
  return {
    invoiceNumber: `INV-${Math.floor(Math.random() * 1e6)}`,
    issuerName: "Northwind Components Ltd",
    buyerName: "Contoso Retail Group",
    buyerCountry: "US",
    currency: "USD",
    issueDate: futureDate(-5),
    dueDate: futureDate(60),
    subtotal: 1000,
    tax: 80,
    total: 1080,
    lineItems: [{ description: "Widgets", quantity: 10, unitPrice: 100, amount: 1000 }],
    discountBps: 300,
    notes: null,
    ...overrides,
  };
}
