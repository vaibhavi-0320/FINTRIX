import { Asset, BASE_FEE, Horizon, Memo, Operation, TransactionBuilder } from "@stellar/stellar-sdk";
import { explorerTxUrl, getConfig } from "../../config";
import { getDb, type Queryable } from "../../db";
import { HttpError } from "../../errors";
import { audit } from "../../audit";
import { logger } from "../../logger";
import type { SessionUser } from "../auth/service";
import { computeTerms, getInvoice, getInvoiceForViewer, type InvoiceRow, type InvoiceStatus } from "../invoices/service";
import {
  fromBaseUnits,
  getChainInvoice,
  getRpc,
  parseSignedEnvelope,
  prepareInvocation,
  requireContract,
  scv,
  sendAndConfirm,
  toBaseUnits,
  usdCentsToAsset,
  waitForTransaction,
  type ChainInvoice,
  type ChainStatus,
  type SubmitOutcome,
} from "./soroban";

export type ChainAction = "create" | "fund" | "repay" | "claim" | "cancel" | "default" | "simulation";

const STATUS_MAP: Record<ChainStatus, InvoiceStatus> = {
  Listed: "listed",
  Funded: "funded",
  Repaid: "repaid",
  Settled: "settled",
  Cancelled: "cancelled",
  Defaulted: "defaulted",
};

function endOfDayUnix(isoDate: string) {
  return Math.floor(Date.parse(`${isoDate}T23:59:59Z`) / 1000);
}

/** Builds the unsigned transaction for an invoice action after checking the caller may perform it. */
export async function prepareAction(user: SessionUser, invoiceId: string, action: Exclude<ChainAction, "simulation">) {
  const { contractId } = requireContract();
  const db = await getDb();
  const row = await getInvoiceForViewer(invoiceId, user, db);
  const dto = await getInvoice(invoiceId, user);
  const config = getConfig();

  let method: string;
  let args;
  let amount: string | null = null;

  switch (action) {
    case "create": {
      if (!dto.actions.list) {
        if (row.currency !== "USD") throw new HttpError(400, "Only USD invoices can be listed (no FX conversion is performed).");
        throw new HttpError(409, "This invoice cannot be listed (it must be your draft and not past due).");
      }
      if (!row.document_hash) throw new HttpError(400, "Invoice has no document fingerprint.");
      const terms = computeTerms(row.total_cents, row.discount_bps);
      const price = usdCentsToAsset(terms.priceCents);
      const repayment = usdCentsToAsset(terms.repaymentCents);
      if (toBaseUnits(price) <= 0n) throw new HttpError(400, "Invoice value is too small to list.");
      method = "create_invoice";
      args = [scv.address(user.stellarAddress), scv.i128(toBaseUnits(price)), scv.i128(toBaseUnits(repayment)), scv.u64(endOfDayUnix(row.due_date)), scv.bytes32(row.document_hash)];
      amount = price;
      // Persist the quoted on-chain terms so the UI shows exactly what was signed.
      await db.query(`UPDATE invoices SET price_amount = $2, repayment_amount = $3 WHERE id = $1`, [row.id, price, repayment]);
      break;
    }
    case "fund":
      if (!dto.actions.fund) throw new HttpError(409, "This invoice is not open for funding by you.");
      method = "fund_invoice";
      args = [scv.u64(row.chain_invoice_id!), scv.address(user.stellarAddress)];
      amount = row.price_amount;
      break;
    case "repay":
      if (!dto.actions.repay) throw new HttpError(409, "Only the seller can repay a funded invoice.");
      method = "repay_invoice";
      args = [scv.u64(row.chain_invoice_id!), scv.address(user.stellarAddress)];
      amount = row.repayment_amount;
      break;
    case "claim":
      if (!dto.actions.claim) throw new HttpError(409, "Only the investor can claim a repaid invoice.");
      method = "claim";
      args = [scv.u64(row.chain_invoice_id!)];
      amount = row.repayment_amount;
      break;
    case "cancel":
      if (!dto.actions.cancel) throw new HttpError(409, "Only the seller can cancel a listed, unfunded invoice.");
      method = "cancel_invoice";
      args = [scv.u64(row.chain_invoice_id!)];
      break;
    case "default":
      if (!dto.actions.markDefaulted) throw new HttpError(409, "Only the investor can mark an overdue funded invoice as defaulted.");
      method = "mark_defaulted";
      args = [scv.u64(row.chain_invoice_id!)];
      break;
  }

  const prepared = await prepareInvocation(user.stellarAddress, method, args);
  const expiresAt = new Date((prepared.maxTime || Math.floor(Date.now() / 1000) + 300) * 1000);
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO chain_transactions (user_id, invoice_id, kind, network, tx_hash, amount, asset, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
    [user.id, row.id, action, config.stellar.network, prepared.hash, amount, row.settlement_asset, expiresAt],
  );

  return {
    transactionId: rows[0].id,
    xdr: prepared.xdr,
    hash: prepared.hash,
    networkPassphrase: prepared.networkPassphrase,
    expiresAt: expiresAt.toISOString(),
    summary: {
      action,
      contractId,
      method,
      amount,
      asset: row.settlement_asset,
      invoiceNumber: row.invoice_number,
    },
  };
}

