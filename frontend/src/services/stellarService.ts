/**
 * Data and blockchain layer for the Fintrix UI. Every function talks to the Fintrix API
 * (Postgres + Soroban escrow contract). Nothing is stored in localStorage and nothing is
 * simulated: success is only returned after the Stellar network confirms a transaction.
 */
import { api, ApiError } from "../lib/api";
import { getWallet, WalletError, type WalletKind } from "../lib/wallet";
import type { ApiInvoice, ChainAction, ChainResult, ConnectedWallet, Invoice, InvoiceStatus, WalletProvider } from "../types";

// ------------------------------------------------------------------ helpers

const STATUS_MAP: Record<ApiInvoice["status"], InvoiceStatus> = {
  draft: "draft",
  listed: "active",
  funded: "funded",
  repaid: "repaid",
  settled: "settled",
  cancelled: "cancelled",
  defaulted: "defaulted",
};

/** Maps an API invoice to the shape the original UI components render. */
export function toUiInvoice(dto: ApiInvoice): Invoice {
  const status = STATUS_MAP[dto.status];
  const funded = ["funded", "repaid", "settled", "defaulted"].includes(dto.status) ? dto.terms.price : 0;
  return {
    id: dto.id,
    buyer: dto.buyerName,
    amount: dto.total,
    discount: dto.discountBps / 100,
    due: dto.dueDate,
    status,
    seller: dto.seller.address,
    funder: dto.investor?.address,
    yield: Number((dto.terms.annualisedYield * 100).toFixed(1)),
    funded,
    tags: [dto.isDemo ? "Demo listing" : "On-chain", ...(dto.duplicateFlags.length ? ["Duplicate warning"] : [])],
    // Original UI scale: 0–100, lower is safer. Here: modelled probability of late payment.
    riskScore: dto.risk ? Math.round(dto.risk.score * 100) : 50,
    aiSummary: dto.notes ?? "",
    txHash: dto.chain.lastTxHash ?? undefined,
    companyName: dto.buyerName,
    industry: dto.issuerName,
    country: dto.buyerCountry ?? "",
    dto,
  };
}

function walletKind(provider: WalletProvider): WalletKind {
  return provider === "albedo" ? "albedo" : "freighter";
}

interface SessionUser {
  id: string;
  stellarAddress: string;
  displayName: string | null;
}

const LAST_PROVIDER_KEY = "fintrix_wallet_provider";

function rememberProvider(provider: WalletProvider) {
  try {
    localStorage.setItem(LAST_PROVIDER_KEY, provider);
  } catch {
    // storage unavailable: only affects which wallet signs after a reload
  }
}

function lastProvider(): WalletProvider {
  try {
    return localStorage.getItem(LAST_PROVIDER_KEY) === "albedo" ? "albedo" : "freighter";
  } catch {
    return "freighter";
  }
}

function toWallet(user: SessionUser, provider: WalletProvider): ConnectedWallet {
  return { publicKey: user.stellarAddress, provider, label: provider === "albedo" ? "Albedo" : "Freighter" };
}

// ------------------------------------------------------------------ session

/**
 * Signs in with the chosen wallet: the server issues a one-time challenge, the wallet
 * signs it (the user approves in the wallet), and the server verifies it and starts a session.
 * `address` is the account the wallet screen already connected.
 */
export async function signInWithWallet(provider: WalletProvider, address?: string): Promise<ConnectedWallet> {
  const wallet = getWallet(walletKind(provider));
  const account = address ?? (await wallet.connect());
  const challenge = await api<{ nonce: string; message: string }>("/api/auth/challenge", { body: { address: account } });
  const signed = await wallet.signMessage(challenge.message, account);
  const result = await api<{ user: SessionUser }>("/api/auth/verify", {
    body: { address: account, nonce: challenge.nonce, signature: signed.signature, ...(signed.signedMessage ? { signedMessage: signed.signedMessage } : {}) },
  });
  rememberProvider(provider);
  return toWallet(result.user, provider);
}

