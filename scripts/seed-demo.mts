/**
 * Creates clearly labelled DEMO listings on Stellar TESTNET so the marketplace has
 * something to fund on a fresh install. Every listing is real: a freshly generated,
 * Friendbot-funded seller account signs genuine create_invoice transactions.
 * Listings are flagged is_demo=true and shown with a "Demo listing" badge.
 *
 * The demo seller's TESTNET secret is stored in .data/demo-sellers.json (git-ignored)
 * so `npm run demo:repay` can repay funded demo invoices and testers can claim.
 *
 * Usage: npm run demo:seed            (refuses to run against mainnet)
 */
import fs from "fs";
import path from "path";
import { Keypair, TransactionBuilder } from "@stellar/stellar-sdk";
import { getConfig } from "../backend/config.ts";
import { getDb } from "../backend/db/index.ts";
import { createInvoice } from "../backend/modules/invoices/service.ts";
import { prepareAction, submitSigned } from "../backend/modules/chain/service.ts";
import type { SessionUser } from "../backend/modules/auth/service.ts";

const config = getConfig();
if (config.stellar.network !== "testnet") throw new Error("demo:seed only runs on testnet.");
if (!config.FINTRIX_CONTRACT_ID) throw new Error("FINTRIX_CONTRACT_ID is not configured.");

const seller = Keypair.random();
const funded = await fetch(`${config.stellar.friendbotUrl}/?addr=${seller.publicKey()}`);
if (!funded.ok) throw new Error(`Friendbot failed: ${funded.status}`);

const db = await getDb();
const { rows } = await db.query<{ id: string }>(
  `INSERT INTO users (stellar_address, display_name) VALUES ($1, 'Demo Seller (testnet)') RETURNING id`,
  [seller.publicKey()],
);
const user: SessionUser = { id: rows[0].id, stellarAddress: seller.publicKey(), displayName: "Demo Seller (testnet)", role: "user", sessionId: "seed" };

const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
const demos = [
  { buyerName: "Demo Buyer: Harbor Freight Co (fictional)", total: 22, discountBps: 300, dueIn: 30 },
  { buyerName: "Demo Buyer: Alder Health Supplies (fictional)", total: 33, discountBps: 450, dueIn: 60 },
  { buyerName: "Demo Buyer: Quarry Lane Builders (fictional)", total: 55, discountBps: 600, dueIn: 90 },
];

for (const [index, demo] of demos.entries()) {
  const invoice = await createInvoice(user, {
    invoiceNumber: `DEMO-${Date.now().toString(36).toUpperCase()}-${index + 1}`,
    issuerName: "Demo Seller Ltd (fictional)",
    buyerName: demo.buyerName,
    buyerCountry: "US",
    currency: "USD",
    issueDate: day(-3),
    dueDate: day(demo.dueIn),
    total: demo.total,
    discountBps: demo.discountBps,
    lineItems: [],
    notes: "Demonstration listing created by `npm run demo:seed` on Stellar testnet. Not a real business.",
  });
  await db.query(`UPDATE invoices SET is_demo = true WHERE id = $1`, [invoice.id]);

  const prepared = await prepareAction(user, invoice.id, "create");
  const tx = TransactionBuilder.fromXDR(prepared.xdr, prepared.networkPassphrase);
  tx.sign(seller);
  const result = await submitSigned(user, prepared.transactionId, tx.toXDR());
  console.log(`${invoice.invoiceNumber}: ${result.status} ${result.explorerUrl ?? ""}`);
}

const store = path.resolve(process.cwd(), ".data", "demo-sellers.json");
const existing = fs.existsSync(store) ? JSON.parse(fs.readFileSync(store, "utf8")) : [];
fs.mkdirSync(path.dirname(store), { recursive: true });
fs.writeFileSync(store, JSON.stringify([...existing, { network: "testnet", publicKey: seller.publicKey(), secret: seller.secret() }], null, 2));
console.log(`Demo seller ${seller.publicKey()} saved to .data/demo-sellers.json (testnet only, git-ignored).`);
console.log("After funding a demo invoice from your wallet, run `npm run demo:repay` so you can claim it.");
await db.close();
// HTTP keep-alive sockets (Stellar RPC/Horizon) would otherwise keep the process open.
process.exit(0);
