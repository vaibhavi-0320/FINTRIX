import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HttpError } from "../../backend/errors";
import { buildSystemPrompt, FollowupFilter } from "../../backend/modules/assistant/service";
import { chunkMarkdown, parseKbFile } from "../../backend/modules/assistant/knowledge";
import { setLlmForTests, type ChatEvent, type LlmProvider } from "../../backend/modules/assistant/llm";
import { setAccountLoaderForTests } from "../../backend/modules/assistant/context";
import { invoiceBody, setupApp, signIn, teardown, type TestContext } from "./helpers";

/** Fake provider: records the prompt it received and streams a scripted answer in small pieces. */
class FakeLlm implements LlmProvider {
  readonly name = "fake";
  readonly model = "fake-model";
  lastSystem = "";
  lastMessages: { role: string; content: string }[] = [];
  constructor(private answer: string, private fail?: HttpError) {}
  async *streamChat(input: { system: string; messages: { role: "user" | "assistant"; content: string }[] }): AsyncIterable<ChatEvent> {
    this.lastSystem = input.system;
    this.lastMessages = input.messages;
    if (this.fail) throw this.fail;
    for (let i = 0; i < this.answer.length; i += 7) yield { type: "text", text: this.answer.slice(i, i + 7) };
    yield { type: "done", model: this.model, inputTokens: 100, outputTokens: 20, stopReason: "end_turn" };
  }
  async extractStructured<T>(): Promise<T> {
    throw new Error("not used");
  }
}

function parseSse(text: string) {
  return text
    .split("\n\n")
    .filter(Boolean)
    .map((block) => JSON.parse(block.split("\n").find((line) => line.startsWith("data: "))!.slice(6)));
}

let ctx: TestContext;
beforeAll(async () => {
  ctx = await setupApp();
  // Offline stand-in for Horizon.
  setAccountLoaderForTests(async (address) => ({ address, network: "testnet", exists: true, balances: [{ asset: "XLM", balance: "9612.5000000" }], friendbotUrl: null }));
});
afterAll(() => {
  setAccountLoaderForTests(null);
  return teardown(ctx);
});
const csrf = { "x-fintrix-csrf": "1" };

describe("follow-up filter", () => {
  it("strips the follow-up tag even when it arrives split across chunks", () => {
    const filter = new FollowupFilter();
    const pieces = ["Funding moves the price [1].\n<fol", "lowups>[\"How do I", " claim?\", \"What is a", " default?\"]</followups>"];
    const visible = pieces.map((piece) => filter.push(piece)).join("");
    const { rest, followups } = filter.finish();
    expect(visible + rest).toBe("Funding moves the price [1].\n");
    expect(followups).toEqual(["How do I claim?", "What is a default?"]);
  });
  it("passes text through untouched when there is no tag", () => {
    const filter = new FollowupFilter();
    expect(filter.push("a < b and <fo") + filter.finish().rest).toBe("a < b and <fo");
  });
});

describe("prompt construction", () => {
  it("includes safety rules and audience style", () => {
    const prompt = buildSystemPrompt("developer");
    expect(prompt).toMatch(/TESTNET/);
    expect(prompt).toMatch(/not instructions/);
    expect(prompt).toMatch(/financial, investment, legal or tax advice/);
    expect(prompt).toMatch(/software developer/);
  });
  it("chunks markdown along headings with a heading trail", () => {
    const doc = parseKbFile("x", "---\ntitle: Doc\ncategory: test\n---\n# Doc\nIntro\n## A\nalpha\n### A1\nbeta\n## B\ngamma");
    expect(doc).toMatchObject({ title: "Doc", category: "test" });
    expect(chunkMarkdown(doc).map((chunk) => chunk.heading)).toEqual(["Doc", "Doc › A", "Doc › A › A1", "Doc › B"]);
  });
});

