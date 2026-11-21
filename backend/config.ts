import dotenv from "dotenv";
import path from "path";
import { z } from "zod";

// One .env at the repository root serves both the API and Vite (envDir).
dotenv.config({ path: path.resolve(process.cwd(), ".env"), quiet: true });
dotenv.config({ path: path.resolve(process.cwd(), "..", ".env"), quiet: true });

/**
 * Stellar network presets. Values come from the official Stellar docs:
 * https://developers.stellar.org/docs/networks
 */
export const STELLAR_NETWORKS = {
  testnet: {
    passphrase: "Test SDF Network ; September 2015",
    horizonUrl: "https://horizon-testnet.stellar.org",
    rpcUrl: "https://soroban-testnet.stellar.org",
    explorerBase: "https://stellar.expert/explorer/testnet",
    friendbotUrl: "https://friendbot.stellar.org",
  },
  mainnet: {
    passphrase: "Public Global Stellar Network ; September 2015",
    horizonUrl: "https://horizon.stellar.org",
    // Mainnet has no SDF-operated public RPC; an RPC provider URL must be configured.
    rpcUrl: "",
    explorerBase: "https://stellar.expert/explorer/public",
    friendbotUrl: "",
  },
} as const;

export type StellarNetworkName = keyof typeof STELLAR_NETWORKS;

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  /** Comma-separated list of origins allowed to call the API cross-origin. Same-origin needs nothing. */
  APP_ORIGIN: z.string().default("http://localhost:3000,http://127.0.0.1:3000"),

  /** Postgres connection string. When absent (dev/test), an embedded PGlite database is used. */
  DATABASE_URL: z.string().min(1).optional(),
  PGLITE_DIR: z.string().default(".data/pglite"),
  /** Writable cache for OCR language data and embedding models. Serverless hosts only allow /tmp. */
  FINTRIX_CACHE_DIR: z.string().default(process.env.VERCEL ? "/tmp/fintrix-cache" : ".data"),

  /** Number of reverse proxies in front of the app (Vercel = 1). 0 = trust no X-Forwarded-* headers. */
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(process.env.VERCEL ? 1 : 0),
  /** Session lifetime in hours. */
  SESSION_TTL_HOURS: z.coerce.number().int().min(1).max(24 * 30).default(24 * 7),

  STELLAR_NETWORK: z.enum(["testnet", "mainnet"]).default("testnet"),
  STELLAR_HORIZON_URL: z.string().url().optional(),
  STELLAR_RPC_URL: z.string().url().optional(),
  /** Deployed Fintrix escrow contract (C...). */
  FINTRIX_CONTRACT_ID: z.string().regex(/^C[A-Z2-7]{55}$/, "must be a Soroban contract id (C...)").optional(),
  /** Settlement token contract (C...). On testnet this is the native XLM Stellar Asset Contract. */
  SETTLEMENT_TOKEN_ID: z.string().regex(/^C[A-Z2-7]{55}$/, "must be a Soroban contract id (C...)").optional(),
  SETTLEMENT_ASSET_CODE: z.string().default("XLM"),
  /** Price of one settlement-asset unit in USD, used to convert invoice values into on-chain amounts. */
  USD_PER_XLM: z.coerce.number().positive().default(0.11),

  ANTHROPIC_API_KEY: z.string().min(1).optional(),
  ANTHROPIC_MODEL: z.string().default("claude-opus-5-5"),
  /** local = on-device MiniLM model (no key); voyage = Voyage AI API (VOYAGE_API_KEY). */
  EMBEDDINGS_PROVIDER: z.enum(["local", "voyage", "none"]).default("local"),
  VOYAGE_API_KEY: z.string().min(1).optional(),
  /** auto = Claude when ANTHROPIC_API_KEY is set, else local OCR/text rules. */
  EXTRACTION_PROVIDER: z.enum(["auto", "claude", "local"]).default("auto"),
  /** Max upload size. Vercel caps request bodies at 4.5 MB. */
  MAX_UPLOAD_BYTES: z.coerce.number().int().positive().max(20 * 1024 * 1024).default(4 * 1024 * 1024),
});

export type AppConfig = z.infer<typeof envSchema> & {
  stellar: {
    network: StellarNetworkName;
    passphrase: string;
    horizonUrl: string;
    rpcUrl: string;
    explorerBase: string;
    friendbotUrl: string;
  };
  allowedOrigins: string[];
};

let cached: AppConfig | null = null;

function blankToUndefined(source: NodeJS.ProcessEnv) {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && value.trim() !== "") out[key] = value.trim();
  }
  return out;
}

export function getConfig(): AppConfig {
  if (cached) return cached;

  const parsed = envSchema.safeParse(blankToUndefined(process.env));
  if (!parsed.success) {
    const message = parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ");
    throw new Error(`Invalid environment configuration: ${message}`);
  }

  const env = parsed.data;
  const preset = STELLAR_NETWORKS[env.STELLAR_NETWORK];
  const rpcUrl = env.STELLAR_RPC_URL ?? preset.rpcUrl;

  if (env.STELLAR_NETWORK === "mainnet") {
    if (!env.STELLAR_RPC_URL) {
      throw new Error("STELLAR_NETWORK=mainnet requires STELLAR_RPC_URL (no public SDF mainnet RPC exists).");
    }
    if (env.NODE_ENV !== "production") {
      throw new Error("Refusing to use Stellar MAINNET outside NODE_ENV=production. Use testnet for development.");
    }
  }

  cached = {
    ...env,
    stellar: {
      network: env.STELLAR_NETWORK,
      passphrase: preset.passphrase,
      horizonUrl: env.STELLAR_HORIZON_URL ?? preset.horizonUrl,
      rpcUrl,
      explorerBase: preset.explorerBase,
      friendbotUrl: preset.friendbotUrl,
    },
    allowedOrigins: env.APP_ORIGIN.split(",").map((origin) => origin.trim()).filter(Boolean),
  };
  return cached;
}

/** Test helper: forget the cached config so a test can change process.env. */
export function resetConfigForTests() {
  cached = null;
}

export function explorerTxUrl(hash: string) {
  return `${getConfig().stellar.explorerBase}/tx/${hash}`;
}