/** Restores an existing session after a page reload. */
export async function restoreSession(): Promise<ConnectedWallet | null> {
  try {
    const session = await api<{ user: SessionUser | null }>("/api/auth/session");
    return session.user ? toWallet(session.user, lastProvider()) : null;
  } catch {
    return null;
  }
}

export async function signOut() {
  await api("/api/auth/logout", { method: "POST" }).catch(() => undefined);
}

// Kept for the original screens: connecting = signing in.
export const connectFreighterWallet = () => signInWithWallet("freighter");
export const connectManualWallet = (provider: WalletProvider, publicKey?: string) => signInWithWallet(provider, publicKey);

// ------------------------------------------------------------------ account

/** Native XLM balance from Horizon (0 when the account is not activated yet). */
export async function getAccountBalance(_publicKey?: string): Promise<number> {
  const account = await api<{ exists: boolean; balances: Array<{ asset: string; balance: string }> }>("/api/chain/account");
  const native = account.balances.find((balance) => balance.asset === "XLM");
  return native ? Number(native.balance) : 0;
}

export async function getAccount() {
  return api<{ address: string; network: string; exists: boolean; balances: Array<{ asset: string; balance: string }>; friendbotUrl: string | null }>("/api/chain/account");
}

// ------------------------------------------------------------------ invoices

/** All invoices visible to the user: on-chain listings plus their own drafts. */
export async function getInvoices(): Promise<Invoice[]> {
  const page = await api<{ items: ApiInvoice[] }>("/api/invoices?scope=all&limit=100");
  return page.items.map(toUiInvoice);
}

export async function getInvoice(id: string): Promise<Invoice> {
  return toUiInvoice(await api<ApiInvoice>(`/api/invoices/${id}`));
}

export interface ChainActionResult {
  txHash: string;
  explorerUrl: string;
  ledger: number | null;
  invoice: Invoice | null;
}

/**
 * Runs an on-chain invoice action: the server prepares and simulates the transaction,
 * the wallet asks the user to approve it, the server checks it is the exact prepared
 * transaction, submits it and waits for the network to confirm.
 */
export async function runChainAction(invoiceId: string, action: ChainAction, wallet: ConnectedWallet): Promise<ChainActionResult> {
  const prepared = await api<{ transactionId: string; xdr: string; networkPassphrase: string }>(`/api/invoices/${invoiceId}/actions/${action}`, { method: "POST" });
  const signedXdr = await getWallet(walletKind(wallet.provider)).signTransaction(prepared.xdr, { networkPassphrase: prepared.networkPassphrase, address: wallet.publicKey });
  return confirm(prepared.transactionId, signedXdr);
}

async function confirm(transactionId: string, signedXdr: string): Promise<ChainActionResult> {
  let result = await api<ChainResult>(`/api/chain/transactions/${transactionId}/submit`, { body: { signedXdr } });
  for (let attempt = 0; attempt < 6 && result.status === "submitted"; attempt++) {
    result = await api<ChainResult>(`/api/chain/transactions/${transactionId}`);
  }
  if (result.status === "submitted") {
    throw new Error(`The network has not confirmed transaction ${result.hash.slice(0, 10)}… yet. It is not marked as successful; check Dashboard → activity shortly.`);
  }
  if (result.status !== "success") throw new Error(result.error ?? "The transaction failed on-chain.");
  return { txHash: result.hash, explorerUrl: result.explorerUrl ?? "", ledger: result.ledger, invoice: result.invoice ? toUiInvoice(result.invoice) : null };
}

/** Funds a listed invoice in full (the contract funds the whole price in one transaction). */
export async function fundInvoiceOnBackend(invoiceId: string, wallet: ConnectedWallet): Promise<Invoice & { txHash: string; explorerUrl: string }> {
  const result = await runChainAction(invoiceId, "fund", wallet);
  const invoice = result.invoice ?? (await getInvoice(invoiceId));
  return { ...invoice, txHash: result.txHash, explorerUrl: result.explorerUrl };
}

export async function repayInvoiceOnBackend(invoiceId: string, wallet: ConnectedWallet): Promise<Invoice & { txHash: string; explorerUrl: string }> {
  const result = await runChainAction(invoiceId, "repay", wallet);
  const invoice = result.invoice ?? (await getInvoice(invoiceId));
  return { ...invoice, txHash: result.txHash, explorerUrl: result.explorerUrl };
}

