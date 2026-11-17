import { emptyInvoice, ISO_CURRENCIES, type Confidence, type ExtractedInvoice } from "./schema";

/**
 * Rule-based invoice field extraction from plain text (PDF text layer or OCR output).
 * This is the no-API-key engine. It is deliberately conservative: every field carries a
 * confidence score, and anything not found is left empty for the reviewer.
 */

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
};

const SYMBOL_CURRENCY: Record<string, string> = { $: "USD", "€": "EUR", "£": "GBP", "₹": "INR", "¥": "JPY" };

const pad = (n: number) => String(n).padStart(2, "0");

function validDate(y: number, m: number, d: number) {
  if (y < 1990 || y > 2100 || m < 1 || m > 12 || d < 1 || d > 31) return null;
  const iso = `${y}-${pad(m)}-${pad(d)}`;
  const parsed = new Date(`${iso}T00:00:00Z`);
  return parsed.getUTCDate() === d ? iso : null;
}

/** Parses common date spellings into YYYY-MM-DD. Ambiguous d/m vs m/d prefers day-first when the first part > 12. */
export function parseDate(raw: string): string | null {
  const text = raw.trim().replace(/(\d)(st|nd|rd|th)\b/gi, "$1");
  let match = /(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/.exec(text);
  if (match) return validDate(+match[1], +match[2], +match[3]);
  match = /(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})/.exec(text);
  if (match) {
    const a = +match[1];
    const b = +match[2];
    const y = +match[3];
    return a > 12 ? validDate(y, b, a) : validDate(y, a, b) ?? validDate(y, b, a);
  }
  match = /(\d{1,2})\s+([A-Za-z]{3,9})\.?,?\s+(\d{4})/.exec(text);
  if (match && monthIndex(match[2])) return validDate(+match[3], monthIndex(match[2])!, +match[1]);
  match = /([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})/.exec(text);
  if (match && monthIndex(match[1])) return validDate(+match[3], monthIndex(match[1])!, +match[2]);
  return null;
}

function monthIndex(name: string): number | null {
  const lower = name.toLowerCase();
  return MONTHS[lower.slice(0, 4)] ?? MONTHS[lower.slice(0, 3)] ?? null;
}

/** Parses "1,234.56", "1.234,56", "$ 1 234.56" into a number. */
export function parseAmount(raw: string): number | null {
  const cleaned = raw.replace(/[^\d.,-]/g, "");
  if (!/\d/.test(cleaned)) return null;
  let normalised = cleaned;
  const lastComma = cleaned.lastIndexOf(",");
  const lastDot = cleaned.lastIndexOf(".");
  if (lastComma > lastDot && cleaned.length - lastComma - 1 === 2) {
    normalised = cleaned.replace(/\./g, "").replace(",", ".");
  } else {
    normalised = cleaned.replace(/,/g, "");
  }
  const value = Number(normalised);
  return Number.isFinite(value) ? Math.round(value * 100) / 100 : null;
}

const AMOUNT = String.raw`([-]?[$€£₹¥]?\s?\d[\d,. ]*\d(?:[.,]\d{2})?|\d)`;

function findLabelled(lines: string[], labels: RegExp, valuePattern: RegExp) {
  for (let i = 0; i < lines.length; i++) {
    if (!labels.test(lines[i])) continue;
    const after = lines[i].replace(labels, " ");
    const sameLine = valuePattern.exec(after);
    if (sameLine) return { value: sameLine[1], line: i, sameLine: true };
    const next = lines[i + 1] && valuePattern.exec(lines[i + 1]);
    if (next) return { value: next[1], line: i + 1, sameLine: false };
  }
  return null;
}

function lastLabelledAmount(lines: string[], labels: RegExp) {
  const amountRe = new RegExp(AMOUNT + String.raw`\s*$`);
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!labels.test(lines[i])) continue;
    const match = amountRe.exec(lines[i]) ?? (lines[i + 1] ? amountRe.exec(lines[i + 1]) : null);
    if (match) return parseAmount(match[1]);
  }
  return null;
}

function detectCurrency(text: string): { code: string | null; confidence: number } {
  const codes = text.toUpperCase().match(/\b[A-Z]{3}\b/g) ?? [];
  const counts = new Map<string, number>();
  for (const code of codes) if (ISO_CURRENCIES.has(code)) counts.set(code, (counts.get(code) ?? 0) + 1);
  const best = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  if (best) return { code: best[0], confidence: 0.85 };
  for (const [symbol, code] of Object.entries(SYMBOL_CURRENCY)) {
    if (text.includes(symbol)) return { code, confidence: symbol === "$" ? 0.6 : 0.75 };
  }
  return { code: null, confidence: 0 };
}

function partyAfter(lines: string[], labels: RegExp) {
  for (let i = 0; i < lines.length; i++) {
    if (!labels.test(lines[i])) continue;
    const inline = lines[i].replace(labels, "").replace(/^[\s:]+/, "").trim();
    const name = inline || lines[i + 1]?.trim();
    if (!name) continue;
    const addressLines: string[] = [];
    for (let j = inline ? i + 1 : i + 2; j < Math.min(lines.length, i + 5); j++) {
      if (
        !lines[j].trim() ||
        /:/.test(lines[j]) ||
        /invoice|date|total|due|description|qty|quantity|amount|price/i.test(lines[j]) ||
        /\d+[.,]\d{2}\s*$/.test(lines[j])
      ) {
        break;
      }
      addressLines.push(lines[j].trim());
    }
    return { name: name.slice(0, 160), address: addressLines.join(", ").slice(0, 400) || null };
  }
  return null;
}

