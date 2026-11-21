import { getAddress, getNetworkDetails, isAllowed, isConnected, requestAccess, signMessage, signTransaction } from "@stellar/freighter-api";
import albedo from "@albedo-link/intent";
import { STELLAR } from "../config";

export type WalletKind = "freighter" | "albedo";

/** A signed sign-in message. Albedo also returns the exact bytes it signed. */
export interface SignedMessage {
  signature: string;
  signedMessage?: string;
}

/**
 * Wallet abstraction. Production uses Freighter or Albedo. The E2E build
 * (VITE_E2E_WALLET=true) can use a test signer injected by Playwright; in normal builds
 * that branch is removed at compile time, so it cannot be activated in production.
 */
export interface Wallet {
  readonly name: string;
  connect(): Promise<string>;
  signMessage(message: string, address: string): Promise<SignedMessage>;
  signTransaction(xdr: string, options: { networkPassphrase: string; address: string }): Promise<string>;
}

export class WalletError extends Error {
  code: "not_installed" | "rejected" | "wrong_network" | "failed";
  constructor(code: WalletError["code"], message: string) {
    super(message);
    this.code = code;
  }
}

function describeError(error: unknown, wallet: string, action: string): WalletError {
  const message = typeof error === "string" ? error : (error as { message?: string })?.message ?? String(error);
  if (/declin|reject|cancel|denied|closed/i.test(message)) return new WalletError("rejected", `You declined the ${action} in ${wallet}. Nothing was sent.`);
  return new WalletError("failed", `${wallet} could not complete the ${action}: ${message}`);
}

async function ensureFreighterNetwork() {
  const details = await getNetworkDetails();
  if (details.error) throw describeError(details.error, "Freighter", "network check");
  if (details.networkPassphrase !== STELLAR.passphrase) {
    throw new WalletError("wrong_network", `Freighter is on ${details.network || "another network"}. Switch Freighter to ${STELLAR.label} and try again.`);
  }
}

/** Freighter returns base64 strings (v4+) or a Buffer (v3); normalise to base64. */
function signatureToBase64(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Uint8Array) {
    let binary = "";
    value.forEach((byte) => (binary += String.fromCharCode(byte)));
    return btoa(binary);
  }
  if (value && typeof value === "object" && Array.isArray((value as { data?: unknown }).data)) {
    return signatureToBase64(Uint8Array.from((value as { data: number[] }).data));
  }
  throw new WalletError("failed", "The wallet returned an unrecognised signature.");
}

export const freighterWallet: Wallet = {
  name: "Freighter",
  async connect() {
    const status = await isConnected();
    if (status.error || !status.isConnected) {
      throw new WalletError("not_installed", "Freighter is not installed. Install it from freighter.app, then reload this page.");
    }
    const allowed = await isAllowed();
    const access = allowed.isAllowed ? await getAddress() : await requestAccess();
    if (access.error || !access.address) {
      if (access.error) throw describeError(access.error, "Freighter", "connection request");
      throw new WalletError("failed", "Freighter did not share an address. Unlock Freighter and allow this site.");
    }
    await ensureFreighterNetwork();
    return access.address;
  },
  async signMessage(message, address) {
    await ensureFreighterNetwork();
    const result = await signMessage(message, { address, networkPassphrase: STELLAR.passphrase });
    if (result.error) throw describeError(result.error, "Freighter", "sign-in signature");
    if (result.signerAddress && result.signerAddress !== address) {
      throw new WalletError("failed", "Freighter signed with a different account. Select the connected account in Freighter.");
    }
    if (!result.signedMessage) throw new WalletError("failed", "Freighter returned no signature.");
    return { signature: signatureToBase64(result.signedMessage) };
  },
  async signTransaction(xdr, { networkPassphrase, address }) {
    if (networkPassphrase !== STELLAR.passphrase) throw new WalletError("wrong_network", "Server and app use different networks. Refusing to sign.");
    await ensureFreighterNetwork();
    const result = await signTransaction(xdr, { networkPassphrase, address });
    if (result.error) throw describeError(result.error, "Freighter", "transaction");
    if (result.signerAddress && result.signerAddress !== address) throw new WalletError("failed", "Freighter signed with a different account.");
    if (!result.signedTxXdr) throw new WalletError("failed", "Freighter returned no signed transaction.");
    return result.signedTxXdr;
  },
};

/** Albedo (web wallet, popup based) via the official @albedo-link/intent library. */
export const albedoWallet: Wallet = {
  name: "Albedo",
  async connect() {
    try {
      const result = await albedo.publicKey({});
      return result.pubkey;
    } catch (error) {
      throw describeError(error, "Albedo", "connection request");
    }
  },
  async signMessage(message, address) {
    try {
      const result = await albedo.signMessage({ message, pubkey: address });
      if (result.pubkey && result.pubkey !== address) {
        throw new WalletError("failed", "Albedo signed with a different account than the one you connected.");
      }
      return { signature: result.message_signature, signedMessage: result.signed_message };
    } catch (error) {
      if (error instanceof WalletError) throw error;
      throw describeError(error, "Albedo", "sign-in signature");
    }
  },
  async signTransaction(xdr, { networkPassphrase, address }) {
    if (networkPassphrase !== STELLAR.passphrase) throw new WalletError("wrong_network", "Server and app use different networks. Refusing to sign.");
    try {
      const result = await albedo.tx({ xdr, pubkey: address, network: STELLAR.isTestnet ? "testnet" : "public", submit: false });
      if (!result.signed_envelope_xdr) throw new WalletError("failed", "Albedo returned no signed transaction.");
      return result.signed_envelope_xdr;
    } catch (error) {
      if (error instanceof WalletError) throw error;
      throw describeError(error, "Albedo", "transaction");
    }
  },
};

interface TestWalletBridge {
  address(): Promise<string>;
  signMessage(message: string): Promise<string>;
  signTransaction(xdr: string, networkPassphrase: string): Promise<string>;
}

declare global {
  interface Window {
    __fintrixTestWallet?: TestWalletBridge;
  }
}

export function getWallet(kind: WalletKind = "freighter"): Wallet {
  if (import.meta.env.VITE_E2E_WALLET === "true" && typeof window !== "undefined" && window.__fintrixTestWallet) {
    const bridge = window.__fintrixTestWallet;
    return {
      name: "E2E test signer",
      connect: () => bridge.address(),
      signMessage: async (message) => ({ signature: await bridge.signMessage(message) }),
      signTransaction: (xdr, { networkPassphrase }) => bridge.signTransaction(xdr, networkPassphrase),
    };
  }
  return kind === "albedo" ? albedoWallet : freighterWallet;
}