/**
 * "Simulate on Testnet": signs a 1 XLM payment to the user's own account with a memo
 * referencing the deal, recording the projected return on-chain. No investment is made.
 */
export async function simulateOnTestnet(wallet: ConnectedWallet, deal: { id: string; company: string }, amountUSD: number, expectedReturn: number, maturityDate: string) {
  const prepared = await api<{ transactionId: string; xdr: string; networkPassphrase: string }>("/api/chain/simulations", {
    body: { invoiceId: deal.id, amountUSD, expectedReturn, maturityDate },
  });
  const signedXdr = await getWallet(walletKind(wallet.provider)).signTransaction(prepared.xdr, { networkPassphrase: prepared.networkPassphrase, address: wallet.publicKey });
  const result = await confirm(prepared.transactionId, signedXdr);
  return {
    simId: `SIM-${result.txHash.slice(0, 10).toUpperCase()}`,
    txHash: result.txHash,
    explorerUrl: result.explorerUrl,
    amountUSD,
    expectedReturn,
    maturityDate,
    company: deal.company,
  };
}

// ------------------------------------------------------------------ activity

export interface ChainTxRecord {
  id: string;
  kind: ChainAction | "simulation";
  status: string;
  hash: string;
  ledger: number | null;
  amount: string | null;
  asset: string | null;
  error: string | null;
  invoiceId: string | null;
  invoiceNumber: string | null;
  explorerUrl: string;
  simulation: { company?: string; amountUSD?: number; expectedReturn?: number; maturityDate?: string } | null;
  createdAt: string;
  confirmedAt: string | null;
}

export async function getTransactions(): Promise<ChainTxRecord[]> {
  return api<ChainTxRecord[]>("/api/chain/transactions");
}

// ------------------------------------------------------------------ documents

export interface ExtractedFields {
  invoiceNumber: string | null;
  issueDate: string | null;
  dueDate: string | null;
  issuer: { name: string | null; address: string | null; taxId: string | null };
  recipient: { name: string | null; address: string | null; taxId: string | null };
  currency: string | null;
  subtotal: number | null;
  tax: number | null;
  total: number | null;
  lineItems: Array<{ description: string; quantity: number | null; unitPrice: number | null; amount: number | null }>;
}

export interface UploadResult {
  document: { id: string; filename: string; mimeType: string; sizeBytes: number; sha256: string };
  extraction: {
    id: string;
    engine: string;
    status: "succeeded" | "failed";
    fields: ExtractedFields | null;
    confidence: Record<string, number>;
    issues: Array<{ field: string; severity: "error" | "warning"; message: string }>;
    error: string | null;
  } | null;
  alreadyRegistered: Array<{ yours: boolean; status: string }>;
}

export async function uploadInvoiceDocument(file: File): Promise<UploadResult> {
  const form = new FormData();
  form.append("file", file);
  return api<UploadResult>("/api/documents", { body: form });
}

/**
 * Saves the user-reviewed fields, creates the invoice from them and lists it on-chain
 * (the wallet asks for approval). Extracted data is never used without this review.
 */
export async function confirmAndListInvoice(extractionId: string, fields: ExtractedFields, discountBps: number, wallet: ConnectedWallet) {
  await api(`/api/extractions/${extractionId}/review`, { method: "PUT", body: { fields } });
  const invoice = await api<ApiInvoice>(`/api/extractions/${extractionId}/invoice`, { body: { discountBps } });
  try {
    const listed = await runChainAction(invoice.id, "create", wallet);
    return { invoice: listed.invoice ?? toUiInvoice(invoice), txHash: listed.txHash, explorerUrl: listed.explorerUrl };
  } catch (error) {
    // The draft exists even if listing was declined or failed; surface why.
    const reason = error instanceof WalletError || error instanceof ApiError ? error.message : String((error as Error)?.message ?? error);
    throw new Error(`Invoice saved as a draft, but listing on-chain did not complete: ${reason}`);
  }
}