/**
 * "Simulate on testnet" (Simulation page): a 1 XLM payment to the user's own account whose
 * memo references the deal. It proves wallet signing on-chain and records the projected
 * return; no funds go to anyone else and nothing is invested.
 */
export async function prepareSimulation(user: SessionUser, input: { invoiceId: string; amountUSD: number; expectedReturn: number; maturityDate: string }) {
  const config = getConfig();
  const db = await getDb();
  const row = await getInvoiceForViewer(input.invoiceId, user, db);
  let account;
  try {
    account = await getRpc().getAccount(user.stellarAddress);
  } catch {
    throw new HttpError(400, `Wallet ${user.stellarAddress} is not activated on testnet. Fund it via ${config.stellar.friendbotUrl}/?addr=${user.stellarAddress}`);
  }
  const tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: config.stellar.passphrase })
    .addOperation(Operation.payment({ destination: user.stellarAddress, asset: Asset.native(), amount: "1" }))
    .addMemo(Memo.text(`SIM:${row.invoice_number}`.slice(0, 28)))
    .setTimeout(300)
    .build();
  const hash = Buffer.from(tx.hash()).toString("hex");
  const expiresAt = new Date(Number(tx.timeBounds?.maxTime ?? Math.floor(Date.now() / 1000) + 300) * 1000);
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO chain_transactions (user_id, invoice_id, kind, network, tx_hash, amount, asset, result, expires_at)
     VALUES ($1, $2, 'simulation', $3, $4, '1.0000000', 'XLM', $5, $6) RETURNING id`,
    [user.id, row.id, config.stellar.network, hash, JSON.stringify({ simulation: { company: row.buyer_name, amountUSD: input.amountUSD, expectedReturn: input.expectedReturn, maturityDate: input.maturityDate } }), expiresAt],
  );
  return { transactionId: rows[0].id, xdr: tx.toXDR(), hash, networkPassphrase: config.stellar.passphrase, expiresAt: expiresAt.toISOString() };
}

interface ChainTxRow {
  id: string;
  user_id: string;
  invoice_id: string | null;
  kind: ChainAction;
  tx_hash: string;
  status: "prepared" | "submitted" | "success" | "failed" | "expired";
  expires_at: Date;
  amount: string | null;
  asset: string | null;
  ledger: number | null;
  error: string | null;
  result: { simulation?: Record<string, unknown> } | null;
  created_at: Date;
  confirmed_at: Date | null;
}

async function loadTx(db: Queryable, user: SessionUser, transactionId: string) {
  if (!/^[0-9a-f-]{36}$/i.test(transactionId)) throw new HttpError(404, "Transaction not found.");
  const { rows } = await db.query<ChainTxRow>(`SELECT * FROM chain_transactions WHERE id = $1 AND user_id = $2`, [transactionId, user.id]);
  if (!rows[0]) throw new HttpError(404, "Transaction not found.");
  return rows[0];
}

async function userIdForAddress(db: Queryable, address: string | null) {
  if (!address) return null;
  const { rows } = await db.query<{ id: string }>(`SELECT id FROM users WHERE stellar_address = $1`, [address]);
  return rows[0]?.id ?? null;
}

/** Mirrors the contract's state for one invoice into the database. The chain is the source of truth. */
export async function syncInvoiceFromChain(db: Queryable, invoiceId: string, chain: ChainInvoice) {
  const { contractId } = requireContract();
  const status = STATUS_MAP[chain.status];
  const investorId = await userIdForAddress(db, chain.investor);
  const ts = (seconds: number) => (seconds > 0 ? new Date(seconds * 1000) : null);
  await db.query(
    `UPDATE invoices SET
        status = $2, contract_id = $3, chain_invoice_id = $4, investor_id = $5,
        price_amount = $6, repayment_amount = $7,
        listed_at = COALESCE(listed_at, $8), funded_at = COALESCE($9, funded_at), repaid_at = COALESCE($10, repaid_at),
        settled_at = CASE WHEN $2 = 'settled' THEN COALESCE(settled_at, now()) ELSE settled_at END,
        updated_at = now()
      WHERE id = $1`,
    [invoiceId, status, contractId, chain.id, investorId, fromBaseUnits(chain.price), fromBaseUnits(chain.repayment), ts(chain.createdAt), ts(chain.fundedAt), ts(chain.repaidAt)],
  );
}

async function applyOutcome(db: Queryable, tx: ChainTxRow, outcome: SubmitOutcome) {
  if (outcome.status === "pending") {
    await db.query(`UPDATE chain_transactions SET status = 'submitted', submitted_at = COALESCE(submitted_at, now()) WHERE id = $1`, [tx.id]);
    return;
  }
  if (outcome.status === "failed") {
    await db.query(`UPDATE chain_transactions SET status = 'failed', ledger = $2, error = $3, confirmed_at = now() WHERE id = $1`, [
      tx.id,
      outcome.ledger ?? null,
      outcome.error ?? "failed",
    ]);
    return;
  }

  await db.query(
    `UPDATE chain_transactions SET status = 'success', ledger = $2, result = COALESCE(result, '{}'::jsonb) || $3::jsonb, confirmed_at = now() WHERE id = $1`,
    [tx.id, outcome.ledger ?? null, JSON.stringify({ returnValue: outcome.returnValue === undefined ? null : String(outcome.returnValue) })],
  );

  if (!tx.invoice_id || tx.kind === "simulation") return;
  let chainId: string | null = null;
  if (tx.kind === "create") {
    chainId = String(outcome.returnValue);
  } else {
    const { rows } = await db.query<{ chain_invoice_id: string | null }>(`SELECT chain_invoice_id FROM invoices WHERE id = $1`, [tx.invoice_id]);
    chainId = rows[0]?.chain_invoice_id ?? null;
  }
  if (!chainId || !/^\d+$/.test(chainId)) {
    logger.error({ txId: tx.id }, "confirmed transaction has no chain invoice id");
    return;
  }
  // Re-read the contract rather than assuming the effect of the call.
  const chain = await getChainInvoice(chainId);
  await syncInvoiceFromChain(db, tx.invoice_id, chain);
  await audit(db, tx.user_id, `chain.${tx.kind}`, "invoice", tx.invoice_id, { txHash: tx.tx_hash, chainStatus: chain.status });
}

/**
 * Accepts the user's signed envelope for a prepared transaction, submits it and waits
 * for the network's verdict. Success is only reported after on-chain confirmation.
 */
export async function submitSigned(user: SessionUser, transactionId: string, signedXdr: string) {
  const db = await getDb();
  const tx = await loadTx(db, user, transactionId);
  if (tx.status === "success" || tx.status === "failed") return describeTx(tx, user);
  if (tx.status === "submitted") return refreshTransaction(user, transactionId);
  if (new Date(tx.expires_at).getTime() < Date.now()) {
    await db.query(`UPDATE chain_transactions SET status = 'expired' WHERE id = $1`, [tx.id]);
    throw new HttpError(410, "This transaction expired before it was signed. Start the action again.");
  }

  const envelope = parseSignedEnvelope(signedXdr, tx.tx_hash);
  await db.query(`UPDATE chain_transactions SET status = 'submitted', submitted_at = now() WHERE id = $1`, [tx.id]);
  const outcome = await sendAndConfirm(envelope);
  await applyOutcome(db, tx, outcome);
  return describeTx(await loadTx(db, user, transactionId), user, outcome.error);
}

/** Re-checks a submitted transaction (used when the first wait timed out). */
export async function refreshTransaction(user: SessionUser, transactionId: string) {
  const db = await getDb();
  const tx = await loadTx(db, user, transactionId);
  if (tx.status === "submitted") {
    const outcome = await waitForTransaction(tx.tx_hash, 8_000);
    await applyOutcome(db, tx, outcome);
  }
  return describeTx(await loadTx(db, user, transactionId), user);
}

async function describeTx(tx: ChainTxRow, user: SessionUser, error?: string) {
  return {
    id: tx.id,
    kind: tx.kind,
    status: tx.status,
    hash: tx.tx_hash,
    ledger: tx.ledger,
    amount: tx.amount,
    asset: tx.asset,
    error: tx.error ?? error ?? null,
    explorerUrl: tx.status === "prepared" || tx.status === "expired" ? null : explorerTxUrl(tx.tx_hash),
    invoice: tx.invoice_id ? await getInvoice(tx.invoice_id, user).catch(() => null) : null,
    createdAt: new Date(tx.created_at).toISOString(),
    confirmedAt: tx.confirmed_at ? new Date(tx.confirmed_at).toISOString() : null,
  };
}

export async function listTransactions(user: SessionUser, limit = 50) {
  const db = await getDb();
  const { rows } = await db.query<ChainTxRow & { invoice_number: string | null }>(
    `SELECT c.*, i.invoice_number FROM chain_transactions c LEFT JOIN invoices i ON i.id = c.invoice_id
      WHERE c.user_id = $1 AND c.status <> 'prepared' ORDER BY c.created_at DESC LIMIT $2`,
    [user.id, limit],
  );
  return rows.map((tx) => ({
    id: tx.id,
    kind: tx.kind,
    status: tx.status,
    hash: tx.tx_hash,
    ledger: tx.ledger,
    amount: tx.amount,
    asset: tx.asset,
    error: tx.error,
    simulation: tx.result?.simulation ?? null,
    invoiceId: tx.invoice_id,
    invoiceNumber: tx.invoice_number,
    explorerUrl: explorerTxUrl(tx.tx_hash),
    createdAt: new Date(tx.created_at).toISOString(),
    confirmedAt: tx.confirmed_at ? new Date(tx.confirmed_at).toISOString() : null,
  }));
}

/** Re-reads the contract for an invoice and updates the database (manual reconciliation). */
export async function reconcileInvoice(user: SessionUser, invoiceId: string) {
  const db = await getDb();
  const row: InvoiceRow = await getInvoiceForViewer(invoiceId, user, db);
  if (!row.chain_invoice_id) return getInvoice(invoiceId, user);
  const chain = await getChainInvoice(row.chain_invoice_id);
  await syncInvoiceFromChain(db, invoiceId, chain);
  return { invoice: await getInvoice(invoiceId, user), chain };
}

// --------------------------------------------------------------- account data (Horizon)

let horizon: Horizon.Server | null = null;
function getHorizon() {
  horizon ??= new Horizon.Server(getConfig().stellar.horizonUrl);
  return horizon;
}

export async function accountOverview(address: string) {
  const { network, friendbotUrl } = getConfig().stellar;
  try {
    const account = await getHorizon().loadAccount(address);
    const balances = account.balances.map((balance) => ({
      asset: balance.asset_type === "native" ? "XLM" : `${"asset_code" in balance ? balance.asset_code : balance.asset_type}`,
      balance: balance.balance,
    }));
    return { address, network, exists: true, balances, friendbotUrl: network === "testnet" ? `${friendbotUrl}/?addr=${address}` : null };
  } catch (error) {
    if ((error as { response?: { status?: number } })?.response?.status === 404) {
      return { address, network, exists: false, balances: [], friendbotUrl: network === "testnet" ? `${friendbotUrl}/?addr=${address}` : null };
    }
    throw new HttpError(502, "Could not load account from Stellar Horizon.");
  }
}

/** Recent on-chain operations for the wallet, straight from Horizon (includes activity outside Fintrix). */
export async function accountActivity(address: string, limit = 20) {
  try {
    const page = await getHorizon().operations().forAccount(address).order("desc").limit(limit).call();
    return page.records.map((op) => ({
      id: op.id,
      type: op.type,
      createdAt: op.created_at,
      txHash: op.transaction_hash,
      successful: op.transaction_successful,
      explorerUrl: explorerTxUrl(op.transaction_hash),
      detail:
        op.type === "payment"
          ? { from: op.from, to: op.to, amount: op.amount, asset: op.asset_type === "native" ? "XLM" : op.asset_code }
          : op.type === "invoke_host_function"
            ? { function: op.function }
            : null,
    }));
  } catch (error) {
    if ((error as { response?: { status?: number } })?.response?.status === 404) return [];
    throw new HttpError(502, "Could not load activity from Stellar Horizon.");
  }
}
