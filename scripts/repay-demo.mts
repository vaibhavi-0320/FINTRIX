/**
 * Repays every funded DEMO invoice using the testnet demo seller keys saved by
 * `npm run demo:seed`, so testers who funded a demo listing can claim it.
 * Usage: npm run demo:repay
 */
import fs from "fs";
import path from "path";
import { Keypair, TransactionBuilder } from "@stellar/stellar-sdk";
import { getConfig } from "../backend/config.ts";
import { getDb } from "../backend/db/index.ts";
import { prepareAction, submitSigned } from "../backend/modules/chain/service.ts";
import type { SessionUser } from "../backend/modules/auth/service.ts";

if (getConfig().stellar.network !== "testnet") throw new Error("demo:repay only runs on testnet.");
const store = path.resolve(process.cwd(), ".data", "demo-sellers.json");
if (!fs.existsSync(store)) throw new Error("No demo sellers found. Run `npm run demo:seed` first.");
const sellers: Array<{ publicKey: string; secret: string }> = JSON.parse(fs.readFileSync(store, "utf8"));

const db = await getDb();
let repaid = 0;
for (const entry of sellers) {
  const keypair = Keypair.fromSecret(entry.secret);
  const { rows: users } = await db.query<{ id: string; display_name: string | null }>(`SELECT id, display_name FROM users WHERE stellar_address = $1`, [keypair.publicKey()]);
  if (!users[0]) continue;
  const user: SessionUser = { id: users[0].id, stellarAddress: keypair.publicKey(), displayName: users[0].display_name, role: "user", sessionId: "seed" };
  const { rows } = await db.query<{ id: string; invoice_number: string }>(
    `SELECT id, invoice_number FROM invoices WHERE seller_id = $1 AND is_demo AND status IN ('funded', 'defaulted')`,
    [user.id],
  );
  for (const invoice of rows) {
    const prepared = await prepareAction(user, invoice.id, "repay");
    const tx = TransactionBuilder.fromXDR(prepared.xdr, prepared.networkPassphrase);
    tx.sign(keypair);
    const result = await submitSigned(user, prepared.transactionId, tx.toXDR());
    console.log(`${invoice.invoice_number}: repay ${result.status} ${result.explorerUrl ?? ""}`);
    repaid++;
  }
}
console.log(repaid ? `Repaid ${repaid} demo invoice(s). Investors can now claim them.` : "No funded demo invoices to repay.");
await db.close();
// HTTP keep-alive sockets (Stellar RPC/Horizon) would otherwise keep the process open.
process.exit(0);
