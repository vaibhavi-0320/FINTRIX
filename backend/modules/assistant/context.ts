import { getConfig } from "../../config";
import { logger } from "../../logger";
import type { SessionUser } from "../auth/service";
import { accountOverview, listTransactions } from "../chain/service";
import { getInvoice, listInvoices, type InvoiceDto } from "../invoices/service";

/** Screens of the Fintrix web app, as the user sees them. */
export const APP_VIEWS = [
  "landing",
  "wallet",
  "dashboard",
  "marketplace",
  "deal-detail",
  "simulation",
  "resources",
  "funding-success",
  "repayment",
] as const;
export type AppView = (typeof APP_VIEWS)[number];

export interface PageContext {
  view?: AppView;
  invoiceId?: string;
}

const SCREEN_DESCRIPTION: Record<AppView, string> = {
  landing: "Landing page (public home page with the Connect Wallet button)",
  wallet: "Connect Wallet screen (choose Freighter or Albedo)",
  dashboard: "Dashboard (balance, portfolio, recent activity, simulations)",
  marketplace: "Marketplace (Invoice Opportunities: listed invoices with filters and View Details buttons)",
  "deal-detail": "Deal detail page (Investment Panel with the action button for one invoice)",
  simulation: "Simulation page (Financing Journey with Upload Invoice, and the Investment Simulator with Simulate on Testnet)",
  resources: "Resources page (guides and FAQ)",
  "funding-success": "Funding success screen shown after an investor's fund transaction confirmed",
  repayment: "Repayment Complete screen shown after the seller's repayment confirmed",
};

/** Status names as the original UI shows them. */
const UI_STATUS: Record<InvoiceDto["status"], string> = {
  draft: "draft (saved, not listed; not visible on the marketplace)",
  listed: "open for funding (Active on the marketplace)",
  funded: "funded (awaiting the seller's repayment)",
  repaid: "repaid into escrow (awaiting the investor's claim)",
  settled: "settled (investor has claimed)",
  cancelled: "listing cancelled",
  defaulted: "marked defaulted",
};

/** Action buttons as labelled on the deal page. */
const ACTION_LABEL: Record<keyof InvoiceDto["actions"], string | null> = {
  edit: null,
  delete: null,
  list: "LIST ON MARKETPLACE",
  fund: "FUND THIS INVOICE",
  repay: "REPAY INTO ESCROW",
  claim: "CLAIM REPAYMENT",
  cancel: "Cancel listing",
  markDefaulted: "Mark as defaulted",
};

const usd = (value: number | null) => (value === null ? "n/a" : `$${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);

/** The same banding the UI uses (Trust Score / Risk Level). */
export function riskBand(score: number) {
  const pct = Math.round(score * 100);
  return pct < 40 ? `LOW (grade A+)` : pct < 65 ? `MEDIUM (grade B)` : `HIGH (grade B+)`;
}

function daysUntil(date: string) {
  return Math.round((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${new Date().toISOString().slice(0, 10)}T00:00:00Z`)) / 86_400_000);
}

export function describeInvoice(dto: InvoiceDto) {
  const role = dto.viewer.isSeller ? "you are the seller" : dto.viewer.isInvestor ? "you are the investor" : "another user's invoice";
  const actions = (Object.keys(dto.actions) as Array<keyof InvoiceDto["actions"]>)
    .filter((key) => dto.actions[key] && ACTION_LABEL[key])
    .map((key) => ACTION_LABEL[key]);
  const days = daysUntil(dto.dueDate);
  const parts = [
    `${dto.invoiceNumber}`,
    `buyer ${dto.buyerName}`,
    `issued by ${dto.issuerName}`,
    role,
    `status ${UI_STATUS[dto.status]}`,
    `total ${usd(dto.total)} ${dto.currency}`,
    `investor price ${usd(dto.terms.price)}`,
    `repayment ${usd(dto.terms.repayment)}`,
    `investor return ${usd(dto.terms.investorReturn)} (${(dto.terms.annualisedYield * 100).toFixed(1)}% annualised, simple interest)`,
    `discount ${(dto.discountBps / 100).toFixed(2)}%`,
    `due ${dto.dueDate} (${days >= 0 ? `${days} days away` : `${-days} days overdue`})`,
    dto.terms.priceAmount ? `on-chain price ${dto.terms.priceAmount} ${dto.terms.settlementAsset ?? ""}`.trim() : null,
    dto.risk ? `modelled late-payment probability ${Math.round(dto.risk.score * 100)}% → Trust Score / Risk Level ${riskBand(dto.risk.score)}` : "no risk score",
    dto.duplicateFlags.length ? `DUPLICATE WARNINGS: ${dto.duplicateFlags.length}` : "no duplicate warnings",
    dto.isDemo ? "DEMO listing created by the Fintrix team for testing" : null,
    dto.chain.lastTxHash ? `last transaction ${dto.chain.lastTxHash.slice(0, 12)}…` : null,
    `available actions for you: ${actions.length ? actions.join(", ") : "none"}`,
  ];
  return parts.filter(Boolean).join(" | ");
}

