import type { Queryable } from "../../db";
import { findDuplicates, type DuplicateFlag, type InvoiceFacts } from "./duplicates";
import { scoreRisk, type RiskResult } from "./risk";

export interface AssessmentInput extends InvoiceFacts {
  id: string;
  buyerCountry: string | null;
  dueDate: string;
}

export interface Assessment {
  risk: RiskResult | null;
  duplicates: DuplicateFlag[];
}

/** Buyer payment history inside Fintrix, used as risk-model features. */
async function buyerHistory(db: Queryable, buyerName: string, excludeId: string) {
  const { rows } = await db.query<{ due_date: string; repaid_at: Date | null; status: string }>(
    `SELECT due_date, repaid_at, status FROM invoices
      WHERE lower(buyer_name) = lower($1) AND id <> $2 AND status IN ('repaid', 'settled', 'defaulted')`,
    [buyerName, excludeId],
  );
  const daysLate = rows.map((row) => {
    if (row.status === "defaulted" || !row.repaid_at) return 60;
    const due = Date.parse(`${row.due_date}T23:59:59Z`);
    return Math.max(0, (new Date(row.repaid_at).getTime() - due) / 86_400_000);
  });
  return {
    priorCount: rows.length,
    priorLateRate: rows.length ? daysLate.filter((days) => days > 0).length / rows.length : null,
    priorAvgDaysLate: rows.length ? daysLate.reduce((a, b) => a + b, 0) / rows.length : null,
  };
}

export async function assessInvoice(db: Queryable, invoice: AssessmentInput): Promise<Assessment> {
  // Candidates: same document, or same currency among the most recent invoices.
  // Fuzzy name/number matching then runs in findDuplicates (no pg_trgm dependency).
  const { rows } = await db.query<{
    id: string;
    seller_id: string;
    invoice_number: string;
    buyer_name: string;
    total_cents: number;
    currency: string;
    issue_date: string;
    document_hash: string | null;
  }>(
    `(SELECT id, seller_id, invoice_number, buyer_name, total_cents, currency, issue_date, document_hash
        FROM invoices WHERE id <> $1 AND status <> 'cancelled' AND document_hash = $2)
     UNION
     (SELECT id, seller_id, invoice_number, buyer_name, total_cents, currency, issue_date, document_hash
        FROM invoices WHERE id <> $1 AND status <> 'cancelled' AND currency = $3
        ORDER BY created_at DESC LIMIT 2000)`,
    [invoice.id, invoice.documentHash, invoice.currency],
  );

  const duplicates = findDuplicates(
    invoice,
    rows.map((row) => ({
      id: row.id,
      sellerId: row.seller_id,
      invoiceNumber: row.invoice_number,
      buyerName: row.buyer_name,
      totalCents: Number(row.total_cents),
      currency: row.currency,
      issueDate: row.issue_date,
      documentHash: row.document_hash,
    })),
  );

  const history = await buyerHistory(db, invoice.buyerName, invoice.id);
  const risk = scoreRisk({
    totalCents: invoice.totalCents,
    termsDays: Math.max(0, (Date.parse(`${invoice.dueDate}T00:00:00Z`) - Date.parse(`${invoice.issueDate}T00:00:00Z`)) / 86_400_000),
    ...history,
  });
  return { risk, duplicates };
}
