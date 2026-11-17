import {
  Account,
  Address,
  Contract,
  Keypair,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  scValToNative,
  xdr,
  type FeeBumpTransaction,
  type Transaction,
} from "@stellar/stellar-sdk";
import { explorerTxUrl, getConfig } from "../../config";
import { HttpError } from "../../errors";
import { logger } from "../../logger";

/** Contract error codes (contracts/src/errors.rs) mapped to user-facing messages. */
export const CONTRACT_ERRORS: Record<number, string> = {
  1: "Invoice not found on-chain.",
  2: "Invalid amounts: price must be positive and repayment must be at least the price.",
  3: "Due date must be in the future.",
  4: "This invoice document is already financed or listed on-chain (duplicate).",
  5: "The invoice is not in the right state for this action.",
  6: "You cannot fund your own invoice.",
  7: "The invoice is past its due date and can no longer be funded.",
  8: "Only the investor who funded this invoice can do that.",
  9: "Only the seller can do that.",
  10: "The invoice is not yet past its due date.",
};

export type ChainStatus = "Listed" | "Funded" | "Repaid" | "Settled" | "Cancelled" | "Defaulted";

export interface ChainInvoice {
  id: string;
  seller: string;
  investor: string | null;
  price: string; // base units (stroops)
  repayment: string;
  dueDate: number;
  docHash: string;
  status: ChainStatus;
  createdAt: number;
  fundedAt: number;
  repaidAt: number;
}

let server: rpc.Server | null = null;

export function getRpc() {
  if (!server) {
    const { rpcUrl } = getConfig().stellar;
    server = new rpc.Server(rpcUrl, { allowHttp: rpcUrl.startsWith("http://") });
  }
  return server;
}

/** Test hook: inject a fake RPC server. */
export function setRpcForTests(fake: rpc.Server | null) {
  server = fake;
}

export function requireContract() {
  const config = getConfig();
  if (!config.FINTRIX_CONTRACT_ID || !config.SETTLEMENT_TOKEN_ID) {
    throw new HttpError(503, "On-chain features are unavailable: FINTRIX_CONTRACT_ID / SETTLEMENT_TOKEN_ID are not configured.");
  }
  return { contractId: config.FINTRIX_CONTRACT_ID, tokenId: config.SETTLEMENT_TOKEN_ID };
}

// --------------------------------------------------------------- amounts

const STROOPS_PER_UNIT = 10_000_000n;

/** "12.5" -> 125000000n (7 decimal places, exact). */
export function toBaseUnits(amount: string): bigint {
  if (!/^\d+(\.\d{1,7})?$/.test(amount)) throw new HttpError(400, `Invalid on-chain amount: ${amount}`);
  const [whole, fraction = ""] = amount.split(".");
  return BigInt(whole) * STROOPS_PER_UNIT + BigInt(fraction.padEnd(7, "0"));
}

/** 125000000n -> "12.5000000" */
export function fromBaseUnits(units: bigint | string | number): string {
  const value = BigInt(units);
  const whole = value / STROOPS_PER_UNIT;
  const fraction = (value % STROOPS_PER_UNIT).toString().padStart(7, "0");
  return `${whole}.${fraction}`;
}

/** USD cents -> settlement-asset amount string at the configured conversion rate (rounded down to 7 dp). */
export function usdCentsToAsset(cents: number): string {
  const rate = getConfig().USD_PER_XLM;
  // Work in integers: stroops = cents * 1e7 / (rate * 100). Round down so we never overcharge.
  const rateMicros = BigInt(Math.round(rate * 1_000_000));
  const stroops = (BigInt(cents) * STROOPS_PER_UNIT * 1_000_000n) / (rateMicros * 100n);
  return fromBaseUnits(stroops);
}

// --------------------------------------------------------------- errors