let loadAccount: typeof accountOverview = accountOverview;
/** Tests replace the Horizon lookup so they stay offline. */
export function setAccountLoaderForTests(loader: typeof accountOverview | null) {
  loadAccount = loader ?? accountOverview;
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([promise, new Promise<null>((resolve) => setTimeout(() => resolve(null), ms))]).catch(() => null);
}

/**
 * Everything the assistant may know about the signed-in user, read fresh from the
 * database and Horizon for each message. Only the user's own data and public listings.
 */
export async function buildUserData(user: SessionUser, context: PageContext = {}) {
  const lines: string[] = [];
  const { network } = getConfig().stellar;
  lines.push(`network: Stellar ${network}${network === "testnet" ? " (test XLM, no real value)" : ""}`);
  lines.push(`wallet: ${user.stellarAddress}`);
  lines.push(`today: ${new Date().toISOString().slice(0, 10)}`);

  const [account, mine, investments, open, txs, openDeal] = await Promise.all([
    withTimeout(loadAccount(user.stellarAddress), 4000),
    listInvoices(user, { scope: "mine", limit: 15, offset: 0 }).catch(() => null),
    listInvoices(user, { scope: "investments", limit: 15, offset: 0 }).catch(() => null),
    listInvoices(user, { scope: "marketplace", limit: 10, offset: 0 }).catch(() => null),
    listTransactions(user, 8).catch(() => null),
    context.invoiceId ? getInvoice(context.invoiceId, user).catch(() => null) : Promise.resolve(null),
  ]);

  if (account === null) lines.push("xlm_balance: unavailable (Horizon did not respond)");
  else if (!account.exists) lines.push(`xlm_balance: 0 — account NOT activated on ${network}; fund it with Friendbot: ${account.friendbotUrl ?? "n/a"}`);
  else lines.push(`balances: ${account.balances.map((balance) => `${balance.balance} ${balance.asset}`).join(", ")}`);

  if (context.view) lines.push(`current_screen: ${SCREEN_DESCRIPTION[context.view]}`);
  if (openDeal && (context.view === "deal-detail" || context.view === "funding-success" || context.view === "repayment")) {
    lines.push(`deal_open_on_screen: ${describeInvoice(openDeal)}`);
  }

  lines.push(`my_invoices_as_seller (${mine?.items.length ?? "unavailable"}${mine?.hasMore ? "+" : ""}):`);
  for (const dto of mine?.items ?? []) lines.push(`  - ${describeInvoice(dto)}`);
  lines.push(`my_investments (${investments?.items.length ?? "unavailable"}${investments?.hasMore ? "+" : ""}):`);
  for (const dto of investments?.items ?? []) lines.push(`  - ${describeInvoice(dto)}`);

  const openCount = `${open?.items.length ?? "unavailable"}${open?.hasMore ? "+" : ""}`;
  if (context.view === "marketplace" || context.view === "simulation" || context.view === "dashboard") {
    lines.push(`marketplace_open_listings (${openCount}):`);
    for (const dto of open?.items ?? []) lines.push(`  - ${describeInvoice(dto)}`);
  } else {
    lines.push(`marketplace_open_listings: ${openCount}`);
  }

  lines.push(`recent_fintrix_transactions (${txs?.length ?? "unavailable"}):`);
  for (const tx of txs ?? []) {
    const what = tx.kind === "simulation" && tx.simulation
      ? `simulation for ${tx.simulation.company ?? "a deal"}: $${tx.simulation.amountUSD} → expected return $${tx.simulation.expectedReturn}, maturity ${tx.simulation.maturityDate}`
      : `${tx.kind}${tx.invoiceNumber ? ` ${tx.invoiceNumber}` : ""}${tx.amount ? ` ${tx.amount} ${tx.asset ?? ""}` : ""}`;
    lines.push(`  - ${tx.createdAt.slice(0, 16).replace("T", " ")} ${what} — ${tx.status}${tx.ledger ? ` (ledger ${tx.ledger})` : ""}${tx.error ? ` error: ${tx.error}` : ""}`);
  }

  const text = lines.join("\n");
  if (text.length > 14000) logger.warn({ length: text.length }, "assistant user_data truncated");
  return `<user_data>\n${text.slice(0, 14000)}\n</user_data>`;
}
