import { z } from "zod";

export const ISO_CURRENCIES = new Set([
  "USD", "EUR", "GBP", "INR", "JPY", "CNY", "AUD", "CAD", "CHF", "SGD", "HKD", "AED", "SAR", "ZAR", "BRL", "MXN", "SEK", "NOK", "DKK", "NZD", "KRW", "IDR", "MYR", "THB", "PHP", "VND", "NGN", "KES", "EGP", "TRY", "PLN", "CZK", "HUF", "ILS",
]);

export const lineItemSchema = z.object({
  description: z.string().max(300),
  quantity: z.number().finite().nullable(),
  unitPrice: z.number().finite().nullable(),
  amount: z.number().finite().nullable(),
});

const party = z.object({
  name: z.string().max(160).nullable(),
  address: z.string().max(400).nullable(),
  taxId: z.string().max(60).nullable(),
});

/** Structured invoice data as extracted from a document. Every field may be missing. */
export const extractedInvoiceSchema = z.object({
  invoiceNumber: z.string().max(64).nullable(),
  issueDate: z.string().nullable().describe("YYYY-MM-DD"),
  dueDate: z.string().nullable().describe("YYYY-MM-DD"),
  issuer: party,
  recipient: party,
  currency: z.string().nullable().describe("ISO 4217 code, e.g. USD"),
  subtotal: z.number().finite().nullable(),
  tax: z.number().finite().nullable(),
  total: z.number().finite().nullable(),
  lineItems: z.array(lineItemSchema).max(100),
});

export type ExtractedInvoice = z.infer<typeof extractedInvoiceSchema>;

export const CONFIDENCE_FIELDS = ["invoiceNumber", "issueDate", "dueDate", "issuerName", "recipientName", "currency", "subtotal", "tax", "total", "lineItems"] as const;
export type ConfidenceField = (typeof CONFIDENCE_FIELDS)[number];
export type Confidence = Partial<Record<ConfidenceField, number>>;

export interface ValidationIssue {
  field: string;
  severity: "error" | "warning";
  message: string;
}

export function emptyInvoice(): ExtractedInvoice {
  return {
    invoiceNumber: null,
    issueDate: null,
    dueDate: null,
    issuer: { name: null, address: null, taxId: null },
    recipient: { name: null, address: null, taxId: null },
    currency: null,
    subtotal: null,
    tax: null,
    total: null,
    lineItems: [],
  };
}

const isIsoDate = (value: string | null) => Boolean(value && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`)));
const close = (a: number, b: number) => Math.abs(a - b) <= Math.max(0.01, Math.abs(b) * 0.001);

/**
 * Deterministic checks applied to every extraction (and again after human review).
 * Errors block invoice creation; warnings are shown to the reviewer.
 */
export function validateInvoice(data: ExtractedInvoice, confidence: Confidence = {}, today = new Date().toISOString().slice(0, 10)): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const error = (field: string, message: string) => issues.push({ field, severity: "error", message });
  const warn = (field: string, message: string) => issues.push({ field, severity: "warning", message });

  if (!data.invoiceNumber?.trim()) error("invoiceNumber", "Invoice number is missing.");
  if (!data.issuer.name?.trim()) error("issuerName", "Issuer (seller) name is missing.");
  if (!data.recipient.name?.trim()) error("recipientName", "Recipient (buyer) name is missing.");

  if (!isIsoDate(data.issueDate)) error("issueDate", "Issue date is missing or not a valid date.");
  if (!isIsoDate(data.dueDate)) error("dueDate", "Due date is missing or not a valid date.");
  if (isIsoDate(data.issueDate) && isIsoDate(data.dueDate) && data.dueDate! < data.issueDate!) error("dueDate", "Due date is before the issue date.");
  if (isIsoDate(data.dueDate) && data.dueDate! < today) warn("dueDate", "Due date is in the past; overdue invoices cannot be listed.");
  if (isIsoDate(data.issueDate) && data.issueDate! > today) warn("issueDate", "Issue date is in the future.");

  if (!data.currency) error("currency", "Currency is missing.");
  else if (!ISO_CURRENCIES.has(data.currency)) error("currency", `Unrecognised currency code "${data.currency}".`);

  if (data.total === null) error("total", "Total amount is missing.");
  else if (data.total <= 0) error("total", "Total must be greater than zero.");

  if (data.subtotal !== null && data.tax !== null && data.total !== null && !close(data.subtotal + data.tax, data.total)) {
    error("total", `Subtotal (${data.subtotal}) + tax (${data.tax}) does not equal total (${data.total}).`);
  }
  if (data.subtotal !== null && data.total !== null && data.tax === null && data.subtotal > data.total + 0.01) {
    error("subtotal", "Subtotal is larger than the total.");
  }

  const amounts = data.lineItems.map((item) => item.amount).filter((amount): amount is number => amount !== null);
  if (amounts.length && amounts.length === data.lineItems.length) {
    const sum = amounts.reduce((a, b) => a + b, 0);
    const target = data.subtotal ?? (data.tax === null ? data.total : null);
    if (target !== null && !close(sum, target)) warn("lineItems", `Line items add up to ${sum.toFixed(2)}, which differs from ${target.toFixed(2)}.`);
  }
  data.lineItems.forEach((item, index) => {
    if (item.quantity !== null && item.unitPrice !== null && item.amount !== null && !close(item.quantity * item.unitPrice, item.amount)) {
      warn(`lineItems.${index}`, `Line ${index + 1}: quantity × unit price ≠ amount.`);
    }
  });

  for (const [field, value] of Object.entries(confidence)) {
    if (value !== undefined && value < 0.6 && !issues.some((issue) => issue.field === field)) {
      warn(field, `Low extraction confidence (${Math.round(value * 100)}%). Please double-check.`);
    }
  }
  return issues;
}
