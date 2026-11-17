import crypto from "crypto";
import { explorerTxUrl, getConfig } from "../../config";
import { getDb, type Queryable } from "../../db";
import { HttpError } from "../../errors";
import { audit } from "../../audit";
import type { SessionUser } from "../auth/service";
import { assessInvoice } from "../ml/assessment";

export type InvoiceStatus = "draft" | "listed" | "funded" | "repaid" | "settled" | "cancelled" | "defaulted";

export interface LineItem {
  description: string;
  quantity: number | null;
  unitPrice: number | null;
  amount: number | null;
}

export interface InvoiceInput {
  invoiceNumber: string;
  issuerName: string;
  buyerName: string;
  buyerCountry?: string | null;
  currency: string;
  issueDate: string;
  dueDate: string;
  subtotal?: number | null;
  tax?: number | null;
  total: number;
  lineItems?: LineItem[];
  discountBps: number;
  notes?: string | null;
  documentId?: string | null;
  extractionId?: string | null;
}

interface InvoiceRow {
  id: string;
  seller_id: string;
  seller_address: string;
  seller_name: string | null;
  investor_id: string | null;
  investor_address: string | null;
  document_id: string | null;
  extraction_id: string | null;
  invoice_number: string;
  issuer_name: string;
  buyer_name: string;
  buyer_country: string | null;
  currency: string;
  issue_date: string;
  due_date: string;
  subtotal_cents: number | null;
  tax_cents: number | null;
  total_cents: number;
  line_items: LineItem[];
  discount_bps: number;
  settlement_asset: string;
  price_amount: string | null;
  repayment_amount: string | null;
  status: InvoiceStatus;
  contract_id: string | null;
  chain_invoice_id: string | null;
  document_hash: string | null;
  risk_score: number | null;
  risk_model: string | null;
  risk_factors: unknown;
  duplicate_flags: unknown;
  is_demo: boolean;
  notes: string | null;
  listed_at: Date | null;
  funded_at: Date | null;
  repaid_at: Date | null;
  settled_at: Date | null;
  created_at: Date;
  updated_at: Date;
  last_tx_hash?: string | null;
}

const SELECT_INVOICE = `
  SELECT i.*, s.stellar_address AS seller_address, s.display_name AS seller_name,
         inv.stellar_address AS investor_address,
         (SELECT tx_hash FROM chain_transactions c WHERE c.invoice_id = i.id AND c.status = 'success'
           ORDER BY c.confirmed_at DESC NULLS LAST LIMIT 1) AS last_tx_hash
    FROM invoices i
    JOIN users s ON s.id = i.seller_id
    LEFT JOIN users inv ON inv.id = i.investor_id`;

const iso = (value: Date | string | null | undefined) => (value ? new Date(value).toISOString() : null);
const cents = (value: number | null | undefined) => (value === null || value === undefined ? null : Number(value) / 100);
export const toCents = (value: number) => Math.round(value * 100);

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

export function computeTerms(totalCents: number, discountBps: number) {
  const priceCents = Math.floor((totalCents * (10_000 - discountBps)) / 10_000);
  return { priceCents, repaymentCents: totalCents, investorReturnCents: totalCents - priceCents };
}

/** Annualised yield for the investor if repaid on the due date (simple interest). */
export function annualisedYield(priceCents: number, repaymentCents: number, dueDate: string, from = new Date()) {
  const days = Math.max(1, Math.ceil((Date.parse(`${dueDate}T23:59:59Z`) - from.getTime()) / 86_400_000));
  if (priceCents <= 0) return 0;
  return ((repaymentCents - priceCents) / priceCents) * (365 / days);
}