describe("assistant page and data context", () => {
  it("knows the screen, the open deal with its next action, the balance and the user's invoices", async () => {
    const llm = new FakeLlm("ok");
    setLlmForTests(llm);
    const { agent } = await signIn(ctx.app);
    const draft = await agent.post("/api/invoices").set(csrf).send(invoiceBody({ invoiceNumber: "CTX-1001", buyerName: "Fabrikam Foods" })).expect(201);
    const convo = await agent.post("/api/assistant/conversations").set(csrf).send({}).expect(201);
    await agent
      .post(`/api/assistant/conversations/${convo.body.data.id}/messages`)
      .set(csrf)
      .send({ content: "What should I do next with this invoice?", context: { view: "deal-detail", invoiceId: draft.body.data.id } })
      .expect(200);
    const data = llm.lastMessages.at(-1)!.content;
    expect(data).toContain("current_screen: Deal detail page");
    expect(data).toContain("deal_open_on_screen: CTX-1001 | buyer Fabrikam Foods");
    expect(data).toContain("you are the seller");
    expect(data).toContain("available actions for you: LIST ON MARKETPLACE");
    expect(data).toContain("investor price $1,047.60"); // $1,080 less 3%
    expect(data).toContain("balances: 9612.5000000 XLM");
    expect(data).toContain("my_invoices_as_seller (1):\n  - CTX-1001");
    // The system prompt carries the original UI's map and button names.
    expect(llm.lastSystem).toContain("FUND THIS INVOICE");
    expect(llm.lastSystem).toContain("Simulate on Testnet");
    expect(llm.lastSystem).toContain("Trust Score");
  });

  it("does not reveal another user's draft through the page context", async () => {
    const llm = new FakeLlm("ok");
    setLlmForTests(llm);
    const seller = await signIn(ctx.app);
    const draft = await seller.agent.post("/api/invoices").set(csrf).send(invoiceBody({ invoiceNumber: "CTX-SECRET" })).expect(201);
    const other = await signIn(ctx.app);
    const convo = await other.agent.post("/api/assistant/conversations").set(csrf).send({}).expect(201);
    await other.agent
      .post(`/api/assistant/conversations/${convo.body.data.id}/messages`)
      .set(csrf)
      .send({ content: "Tell me about this deal", context: { view: "deal-detail", invoiceId: draft.body.data.id } })
      .expect(200);
    const data = llm.lastMessages.at(-1)!.content;
    expect(data).not.toContain("CTX-SECRET");
    expect(data).not.toContain("deal_open_on_screen");
  });

  it("rejects unknown screens and malformed ids", async () => {
    setLlmForTests(new FakeLlm("ok"));
    const { agent } = await signIn(ctx.app);
    const convo = await agent.post("/api/assistant/conversations").set(csrf).send({}).expect(201);
    const url = `/api/assistant/conversations/${convo.body.data.id}/messages`;
    await agent.post(url).set(csrf).send({ content: "hi", context: { view: "admin" } }).expect(400);
    await agent.post(url).set(csrf).send({ content: "hi", context: { invoiceId: "1 OR 1=1" } }).expect(400);
  });
});

