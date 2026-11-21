import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { annualisedYield, computeTerms } from "../../backend/modules/invoices/service";
import { futureDate, invoiceBody, setupApp, signIn, teardown, type TestContext } from "./helpers";

let ctx: TestContext;
beforeAll(async () => {
  ctx = await setupApp();
});
afterAll(() => teardown(ctx));
const csrf = { "x-fintrix-csrf": "1" };

describe("invoice terms", () => {
  it("prices the invoice at total minus discount and repays the total", () => {
    expect(computeTerms(100_000, 300)).toEqual({ priceCents: 97_000, repaymentCents: 100_000, investorReturnCents: 3_000 });
  });
  it("annualises the return with simple interest", () => {
    const from = new Date("2026-01-01T00:00:00Z");
    const yieldPct = annualisedYield(97_000, 100_000, "2026-04-01", from);
    expect(yieldPct).toBeCloseTo((3_000 / 97_000) * (365 / 91), 2);
  });
});

describe("invoice API", () => {
  it("creates a draft with risk score and no duplicate flags", async () => {
    const { agent, address } = await signIn(ctx.app);
    const res = await agent.post("/api/invoices").set(csrf).send(invoiceBody({ invoiceNumber: "A-1" })).expect(201);
    const invoice = res.body.data;
    expect(invoice.status).toBe("draft");
    expect(invoice.seller.address).toBe(address);
    expect(invoice.terms.price).toBe(1047.6);
    expect(invoice.terms.repayment).toBe(1080);
    expect(invoice.documentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(invoice.risk).not.toBeNull();
    expect(invoice.risk.score).toBeGreaterThan(0);
    expect(invoice.risk.score).toBeLessThan(1);
    expect(invoice.risk.model).toMatch(/fintrix-late-payment-logreg/);
    expect(invoice.duplicateFlags).toEqual([]);
    expect(invoice.actions).toMatchObject({ edit: true, delete: true, list: true, fund: false });
  });

  it("keeps drafts private to the seller", async () => {
    const seller = await signIn(ctx.app);
    const other = await signIn(ctx.app);
    const created = await seller.agent.post("/api/invoices").set(csrf).send(invoiceBody()).expect(201);
    await other.agent.get(`/api/invoices/${created.body.data.id}`).expect(404);
    const list = await other.agent.get("/api/invoices?scope=all").expect(200);
    expect(list.body.data.items.find((item: { id: string }) => item.id === created.body.data.id)).toBeUndefined();
    await other.agent.put(`/api/invoices/${created.body.data.id}`).set(csrf).send(invoiceBody()).expect(404);
    await other.agent.delete(`/api/invoices/${created.body.data.id}`).set(csrf).expect(404);
  });

  it("validates business rules", async () => {
    const { agent } = await signIn(ctx.app);
    const due = await agent.post("/api/invoices").set(csrf).send(invoiceBody({ issueDate: futureDate(10), dueDate: futureDate(1) })).expect(400);
    expect(due.body.error).toMatch(/Due date/);
    const sum = await agent.post("/api/invoices").set(csrf).send(invoiceBody({ subtotal: 1000, tax: 50, total: 1080 })).expect(400);
    expect(sum.body.error).toMatch(/Subtotal plus tax/);
    const bad = await agent.post("/api/invoices").set(csrf).send(invoiceBody({ currency: "usd", discountBps: 9000 })).expect(400);
    expect(bad.body.details.map((d: { path: string }) => d.path)).toEqual(expect.arrayContaining(["currency", "discountBps"]));
    await agent.post("/api/invoices").set(csrf).send({ ...invoiceBody(), extra: "x" }).expect(400);
  });

  it("rejects a duplicate invoice number for the same seller", async () => {
    const { agent } = await signIn(ctx.app);
    await agent.post("/api/invoices").set(csrf).send(invoiceBody({ invoiceNumber: "DUP-1" })).expect(201);
    const res = await agent.post("/api/invoices").set(csrf).send(invoiceBody({ invoiceNumber: "DUP-1" })).expect(409);
    expect(res.body.error).toMatch(/already have an invoice/);
  });

  it("flags near-duplicates across sellers", async () => {
    const a = await signIn(ctx.app);
    const b = await signIn(ctx.app);
    const first = await a.agent.post("/api/invoices").set(csrf).send(invoiceBody({ invoiceNumber: "INV-0042", buyerName: "Fabrikam Industries Ltd", total: 5000, subtotal: null, tax: null, lineItems: [] })).expect(201);
    const second = await b.agent
      .post("/api/invoices")
      .set(csrf)
      .send(invoiceBody({ invoiceNumber: "42", buyerName: "FABRIKAM INDUSTRIES LIMITED", total: 5000, subtotal: null, tax: null, lineItems: [] }))
      .expect(201);
    expect(second.body.data.duplicateFlags[0]).toMatchObject({ invoiceId: first.body.data.id, rule: "same_number_and_buyer", severity: "high" });
  });

  it("edits and deletes drafts only", async () => {
    const { agent } = await signIn(ctx.app);
    const created = await agent.post("/api/invoices").set(csrf).send(invoiceBody()).expect(201);
    const id = created.body.data.id;
    const edited = await agent.put(`/api/invoices/${id}`).set(csrf).send(invoiceBody({ invoiceNumber: "EDIT-1", buyerName: "New Buyer" })).expect(200);
    expect(edited.body.data.buyerName).toBe("New Buyer");
    await ctx.db.query("UPDATE invoices SET status = 'listed' WHERE id = $1", [id]);
    await agent.put(`/api/invoices/${id}`).set(csrf).send(invoiceBody()).expect(409);
    await agent.delete(`/api/invoices/${id}`).set(csrf).expect(409);
  });

  it("lists by scope and searches", async () => {
    const { agent } = await signIn(ctx.app);
    await agent.post("/api/invoices").set(csrf).send(invoiceBody({ invoiceNumber: "SRCH-1", buyerName: "Zebra Logistics" })).expect(201);
    const mine = await agent.get("/api/invoices?scope=mine&q=zebra").expect(200);
    expect(mine.body.data.items).toHaveLength(1);
    const market = await agent.get("/api/invoices?scope=marketplace").expect(200);
    expect(market.body.data.items.every((item: { status: string }) => item.status === "listed")).toBe(true);
    await agent.get("/api/invoices?scope=bogus").expect(400);
  });

  it("computes the dashboard from real data only", async () => {
    const { agent } = await signIn(ctx.app);
    const empty = await agent.get("/api/dashboard").expect(200);
    expect(empty.body.data.selling.drafts).toEqual({ count: 0, total: 0 });
    expect(empty.body.data.investing.active).toEqual({ count: 0, total: 0 });
    expect(empty.body.data.recentTransactions).toEqual([]);
    await agent.post("/api/invoices").set(csrf).send(invoiceBody()).expect(201);
    const after = await agent.get("/api/dashboard").expect(200);
    expect(after.body.data.selling.drafts).toEqual({ count: 1, total: 1080 });
  });

  it("refuses to prepare actions the caller is not allowed to take", async () => {
    const seller = await signIn(ctx.app);
    const investor = await signIn(ctx.app);
    const created = await seller.agent.post("/api/invoices").set(csrf).send(invoiceBody()).expect(201);
    // Investors cannot see drafts at all.
    await investor.agent.post(`/api/invoices/${created.body.data.id}/actions/fund`).set(csrf).expect(404);
    // The seller cannot fund their own draft.
    await seller.agent.post(`/api/invoices/${created.body.data.id}/actions/fund`).set(csrf).expect(409);
    await seller.agent.post(`/api/invoices/${created.body.data.id}/actions/teleport`).set(csrf).expect(400);
    const eur = await seller.agent.post("/api/invoices").set(csrf).send(invoiceBody({ currency: "EUR" })).expect(201);
    expect(eur.body.data.actions.list).toBe(false);
    const res = await seller.agent.post(`/api/invoices/${eur.body.data.id}/actions/create`).set(csrf).expect(400);
    expect(res.body.error).toMatch(/Only USD/);
  });
});