export function toDto(row: InvoiceRow, viewer: SessionUser) {
  const isSeller = row.seller_id === viewer.id;
  const isInvestor = row.investor_id === viewer.id;
  const terms = computeTerms(row.total_cents, row.discount_bps);
  const pastDue = row.due_date < todayIso();
  const chainReady = Boolean(row.chain_invoice_id);

  return {
    id: row.id,
    invoiceNumber: row.invoice_number,
    issuerName: row.issuer_name,
    buyerName: row.buyer_name,
    buyerCountry: row.buyer_country,
    currency: row.currency,
    issueDate: row.issue_date,
    dueDate: row.due_date,
    subtotal: cents(row.subtotal_cents),
    tax: cents(row.tax_cents),
    total: cents(row.total_cents) as number,
    lineItems: row.line_items ?? [],
    discountBps: row.discount_bps,
    terms: {
      price: terms.priceCents / 100,
      repayment: terms.repaymentCents / 100,
      investorReturn: terms.investorReturnCents / 100,
      annualisedYield: annualisedYield(terms.priceCents, terms.repaymentCents, row.due_date),
      settlementAsset: row.settlement_asset,
      priceAmount: row.price_amount,
      repaymentAmount: row.repayment_amount,
    },
    status: row.status,
    chain: {
      contractId: row.contract_id,
      invoiceId: row.chain_invoice_id,
      lastTxHash: row.last_tx_hash ?? null,
      lastTxUrl: row.last_tx_hash ? explorerTxUrl(row.last_tx_hash) : null,
    },
    documentId: isSeller ? row.document_id : null,
    documentHash: row.document_hash,
    seller: { id: row.seller_id, address: row.seller_address, displayName: row.seller_name },
    investor: row.investor_id ? { id: row.investor_id, address: row.investor_address } : null,
    risk: row.risk_score === null ? null : { score: row.risk_score, model: row.risk_model, factors: row.risk_factors },
    duplicateFlags: (row.duplicate_flags as unknown[]) ?? [],
    isDemo: row.is_demo,
    notes: row.notes,
    viewer: { isSeller, isInvestor },
    actions: {
      edit: isSeller && row.status === "draft",
      delete: isSeller && row.status === "draft",
      list: isSeller && row.status === "draft" && row.currency === "USD" && !pastDue,
      cancel: isSeller && row.status === "listed" && chainReady,
      fund: !isSeller && row.status === "listed" && chainReady && !pastDue,
      repay: row.status === "funded" || row.status === "defaulted" ? isSeller : false,
      claim: isInvestor && row.status === "repaid",
      markDefaulted: isInvestor && row.status === "funded" && pastDue,
    },
    timestamps: {
      createdAt: iso(row.created_at),
      updatedAt: iso(row.updated_at),
      listedAt: iso(row.listed_at),
      fundedAt: iso(row.funded_at),
      repaidAt: iso(row.repaid_at),
      settledAt: iso(row.settled_at),
    },
  };
}

export type InvoiceDto = ReturnType<typeof toDto>;

async function loadRow(db: Queryable, id: string) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new HttpError(404, "Invoice not found.");
  const { rows } = await db.query<InvoiceRow>(`${SELECT_INVOICE} WHERE i.id = $1`, [id]);
  return rows[0] ?? null;
}

/** Drafts are private to their seller; everything else is on-chain and visible to signed-in users. */
export async function getInvoiceForViewer(id: string, viewer: SessionUser, db?: Queryable) {
  const row = await loadRow(db ?? (await getDb()), id);
  if (!row || (row.status === "draft" && row.seller_id !== viewer.id)) throw new HttpError(404, "Invoice not found.");
  return row;
}

export async function getInvoice(id: string, viewer: SessionUser) {
  return toDto(await getInvoiceForViewer(id, viewer), viewer);
}