export function contractErrorCode(message: string): number | null {
  const match = /Error\(Contract, #(\d+)\)/.exec(message);
  return match ? Number(match[1]) : null;
}

export function explainSimulationError(message: string) {
  const code = contractErrorCode(message);
  if (code && CONTRACT_ERRORS[code]) return CONTRACT_ERRORS[code];
  if (/balance is not sufficient|insufficient|underfunded|#10\b.*token/i.test(message)) {
    return "Insufficient balance in the settlement asset for this transaction.";
  }
  if (/Account not found|MissingValue.*account/i.test(message)) {
    return "This wallet is not activated on the network yet. Fund it with Friendbot on testnet.";
  }
  return "The network rejected this transaction during simulation.";
}

// --------------------------------------------------------------- build / simulate

async function loadSourceAccount(address: string) {
  try {
    return await getRpc().getAccount(address);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/not found/i.test(message)) {
      const { network } = getConfig().stellar;
      throw new HttpError(
        400,
        network === "testnet"
          ? `Wallet ${address} is not activated on testnet. Fund it via https://friendbot.stellar.org/?addr=${address}`
          : `Wallet ${address} does not exist on ${network}.`,
      );
    }
    logger.warn({ err: message }, "rpc getAccount failed");
    throw new HttpError(502, "Could not reach Stellar RPC. Please retry.");
  }
}

export interface PreparedTx {
  xdr: string;
  hash: string;
  networkPassphrase: string;
  /** Unix seconds after which the network will reject the transaction. */
  maxTime: number;
}

/**
 * Builds a contract invocation with `source` as the transaction source, simulates it
 * (computing footprint, resource fees and auth) and returns the unsigned envelope.
 */
export async function prepareInvocation(source: string, method: string, args: xdr.ScVal[], timeoutSeconds = 300): Promise<PreparedTx> {
  const { contractId } = requireContract();
  const { passphrase } = getConfig().stellar;
  const account = await loadSourceAccount(source);

  const tx = new TransactionBuilder(account, { fee: "1000000", networkPassphrase: passphrase })
    .addOperation(new Contract(contractId).call(method, ...args))
    .setTimeout(timeoutSeconds)
    .build();

  let prepared: Transaction;
  try {
    prepared = (await getRpc().prepareTransaction(tx)) as Transaction;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.info({ method, err: message.slice(0, 400) }, "simulation rejected");
    throw new HttpError(400, explainSimulationError(message));
  }

  return {
    xdr: prepared.toXDR(),
    hash: Buffer.from(prepared.hash()).toString("hex"),
    networkPassphrase: passphrase,
    maxTime: Number(prepared.timeBounds?.maxTime ?? 0),
  };
}

/** Read-only contract call via simulation (no signature, no fee). */
export async function readContract<T>(method: string, args: xdr.ScVal[]): Promise<T> {
  const { contractId } = requireContract();
  const { passphrase } = getConfig().stellar;
  // Simulation does not need a real account; any well-formed source works for reads.
  const source = new Account(Keypair.random().publicKey(), "0");
  const tx = new TransactionBuilder(source, { fee: "100", networkPassphrase: passphrase })
    .addOperation(new Contract(contractId).call(method, ...args))
    .setTimeout(60)
    .build();
  const sim = await getRpc().simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) {
    throw new HttpError(400, explainSimulationError(sim.error));
  }
  if (!sim.result) throw new HttpError(502, "Contract read returned no result.");
  return scValToNative(sim.result.retval) as T;
}

interface RawChainInvoice {
  id: bigint;
  seller: string;
  investor?: string | null;
  price: bigint;
  repayment: bigint;
  due_date: bigint;
  doc_hash: Buffer | Uint8Array;
  status: [ChainStatus] | ChainStatus;
  created_at: bigint;
  funded_at: bigint;
  repaid_at: bigint;
}

export function normaliseChainInvoice(raw: RawChainInvoice): ChainInvoice {
  const status = Array.isArray(raw.status) ? raw.status[0] : raw.status;
  return {
    id: String(raw.id),
    seller: raw.seller,
    investor: raw.investor ?? null,
    price: String(raw.price),
    repayment: String(raw.repayment),
    dueDate: Number(raw.due_date),
    docHash: Buffer.from(raw.doc_hash).toString("hex"),
    status,
    createdAt: Number(raw.created_at),
    fundedAt: Number(raw.funded_at),
    repaidAt: Number(raw.repaid_at),
  };
}

export async function getChainInvoice(id: string | bigint): Promise<ChainInvoice> {
  const raw = await readContract<RawChainInvoice>("get_invoice", [nativeToScVal(BigInt(id), { type: "u64" })]);
  return normaliseChainInvoice(raw);
}