describe("assistant API", () => {
  it("streams an answer with sources first, strips follow-ups, and persists the conversation", async () => {
    const llm = new FakeLlm('Investors claim repayment from the escrow contract [1].\n<followups>["How is the price set?","What if they default?"]</followups>');
    setLlmForTests(llm);
    const { agent, address } = await signIn(ctx.app);
    const convo = await agent.post("/api/assistant/conversations").set(csrf).send({ audience: "investor" }).expect(201);
    const res = await agent.post(`/api/assistant/conversations/${convo.body.data.id}/messages`).set(csrf).send({ content: "How do investors get repaid?" }).expect(200);
    expect(res.headers["content-type"]).toMatch(/text\/event-stream/);

    const events = parseSse(res.text);
    expect(events.map((event) => event.type)).toEqual(expect.arrayContaining(["start", "sources", "text", "followups", "done"]));
    expect(events.findIndex((event) => event.type === "sources")).toBeLessThan(events.findIndex((event) => event.type === "text"));
    const sources = events.find((event) => event.type === "sources").sources;
    expect(sources.length).toBeGreaterThan(0);
    // With the crude test embeddings we only require relevant articles; ranking quality is measured in knowledge-eval.test.ts.
    expect(sources.some((source: { slug: string }) => ["05-investor-guide", "04-seller-guide", "08-smart-contract", "09-transaction-lifecycle"].includes(source.slug))).toBe(true);
    const text = events.filter((event) => event.type === "text").map((event) => event.delta).join("");
    expect(text).not.toContain("<followups>");
    expect(events.find((event) => event.type === "followups").items).toEqual(["How is the price set?", "What if they default?"]);

    // The model received retrieved sources, the user's own data and the investor style.
    const last = llm.lastMessages.at(-1)!.content;
    expect(last).toContain("<sources>");
    expect(last).toContain(`wallet: ${address}`);
    expect(llm.lastSystem).toMatch(/evaluating Fintrix as a business/);

    const saved = await agent.get(`/api/assistant/conversations/${convo.body.data.id}`).expect(200);
    expect(saved.body.data.title).toBe("How do investors get repaid?");
    expect(saved.body.data.messages.map((message: { role: string }) => message.role)).toEqual(["user", "assistant"]);
    expect(saved.body.data.messages[1].content).toBe("Investors claim repayment from the escrow contract [1].");
    expect(saved.body.data.messages[1].followups).toHaveLength(2);
  });

  it("sends prior turns as context in multi-turn conversations", async () => {
    const llm = new FakeLlm("Answer.");
    setLlmForTests(llm);
    const { agent } = await signIn(ctx.app);
    const convo = await agent.post("/api/assistant/conversations").set(csrf).send({}).expect(201);
    await agent.post(`/api/assistant/conversations/${convo.body.data.id}/messages`).set(csrf).send({ content: "What is Fintrix?" }).expect(200);
    await agent.post(`/api/assistant/conversations/${convo.body.data.id}/messages`).set(csrf).send({ content: "And who pays the fees?" }).expect(200);
    expect(llm.lastMessages.map((message) => message.role)).toEqual(["user", "assistant", "user"]);
    expect(llm.lastMessages[0].content).toBe("What is Fintrix?");
  });

  it("reports provider failures as errors (no canned fallback) but still returns sources", async () => {
    setLlmForTests(new FakeLlm("", new HttpError(502, "The AI service is unavailable. Please retry.")));
    const { agent } = await signIn(ctx.app);
    const convo = await agent.post("/api/assistant/conversations").set(csrf).send({}).expect(201);
    const res = await agent.post(`/api/assistant/conversations/${convo.body.data.id}/messages`).set(csrf).send({ content: "How do I fix wrong network in Freighter?" }).expect(200);
    const events = parseSse(res.text);
    expect(events.find((event) => event.type === "text")).toBeUndefined();
    expect(events.find((event) => event.type === "error")).toMatchObject({ status: 502, message: "The AI service is unavailable. Please retry." });
    const slugs = events.find((event) => event.type === "sources").sources.map((source: { slug: string }) => source.slug);
    expect(slugs).toEqual(expect.arrayContaining(["13-troubleshooting"]));
    const saved = await agent.get(`/api/assistant/conversations/${convo.body.data.id}`).expect(200);
    expect(saved.body.data.messages[1].status).toBe("error");
  });

  it("returns a 503 error event when no AI key is configured", async () => {
    setLlmForTests(null);
    const { agent } = await signIn(ctx.app);
    const convo = await agent.post("/api/assistant/conversations").set(csrf).send({}).expect(201);
    const res = await agent.post(`/api/assistant/conversations/${convo.body.data.id}/messages`).set(csrf).send({ content: "hello" }).expect(200);
    expect(parseSse(res.text).find((event) => event.type === "error")).toMatchObject({ status: 503 });
  });

  it("isolates conversations between users and validates input", async () => {
    setLlmForTests(new FakeLlm("ok"));
    const owner = await signIn(ctx.app);
    const other = await signIn(ctx.app);
    const convo = await owner.agent.post("/api/assistant/conversations").set(csrf).send({}).expect(201);
    await other.agent.get(`/api/assistant/conversations/${convo.body.data.id}`).expect(404);
    await other.agent.post(`/api/assistant/conversations/${convo.body.data.id}/messages`).set(csrf).send({ content: "hi" }).expect(404);
    await other.agent.delete(`/api/assistant/conversations/${convo.body.data.id}`).set(csrf).expect(404);
    await owner.agent.post(`/api/assistant/conversations/${convo.body.data.id}/messages`).set(csrf).send({ content: "" }).expect(400);
    await owner.agent.post(`/api/assistant/conversations/${convo.body.data.id}/messages`).set(csrf).send({ content: "x".repeat(4001) }).expect(400);
    await owner.agent.post("/api/assistant/conversations").set(csrf).send({ audience: "hacker" }).expect(400);
    await owner.agent.delete(`/api/assistant/conversations/${convo.body.data.id}`).set(csrf).expect(200);
    const list = await owner.agent.get("/api/assistant/conversations").expect(200);
    expect(list.body.data).toEqual([]);
  });
});

describe("help centre", () => {
  it("lists and serves knowledge articles publicly and rejects path tricks", async () => {
    const request = (await import("supertest")).default;
    await request(ctx.app).get("/api/knowledge/search?q=escrow").expect(200);
    const list = await request(ctx.app).get("/api/knowledge").expect(200);
    expect(list.body.data.documents.length).toBeGreaterThanOrEqual(15);
    const article = await request(ctx.app).get("/api/knowledge/08-smart-contract").expect(200);
    expect(article.body.data.body).toMatch(/fund_invoice/);
    await request(ctx.app).get("/api/knowledge/..%2F..%2Fpackage").expect(404);
  });
});