function parseLineItems(lines: string[]) {
  const items: ExtractedInvoice["lineItems"] = [];
  const header = lines.findIndex((line) => /description|item/i.test(line) && /(amount|total|price)/i.test(line));
  if (header < 0) return items;
  const row = /^(.+?)\s+(\d+(?:\.\d+)?)\s+[$€£₹¥]?\s?(\d[\d,]*(?:\.\d{2})?)\s+[$€£₹¥]?\s?(\d[\d,]*(?:\.\d{2})?)\s*$/;
  for (let i = header + 1; i < lines.length && items.length < 50; i++) {
    if (/sub\s*-?total|^total|tax|vat|gst|amount due|balance/i.test(lines[i])) break;
    const match = row.exec(lines[i].trim());
    if (match) {
      items.push({ description: match[1].trim().slice(0, 300), quantity: Number(match[2]), unitPrice: parseAmount(match[3]), amount: parseAmount(match[4]) });
    }
  }
  return items;
}

export function extractFromText(text: string): { fields: ExtractedInvoice; confidence: Confidence } {
  const lines = text.split(/\r?\n/).map((line) => line.replace(/\s+/g, " ").trim()).filter(Boolean);
  const fields = emptyInvoice();
  const confidence: Confidence = {};

  const number = findLabelled(lines, /\b(invoice\s*(no\.?|number|#)|inv\s*(no\.?|#))\s*[:#]?/i, /([A-Z0-9][A-Z0-9\-/_.]{1,40})/i);
  if (number) {
    fields.invoiceNumber = number.value.replace(/[.]$/, "");
    confidence.invoiceNumber = number.sameLine ? 0.85 : 0.65;
  }

  const datePattern = /(.{6,30})/;
  const issue = findLabelled(lines, /\b(invoice date|date of issue|issue date|issued( on)?|^date)\b\s*:?/i, datePattern);
  const issueDate = issue ? parseDate(issue.value) : null;
  if (issueDate) {
    fields.issueDate = issueDate;
    confidence.issueDate = issue!.sameLine ? 0.85 : 0.65;
  }
  const due = findLabelled(lines, /\b(due date|payment due|due on|due by|pay by)\b\s*:?/i, datePattern);
  const dueDate = due ? parseDate(due.value) : null;
  if (dueDate) {
    fields.dueDate = dueDate;
    confidence.dueDate = due!.sameLine ? 0.85 : 0.65;
  } else if (fields.issueDate) {
    const terms = /net\s*(\d{1,3})/i.exec(text);
    if (terms) {
      const date = new Date(`${fields.issueDate}T00:00:00Z`);
      date.setUTCDate(date.getUTCDate() + Number(terms[1]));
      fields.dueDate = date.toISOString().slice(0, 10);
      confidence.dueDate = 0.55;
    }
  }

  const total = lastLabelledAmount(lines, /\b(grand total|total due|amount due|balance due|total amount|invoice total|^total)\b/i);
  if (total !== null) {
    fields.total = total;
    confidence.total = 0.8;
  }
  const subtotal = lastLabelledAmount(lines, /\bsub\s*-?\s*total\b/i);
  if (subtotal !== null) {
    fields.subtotal = subtotal;
    confidence.subtotal = 0.8;
  }
  const tax = lastLabelledAmount(lines, /\b(tax|vat|gst|sales tax)\b/i);
  if (tax !== null && tax !== total) {
    fields.tax = tax;
    confidence.tax = 0.7;
  }

  const currency = detectCurrency(text);
  fields.currency = currency.code;
  if (currency.code) confidence.currency = currency.confidence;

  const recipient = partyAfter(lines, /^\s*(bill(ed)?\s*to|invoice\s*to|sold\s*to|customer|client)\b\s*:?/i);
  if (recipient) {
    fields.recipient = { name: recipient.name, address: recipient.address, taxId: null };
    confidence.recipientName = 0.7;
  }
  const issuerLabelled = partyAfter(lines, /^\s*(from|seller|supplier|vendor|bill(ed)?\s*from)\b\s*:?/i);
  if (issuerLabelled) {
    fields.issuer = { name: issuerLabelled.name, address: issuerLabelled.address, taxId: null };
    confidence.issuerName = 0.7;
  } else {
    // Invoices usually start with the issuer's name; skip a leading "INVOICE" title.
    const firstIndex = lines.findIndex((line) => !/^(tax\s+)?invoice\b/i.test(line) && !/:/.test(line) && /[A-Za-z]{3}/.test(line));
    if (firstIndex >= 0) {
      const address: string[] = [];
      for (let j = firstIndex + 1; j < Math.min(lines.length, firstIndex + 3); j++) {
        if (/:|invoice|vat|gst|tax|bill/i.test(lines[j])) break;
        address.push(lines[j]);
      }
      fields.issuer = { name: lines[firstIndex].slice(0, 160), address: address.join(", ").slice(0, 400) || null, taxId: null };
      confidence.issuerName = 0.4;
    }
  }
  const taxId = /\b(vat|gst|tax|ein|tin)\s*(id|no\.?|number|#)?\s*[:#]?\s*([A-Z0-9-]{6,20})/i.exec(text);
  if (taxId) fields.issuer.taxId = taxId[3];

  fields.lineItems = parseLineItems(lines);
  if (fields.lineItems.length) confidence.lineItems = 0.6;

  return { fields, confidence };
}
