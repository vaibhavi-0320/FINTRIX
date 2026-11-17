/** "active" = listed on-chain and open for funding (the original UI's name for it). */
export type InvoiceStatus = "draft" | "active" | "funded" | "repaid" | "settled" | "cancelled" | "defaulted";

export type WalletProvider = "freighter" | "albedo" | "phyto" | "demo";

export interface Invoice {
  id: string;
  buyer: string;
  amount: number;
  discount: number;
  due: string;
  status: InvoiceStatus;
  seller: string;
  funder?: string;
  yield: number;
  funded: number;
  tags: string[];
  riskScore: number;
  aiSummary: string;
  txHash?: string;
  companyName?: string;
  industry?: string;
  country?: string;
  /** Full record from the Fintrix API (terms, on-chain ids, permitted actions). */
  dto?: ApiInvoice;
}

export type ChainAction = "create" | "fund" | "repay" | "claim" | "cancel" | "default";

export interface ApiInvoice {
  id: string;
  invoiceNumber: string;
  issuerName: string;
  buyerName: string;
  buyerCountry: string | null;
  currency: string;
  issueDate: string;
  dueDate: string;
  subtotal: number | null;
  tax: number | null;
  total: number;
  discountBps: number;
  terms: { price: number; repayment: number; investorReturn: number; annualisedYield: number; settlementAsset: string; priceAmount: string | null; repaymentAmount: string | null };
  status: "draft" | "listed" | "funded" | "repaid" | "settled" | "cancelled" | "defaulted";
  chain: { contractId: string | null; invoiceId: string | null; lastTxHash: string | null; lastTxUrl: string | null };
  documentHash: string | null;
  seller: { id: string; address: string; displayName: string | null };
  investor: { id: string; address: string } | null;
  risk: { score: number; model: string; factors: Array<{ feature: string; value: number; contribution: number }> } | null;
  duplicateFlags: Array<{ invoiceId: string; rule: string; severity: "high" | "medium"; score: number; explanation: string }>;
  isDemo: boolean;
  notes: string | null;
  viewer: { isSeller: boolean; isInvestor: boolean };
  actions: { edit: boolean; delete: boolean; list: boolean; cancel: boolean; fund: boolean; repay: boolean; claim: boolean; markDefaulted: boolean };
  timestamps: Record<"createdAt" | "updatedAt" | "listedAt" | "fundedAt" | "repaidAt" | "settledAt", string | null>;
}

export interface ChainResult {
  status: "prepared" | "submitted" | "success" | "failed" | "expired";
  hash: string;
  ledger: number | null;
  explorerUrl: string | null;
  error: string | null;
  invoice: ApiInvoice | null;
}

export interface ConnectedWallet {
  publicKey: string;
  provider: WalletProvider;
  label: string;
}

export interface UserState {
  wallet: ConnectedWallet | null;
  role: "exporter" | "investor";
  totalInvested: number;
  totalReturns: number;
  roi: number;
  dealsCompleted: number;
  xlmBalance: number;
}

export interface Transaction {
  type: "Fund" | "List" | "Repay";
  name: string;
  amount: string;
  xlm: string;
  status: "Success" | "Pending";
  time: string;
}

export interface LeaderboardEntry {
  rank: number;
  name: string;
  tag: string;
  roi: string;
  totalReturns: string;
  deals: number;
}

export interface WalletOption {
  id: WalletProvider;
  name: string;
  description: string;
  accent: string;
  mode: "extension" | "bridge" | "manual";
}

export interface InvoiceDraft {
  amount: string;
  dueDate: string;
  buyer: string;
  number: string;
  discount: number;
  notes: string;
}

export interface InvoiceParseResult {
  amount: number;
  dueDate: string;
  buyerName: string;
  invoiceNumber: string;
  summary?: string;
}
