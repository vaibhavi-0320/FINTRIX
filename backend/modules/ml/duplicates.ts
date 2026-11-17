import { daysBetween, jaroWinkler, normaliseInvoiceNumber, normaliseName } from "./similarity";

export interface InvoiceFacts {
  id?: string;
  sellerId: string;
  invoiceNumber: string;
  buyerName: string;
  totalCents: number;
  currency: string;
  issueDate: string;
  documentHash: string | null;
}

export interface DuplicateFlag {
  invoiceId: string;
  rule: "same_document" | "same_number_and_buyer" | "near_duplicate";
  severity: "high" | "medium";
  score: number;
  explanation: string;
}

/** Thresholds were chosen on the synthetic evaluation set (see ml/duplicates/evaluate.ts). */
export const NEAR_DUPLICATE = {
  nameSimilarity: 0.9,
  amountTolerance: 0.005, // 0.5 %
  maxDaysApart: 7,
};

/**
 * Rule-based + fuzzy duplicate detector. Compares a candidate invoice with existing
 * ones and explains every match. It flags; it never blocks on its own (except that the
 * contract itself rejects an identical document hash on-chain).
 */
export function findDuplicates(candidate: InvoiceFacts, existing: InvoiceFacts[]): DuplicateFlag[] {
  const flags: DuplicateFlag[] = [];
  const candidateBuyer = normaliseName(candidate.buyerName);
  const candidateNumber = normaliseInvoiceNumber(candidate.invoiceNumber);

  for (const other of existing) {
    if (!other.id || other.id === candidate.id) continue;

    if (candidate.documentHash && other.documentHash === candidate.documentHash) {
      flags.push({
        invoiceId: other.id,
        rule: "same_document",
        severity: "high",
        score: 1,
        explanation: "An identical document (same SHA-256) is already registered.",
      });
      continue;
    }

    const buyerSimilarity = jaroWinkler(candidateBuyer, normaliseName(other.buyerName));
    const sameNumber = candidateNumber.length > 0 && candidateNumber === normaliseInvoiceNumber(other.invoiceNumber);

    if (sameNumber && buyerSimilarity >= NEAR_DUPLICATE.nameSimilarity) {
      flags.push({
        invoiceId: other.id,
        rule: "same_number_and_buyer",
        severity: "high",
        score: Number(buyerSimilarity.toFixed(3)),
        explanation: `Same invoice number and buyer (${Math.round(buyerSimilarity * 100)}% name match).`,
      });
      continue;
    }

    if (candidate.currency !== other.currency) continue;
    const amountDiff = Math.abs(candidate.totalCents - other.totalCents) / Math.max(candidate.totalCents, other.totalCents, 1);
    const daysApart = daysBetween(candidate.issueDate, other.issueDate);
    if (
      buyerSimilarity >= NEAR_DUPLICATE.nameSimilarity &&
      amountDiff <= NEAR_DUPLICATE.amountTolerance &&
      daysApart <= NEAR_DUPLICATE.maxDaysApart
    ) {
      const score = buyerSimilarity * (1 - amountDiff / NEAR_DUPLICATE.amountTolerance / 2) * (1 - daysApart / NEAR_DUPLICATE.maxDaysApart / 2);
      flags.push({
        invoiceId: other.id,
        rule: "near_duplicate",
        severity: "medium",
        score: Number(score.toFixed(3)),
        explanation: `Same buyer, amount within ${(amountDiff * 100).toFixed(2)}% and issued ${Math.round(daysApart)} day(s) apart.`,
      });
    }
  }
  return flags.sort((a, b) => b.score - a.score).slice(0, 5);
}
