/**
 * REAL Stellar testnet end-to-end test of the invoice lifecycle through the Fintrix API.
 * Opt-in (network access, ~2 minutes):  FINTRIX_TESTNET=1 npx vitest run tests/backend/testnet.integration.test.ts
 *
 * Fresh accounts are created and funded by Friendbot for each run (no secrets involved).
 * Signing is done with the test keypairs exactly as Freighter would sign the server-prepared XDR.
 */
import { Horizon, Keypair, TransactionBuilder } from "@stellar/stellar-sdk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type request from "supertest";
import { getConfig } from "../../backend/config";
import { getChainInvoice } from "../../backend/modules/chain/soroban";
import { futureDate, invoiceBody, setupApp, signIn, teardown, type TestContext } from "./helpers";

const enabled = process.env.FINTRIX_TESTNET === "1";
const csrf = { "x-fintrix-csrf": "1" };

async function friendbot(address: string) {
  const res = await fetch(`https://friendbot.stellar.org/?addr=${address}`);
  if (!res.ok) throw new Error(`friendbot failed: ${res.status}`);
}

async function xlmBalance(address: string) {
  const account = await new Horizon.Server(getConfig().stellar.horizonUrl).loadAccount(address);
  return Number(account.balances.find((balance) => balance.asset_type === "native")!.balance);
}

/** Prepares an action, signs the returned XDR with `signer`, submits it and returns the result. */
async function act(agent: ReturnType<typeof request.agent>, signer: Keypair, invoiceId: string, action: string) {
  const prepared = await agent.post(`/api/invoices/${invoiceId}/actions/${action}`).set(csrf);
  if (prepared.status !== 200) throw new Error(`prepare ${action} failed: ${prepared.status} ${JSON.stringify(prepared.body)}`);
  const { transactionId, xdr, networkPassphrase } = prepared.body.data;
  const tx = TransactionBuilder.fromXDR(xdr, networkPassphrase);
  tx.sign(signer);
  const submitted = await agent.post(`/api/chain/transactions/${transactionId}/submit`).set(csrf).send({ signedXdr: tx.toXDR() });
  if (submitted.status !== 200) throw new Error(`submit ${action} failed: ${submitted.status} ${JSON.stringify(submitted.body)}`);
  let result = submitted.body.data;
  for (let i = 0; i < 6 && result.status === "submitted"; i++) {
    result = (await agent.get(`/api/chain/transactions/${transactionId}`)).body.data;
  }
  return result;
}

