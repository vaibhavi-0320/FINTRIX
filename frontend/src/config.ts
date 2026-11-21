/**
 * Browser-side network configuration. Only public values belong here (VITE_* vars
 * are embedded in the bundle). Must match the server's STELLAR_NETWORK.
 */
const PRESETS = {
  testnet: {
    passphrase: "Test SDF Network ; September 2015",
    horizonUrl: "https://horizon-testnet.stellar.org",
    explorerBase: "https://stellar.expert/explorer/testnet",
    label: "Stellar Testnet",
  },
  mainnet: {
    passphrase: "Public Global Stellar Network ; September 2015",
    horizonUrl: "https://horizon.stellar.org",
    explorerBase: "https://stellar.expert/explorer/public",
    label: "Stellar Mainnet",
  },
} as const;

export type NetworkName = keyof typeof PRESETS;

const requested = (import.meta.env.VITE_STELLAR_NETWORK || "testnet").toLowerCase();
const network: NetworkName = requested === "mainnet" ? "mainnet" : "testnet";

export const STELLAR = {
  network,
  ...PRESETS[network],
  horizonUrl: import.meta.env.VITE_STELLAR_HORIZON_URL || PRESETS[network].horizonUrl,
  isTestnet: network === "testnet",
};

/** Base URL for the API. Empty = same origin (local dev server and Vercel). */
export const API_BASE = (import.meta.env.VITE_API_URL || "").replace(/\/$/, "");

export function explorerTxUrl(hash: string) {
  return `${STELLAR.explorerBase}/tx/${hash}`;
}

export function explorerAccountUrl(address: string) {
  return `${STELLAR.explorerBase}/account/${address}`;
}