export async function listInvoices(
  viewer: SessionUser,
  filter: { scope: "mine" | "marketplace" | "investments" | "all"; status?: InvoiceStatus; q?: string; limit: number; offset: number },
) {
  const db = await getDb();
  const where: string[] = [];
  const params: unknown[] = [];
  const add = (sql: string, value: unknown) => {
    params.push(value);
    where.push(sql.replace("?", `$${params.length}`));
  };

  if (filter.scope === "mine") add("i.seller_id = ?", viewer.id);
  else if (filter.scope === "investments") add("i.investor_id = ?", viewer.id);
  else if (filter.scope === "marketplace") where.push("i.status = 'listed'");
  else {
    params.push(viewer.id);
    where.push(`(i.status <> 'draft' OR i.seller_id = $${params.length})`);
  }
  if (filter.status) add("i.status = ?", filter.status);
  if (filter.q) {
    params.push(`%${filter.q.replace(/[%_\\]/g, (char) => `\\${char}`)}%`);
    where.push(`(i.buyer_name ILIKE $${params.length} OR i.invoice_number ILIKE $${params.length} OR i.issuer_name ILIKE $${params.length})`);
  }

  params.push(filter.limit + 1, filter.offset);
  const { rows } = await db.query<InvoiceRow>(
    `${SELECT_INVOICE} WHERE ${where.join(" AND ") || "true"} ORDER BY i.created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
  return { items: rows.slice(0, filter.limit).map((row) => toDto(row, viewer)), hasMore: rows.length > filter.limit };
}

function canonicalHash(sellerAddress: string, input: InvoiceInput) {
  // Stable fingerprint of the invoice facts, used on-chain when no document is attached.
  return crypto
    .createHash("sha256")
    .update(
      JSON.stringify([
        sellerAddress,
        input.invoiceNumber.trim().toUpperCase(),
        input.buyerName.trim().toLowerCase(),
        toCents(input.total),
        input.currency,
        input.issueDate,
      ]),
    )
    .digest("hex");
}

function validateBusinessRules(input: InvoiceInput) {
  if (input.dueDate < input.issueDate) throw new HttpError(400, "Due date cannot be before the issue date.");
  if (input.subtotal != null && input.tax != null) {
    const diff = Math.abs(toCents(input.subtotal) + toCents(input.tax) - toCents(input.total));
    if (diff > 1) throw new HttpError(400, "Subtotal plus tax must equal the total.");
  }
}

async function documentInfo(db: Queryable, owner: SessionUser, documentId?: string | null, extractionId?: string | null) {
  if (!documentId) return { hash: null as string | null };
  const { rows } = await db.query<{ sha256: string }>(`SELECT sha256 FROM documents WHERE id = $1 AND owner_id = $2`, [documentId, owner.id]);
  if (!rows[0]) throw new HttpError(400, "Document not found.");
  if (extractionId) {
    const extraction = await db.query<{ reviewed_at: Date | null }>(`SELECT reviewed_at FROM extractions WHERE id = $1 AND document_id = $2`, [
      extractionId,
      documentId,
    ]);
    if (!extraction.rows[0]) throw new HttpError(400, "Extraction does not belong to this document.");
    if (!extraction.rows[0].reviewed_at) {
      throw new HttpError(400, "Review and confirm the extracted fields before creating an invoice.");
    }
  }
  return { hash: rows[0].sha256 };
}

export async function createInvoice(seller: SessionUser, input: InvoiceInput) {
  validateBusinessRules(input);
  const db = await getDb();
  const doc = await documentInfo(db, seller, input.documentId, input.extractionId);
  const documentHash = doc.hash ?? canonicalHash(seller.stellarAddress, input);

  const id = await db.transaction(async (tx) => {
    const exists = await tx.query(`SELECT 1 FROM invoices WHERE seller_id = $1 AND invoice_number = $2`, [seller.id, input.invoiceNumber]);
    if (exists.rows.length) throw new HttpError(409, `You already have an invoice numbered ${input.invoiceNumber}.`);

    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO invoices (seller_id, document_id, extraction_id, invoice_number, issuer_name, buyer_name, buyer_country, currency,
                             issue_date, due_date, subtotal_cents, tax_cents, total_cents, line_items, discount_bps, notes,
                             document_hash, settlement_asset)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) RETURNING id`,
      [
        seller.id,
        input.documentId ?? null,
        input.extractionId ?? null,
        input.invoiceNumber,
        input.issuerName,
        input.buyerName,
        input.buyerCountry ?? null,
        input.currency,
        input.issueDate,
        input.dueDate,
        input.subtotal == null ? null : toCents(input.subtotal),
        input.tax == null ? null : toCents(input.tax),
        toCents(input.total),
        JSON.stringify(input.lineItems ?? []),
        input.discountBps,
        input.notes ?? null,
        documentHash,
        getConfig().SETTLEMENT_ASSET_CODE,
      ],
    );
    await audit(tx, seller.id, "invoice.create", "invoice", rows[0].id);
    return rows[0].id;
  });

  await refreshAssessment(id);
  return getInvoice(id, seller);
}

export async function updateDraft(seller: SessionUser, id: string, input: InvoiceInput) {
  validateBusinessRules(input);
  const db = await getDb();
  const row = await getInvoiceForViewer(id, seller, db);
  if (row.seller_id !== seller.id) throw new HttpError(403, "Only the seller can edit this invoice.");
  if (row.status !== "draft") throw new HttpError(409, "Only draft invoices can be edited.");
  const documentHash = row.document_id ? row.document_hash : canonicalHash(seller.stellarAddress, input);

  try {
    await db.query(
      `UPDATE invoices SET invoice_number=$2, issuer_name=$3, buyer_name=$4, buyer_country=$5, currency=$6, issue_date=$7, due_date=$8,
              subtotal_cents=$9, tax_cents=$10, total_cents=$11, line_items=$12, discount_bps=$13, notes=$14, document_hash=$15, updated_at=now()
        WHERE id=$1`,
      [
        id,
        input.invoiceNumber,
        input.issuerName,
        input.buyerName,
        input.buyerCountry ?? null,
        input.currency,
        input.issueDate,
        input.dueDate,
        input.subtotal == null ? null : toCents(input.subtotal),
        input.tax == null ? null : toCents(input.tax),
        toCents(input.total),
        JSON.stringify(input.lineItems ?? []),
        input.discountBps,
        input.notes ?? null,
        documentHash,
      ],
    );
  } catch (error) {
    if (/invoices_seller_id_invoice_number_key|duplicate key/i.test(String((error as Error).message))) {
      throw new HttpError(409, `You already have an invoice numbered ${input.invoiceNumber}.`);
    }
    throw error;
  }
  await refreshAssessment(id);
  return getInvoice(id, seller);
}