describe.skipIf(!enabled)("Stellar testnet lifecycle", () => {
  let ctx: TestContext;
  const seller = Keypair.random();
  const investor = Keypair.random();
  let sellerAgent: Awaited<ReturnType<typeof signIn>>["agent"];
  let investorAgent: Awaited<ReturnType<typeof signIn>>["agent"];
  let invoiceId = "";

  beforeAll(async () => {
    ctx = await setupApp();
    await Promise.all([friendbot(seller.publicKey()), friendbot(investor.publicKey())]);
    sellerAgent = (await signIn(ctx.app, seller)).agent;
    investorAgent = (await signIn(ctx.app, investor)).agent;
  }, 120_000);
  afterAll(() => teardown(ctx));

  it("lists an invoice on-chain (create_invoice) and syncs the contract id", async () => {
    const created = await sellerAgent.post("/api/invoices").set(csrf).send(invoiceBody({ total: 55, subtotal: null, tax: null, lineItems: [], discountBps: 300, dueDate: futureDate(30) })).expect(201);
    invoiceId = created.body.data.id;
    const result = await act(sellerAgent, seller, invoiceId, "create");
    expect(result.status).toBe("success");
    expect(result.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(result.explorerUrl).toContain(result.hash);
    expect(result.invoice.status).toBe("listed");
    expect(result.invoice.chain.invoiceId).toMatch(/^\d+$/);
    const onChain = await getChainInvoice(result.invoice.chain.invoiceId);
    expect(onChain.status).toBe("Listed");
    expect(onChain.seller).toBe(seller.publicKey());
    expect(onChain.docHash).toBe(created.body.data.documentHash);
    // 55 USD at 0.11 USD/XLM = 500 XLM repayment; 3% discount -> 485 XLM price.
    expect(result.invoice.terms.repaymentAmount).toBe("500.0000000");
    expect(result.invoice.terms.priceAmount).toBe("485.0000000");
  }, 120_000);

  it("shows the listing on the marketplace to other users", async () => {
    const market = await investorAgent.get("/api/invoices?scope=marketplace").expect(200);
    const item = market.body.data.items.find((entry: { id: string }) => entry.id === invoiceId);
    expect(item).toBeDefined();
    expect(item.actions.fund).toBe(true);
  });

  it("rejects a signed transaction that differs from the prepared one", async () => {
    const prepared = await investorAgent.post(`/api/invoices/${invoiceId}/actions/fund`).set(csrf).expect(200);
    // Build a different transaction (bumped fee) from the same source and sign it.
    const original = TransactionBuilder.fromXDR(prepared.body.data.xdr, prepared.body.data.networkPassphrase);
    const tampered = TransactionBuilder.cloneFrom(original as never, { fee: "9999999", networkPassphrase: prepared.body.data.networkPassphrase }).build();
    tampered.sign(investor);
    const res = await investorAgent.post(`/api/chain/transactions/${prepared.body.data.transactionId}/submit`).set(csrf).send({ signedXdr: tampered.toXDR() }).expect(400);
    expect(res.body.error).toMatch(/does not match/);
  }, 60_000);

  it("funds the invoice (fund_invoice): price moves investor -> seller", async () => {
    const sellerBefore = await xlmBalance(seller.publicKey());
    const result = await act(investorAgent, investor, invoiceId, "fund");
    expect(result.status).toBe("success");
    expect(result.invoice.status).toBe("funded");
    expect(result.invoice.investor.address).toBe(investor.publicKey());
    const sellerAfter = await xlmBalance(seller.publicKey());
    expect(sellerAfter - sellerBefore).toBeCloseTo(485, 4);
  }, 120_000);

  it("blocks listing a second invoice with the same document fingerprint", async () => {
    const funded = await sellerAgent.get(`/api/invoices/${invoiceId}`).expect(200);
    const second = await sellerAgent.post("/api/invoices").set(csrf).send(invoiceBody({ total: 55, subtotal: null, tax: null, lineItems: [] })).expect(201);
    await ctx.db.query("UPDATE invoices SET document_hash = $2 WHERE id = $1", [second.body.data.id, funded.body.data.documentHash]);
    const res = await sellerAgent.post(`/api/invoices/${second.body.data.id}/actions/create`).set(csrf).expect(400);
    expect(res.body.error).toMatch(/duplicate/i);
  }, 60_000);

  it("repays into escrow (repay_invoice) and the investor claims it (claim)", async () => {
    const repaid = await act(sellerAgent, seller, invoiceId, "repay");
    expect(repaid.status).toBe("success");
    expect(repaid.invoice.status).toBe("repaid");

    const investorBefore = await xlmBalance(investor.publicKey());
    const claimed = await act(investorAgent, investor, invoiceId, "claim");
    expect(claimed.status).toBe("success");
    expect(claimed.invoice.status).toBe("settled");
    const investorAfter = await xlmBalance(investor.publicKey());
    // +500 XLM minus the transaction fee.
    expect(investorAfter - investorBefore).toBeGreaterThan(499);
    expect((await getChainInvoice(claimed.invoice.chain.invoiceId)).status).toBe("Settled");
  }, 180_000);

  it("records the full history for each user", async () => {
    const sellerTx = await sellerAgent.get("/api/chain/transactions").expect(200);
    expect(sellerTx.body.data.filter((tx: { status: string }) => tx.status === "success").map((tx: { kind: string }) => tx.kind).sort()).toEqual(["create", "repay"]);
    const investorTx = await investorAgent.get("/api/chain/transactions").expect(200);
    expect(investorTx.body.data.filter((tx: { status: string }) => tx.status === "success").map((tx: { kind: string }) => tx.kind).sort()).toEqual(["claim", "fund"]);
    const dashboard = await investorAgent.get("/api/dashboard").expect(200);
    expect(dashboard.body.data.investing.settled.count).toBe(1);
    const activity = await investorAgent.get("/api/chain/activity").expect(200);
    expect(activity.body.data.length).toBeGreaterThan(0);
  }, 60_000);
});
