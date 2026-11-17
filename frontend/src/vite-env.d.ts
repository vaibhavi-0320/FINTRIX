/// <reference types="vite/client" />

interface AlbedoWallet {
  publicKey(): Promise<{ pubkey: string }>;
  signMessage(message: string): Promise<{ signature: string }>;
  signTransaction(transaction: string): Promise<{ signedTxXdr: string }>;
}

declare global {
  interface Window {
    freighter: unknown;
    albedo?: AlbedoWallet;
  }

  interface ImportMetaEnv {
    readonly VITE_STELLAR_NETWORK?: string;
    readonly VITE_STELLAR_HORIZON_URL?: string;
    readonly VITE_API_URL?: string;
    /** "true" only in the Playwright E2E build: enables the injected test signer. */
    readonly VITE_E2E_WALLET?: string;
  }
}

export {};