export async function deleteDraft(seller: SessionUser, id: string) {
  const db = await getDb();
  const row = await getInvoiceForViewer(id, seller, db);
  if (row.seller_id !== seller.id) throw new HttpError(403, "Only the seller can delete this invoice.");
  if (row.status !== "draft") throw new HttpError(409, "Only draft invoices can be deleted. Listed invoices must be cancelled on-chain.");
  await db.query(`DELETE FROM invoices WHERE id = $1`, [id]);
  await audit(db, seller.id, "invoice.delete", "invoice", id);
}

/** Recomputes the ML risk score and duplicate flags for an invoice. */
export async function refreshAssessment(id: string) {
  const db = await getDb();
  const { rows } = await db.query<InvoiceRow>(`${SELECT_INVOICE} WHERE i.id = $1`, [id]);
  const row = rows[0];
  if (!row) return;
  const assessment = await assessInvoice(db, {
    id: row.id,
    sellerId: row.seller_id,
    invoiceNumber: row.invoice_number,
    buyerName: row.buyer_name,
    buyerCountry: row.buyer_country,
    totalCents: row.total_cents,
    currency: row.currency,
    issueDate: row.issue_date,
    dueDate: row.due_date,
    documentHash: row.document_hash,
  });
  await db.query(`UPDATE invoices SET risk_score=$2, risk_model=$3, risk_factors=$4, duplicate_flags=$5 WHERE id=$1`, [
    id,
    assessment.risk?.score ?? null,
    assessment.risk?.model ?? null,
    assessment.risk ? JSON.stringify(assessment.risk.factors) : null,
    JSON.stringify(assessment.duplicates),
  ]);
}

export async function dashboard(viewer: SessionUser) {
  const db = await getDb();
  const selling = await db.query<{ status: InvoiceStatus; n: string; total: string }>(
    `SELECT status, count(*)::text AS n, coalesce(sum(total_cents),0)::text AS total FROM invoices WHERE seller_id = $1 GROUP BY status`,
    [viewer.id],
  );
  const investing = await db.query<{ status: InvoiceStatus; n: string; total: string; discount: string }>(
    `SELECT status, count(*)::text AS n, coalesce(sum(total_cents),0)::text AS total,
            coalesce(sum(total_cents * discount_bps / 10000),0)::text AS discount
       FROM invoices WHERE investor_id = $1 GROUP BY status`,
    [viewer.id],
  );
  const market = await db.query<{ n: string; total: string }>(
    `SELECT count(*)::text AS n, coalesce(sum(total_cents),0)::text AS total FROM invoices WHERE status = 'listed'`,
  );
  const recent = await db.query<{ id: string; kind: string; status: string; tx_hash: string; created_at: Date; invoice_number: string | null }>(
    `SELECT c.id, c.kind, c.status, c.tx_hash, c.created_at, i.invoice_number
       FROM chain_transactions c LEFT JOIN invoices i ON i.id = c.invoice_id
      WHERE c.user_id = $1 AND c.status <> 'prepared' ORDER BY c.created_at DESC LIMIT 6`,
    [viewer.id],
  );

  const sum = (rows: { status: InvoiceStatus; n: string; total: string }[], statuses?: InvoiceStatus[]) =>
    rows
      .filter((row) => !statuses || statuses.includes(row.status))
      .reduce((acc, row) => ({ count: acc.count + Number(row.n), total: acc.total + Number(row.total) / 100 }), { count: 0, total: 0 });

  const investedActive = sum(investing.rows, ["funded", "defaulted", "repaid"]);
  const expectedReturn = investing.rows
    .filter((row) => ["funded", "defaulted", "repaid"].includes(row.status))
    .reduce((acc, row) => acc + Number(row.discount) / 100, 0);
  const realisedReturn = investing.rows.filter((row) => row.status === "settled").reduce((acc, row) => acc + Number(row.discount) / 100, 0);

  return {
    selling: {
      drafts: sum(selling.rows, ["draft"]),
      listed: sum(selling.rows, ["listed"]),
      financed: sum(selling.rows, ["funded", "defaulted"]),
      completed: sum(selling.rows, ["repaid", "settled"]),
    },
    investing: {
      active: investedActive,
      settled: sum(investing.rows, ["settled"]),
      expectedReturn,
      realisedReturn,
    },
    marketplace: { listed: Number(market.rows[0]?.n ?? 0), volume: Number(market.rows[0]?.total ?? 0) / 100 },
    recentTransactions: recent.rows.map((row) => ({
      id: row.id,
      kind: row.kind,
      status: row.status,
      txHash: row.tx_hash,
      explorerUrl: explorerTxUrl(row.tx_hash),
      invoiceNumber: row.invoice_number,
      createdAt: iso(row.created_at),
    })),
  };
}

export { loadRow as loadInvoiceRow };
export type { InvoiceRow };