// --------------------------------------------------------------- argument helpers

export const scv = {
  address: (value: string) => new Address(value).toScVal(),
  u64: (value: bigint | number | string) => nativeToScVal(BigInt(value), { type: "u64" }),
  i128: (value: bigint) => nativeToScVal(value, { type: "i128" }),
  bytes32: (hex: string) => {
    if (!/^[0-9a-f]{64}$/.test(hex)) throw new HttpError(400, "Document hash must be 32 bytes of hex.");
    return xdr.ScVal.scvBytes(Buffer.from(hex, "hex"));
  },
};

// --------------------------------------------------------------- submit / confirm

export interface SubmitOutcome {
  status: "success" | "failed" | "pending";
  hash: string;
  ledger?: number;
  returnValue?: unknown;
  error?: string;
  explorerUrl: string;
}

/** Parses a signed envelope and enforces that it is exactly the transaction we prepared. */
export function parseSignedEnvelope(signedXdr: string, expectedHash: string) {
  const { passphrase } = getConfig().stellar;
  let tx: Transaction | FeeBumpTransaction;
  try {
    tx = TransactionBuilder.fromXDR(signedXdr, passphrase);
  } catch {
    throw new HttpError(400, "Signed transaction is not valid XDR for the configured network.");
  }
  const hash = Buffer.from(tx.hash()).toString("hex");
  if (hash !== expectedHash) {
    throw new HttpError(400, "Signed transaction does not match the transaction prepared by the server.");
  }
  if (tx.signatures.length === 0) throw new HttpError(400, "Transaction is not signed.");
  return tx;
}

/** Best-effort decode of a TransactionResult into its result code name (e.g. txFailed). */
function decodeResultError(resultXdr: unknown) {
  try {
    const result = (resultXdr as { result?: () => { switch?: () => { name?: string } } })?.result?.();
    const name = result?.switch?.()?.name;
    if (name) return `Transaction failed (${name}).`;
  } catch {
    // ignore
  }
  return "Transaction failed on-chain.";
}

/** Polls getTransaction until the network reports a final status or the wait budget runs out. */
export async function waitForTransaction(hash: string, maxWaitMs = 25_000): Promise<SubmitOutcome> {
  const deadline = Date.now() + maxWaitMs;
  let delay = 1000;
  while (true) {
    const result = await getRpc().getTransaction(hash);
    if (result.status === rpc.Api.GetTransactionStatus.SUCCESS) {
      return {
        status: "success",
        hash,
        ledger: result.ledger,
        returnValue: result.returnValue ? scValToNative(result.returnValue) : undefined,
        explorerUrl: explorerTxUrl(hash),
      };
    }
    if (result.status === rpc.Api.GetTransactionStatus.FAILED) {
      return { status: "failed", hash, ledger: result.ledger, error: decodeResultError(result.resultXdr), explorerUrl: explorerTxUrl(hash) };
    }
    if (Date.now() + delay > deadline) return { status: "pending", hash, explorerUrl: explorerTxUrl(hash) };
    await new Promise((resolve) => setTimeout(resolve, delay));
    delay = Math.min(delay * 1.5, 4000);
  }
}

export async function sendAndConfirm(tx: Transaction | FeeBumpTransaction, maxWaitMs?: number): Promise<SubmitOutcome> {
  const hash = Buffer.from(tx.hash()).toString("hex");
  let sent: rpc.Api.SendTransactionResponse;
  try {
    sent = await getRpc().sendTransaction(tx);
  } catch (error) {
    logger.warn({ err: error instanceof Error ? error.message : String(error) }, "rpc sendTransaction failed");
    throw new HttpError(502, "Could not reach Stellar RPC to submit. Please retry.");
  }

  if (sent.status === "ERROR") {
    const reason = sent.errorResult ? decodeResultError(sent.errorResult) : "Transaction rejected by the network.";
    return { status: "failed", hash, error: reason, explorerUrl: explorerTxUrl(hash) };
  }
  if (sent.status === "TRY_AGAIN_LATER") {
    throw new HttpError(503, "The network is busy. Please retry in a few seconds.");
  }
  // PENDING or DUPLICATE (already submitted): wait for the final result.
  return waitForTransaction(hash, maxWaitMs);
}
