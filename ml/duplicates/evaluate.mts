/**
 * Evaluates the duplicate-invoice detector (backend/modules/ml/duplicates.ts) on a
 * SEEDED SYNTHETIC set of invoice pairs with known labels.
 *
 * Positives (true duplicates) are re-submissions of the same invoice with realistic
 * variations; negatives include hard cases that legitimately look alike (recurring
 * monthly invoices with identical amounts, same number from different buyers).
 *
 * Usage: npx tsx ml/duplicates/evaluate.mts   -> writes ml/reports/duplicates_report.json
 */
import fs from "fs";
import path from "path";
import { findDuplicates, NEAR_DUPLICATE, type InvoiceFacts } from "../../backend/modules/ml/duplicates.ts";

// Mulberry32: tiny deterministic PRNG so the evaluation is reproducible.
function rng(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const random = rng(20261113);
const pick = <T,>(items: T[]) => items[Math.floor(random() * items.length)];
const int = (lo: number, hi: number) => lo + Math.floor(random() * (hi - lo + 1));

const BASE = ["Contoso Retail", "Northwind Traders", "Fabrikam Industries", "Adventure Works", "Tailspin Toys", "Wingtip Supplies", "Litware Systems", "Proseware Labs", "Woodgrove Foods", "Alpine Ski House", "Blue Yonder Freight", "Coho Vineyard", "Lucerne Publishing", "Margie Travel", "Trey Research", "Wide World Importers", "Humongous Insurance", "Fourth Coffee", "Graphic Design Institute", "School of Fine Art"];
const SUFFIX = ["Ltd", "Limited", "LLC", "Inc", "Corp", "Pvt Ltd", ""];

function addDays(date: string, days: number) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
function hash() {
  return Array.from({ length: 64 }, () => "0123456789abcdef"[int(0, 15)]).join("");
}
function nameVariant(name: string) {
  const variants = [
    (n: string) => n.toUpperCase(),
    (n: string) => n.toLowerCase(),
    (n: string) => n.replace(/ Ltd$/, " Limited").replace(/ Inc$/, " Incorporated"),
    (n: string) => `${n}.`,
    (n: string) => n.replace(/(\w)(\w)(\w*)$/, "$2$1$3"), // transposition typo at the end
    (n: string) => n.replace(/ /, "  "),
  ];
  return pick(variants)(name);
}
function numberVariant(num: string) {
  const digits = num.replace(/\D/g, "");
  return pick([`INV-${digits}`, `inv ${digits}`, `#${digits}`, `Invoice ${digits}`, digits.replace(/^0+/, "")]);
}

let counter = 0;
function base(): InvoiceFacts {
  const name = `${pick(BASE)} ${pick(SUFFIX)}`.trim();
  return {
    id: `inv-${counter++}`,
    sellerId: `seller-${int(1, 30)}`,
    invoiceNumber: `INV-${String(int(1, 99999)).padStart(5, "0")}`,
    buyerName: name,
    totalCents: int(5_000, 5_000_000),
    currency: "USD",
    issueDate: addDays("2026-01-01", int(0, 300)),
    documentHash: hash(),
  };
}

type Case = { kind: string; a: InvoiceFacts; b: InvoiceFacts; duplicate: boolean };
const cases: Case[] = [];
for (let i = 0; i < 200; i++) {
  const a = base();
  const kind = pick(["exact_file", "rescan", "renumbered_format", "amount_rounding"]);
  const b: InvoiceFacts = { ...a, id: `inv-${counter++}`, documentHash: hash(), sellerId: random() < 0.5 ? a.sellerId : `seller-${int(31, 60)}` };
  if (kind === "exact_file") b.documentHash = a.documentHash;
  if (kind === "rescan") b.buyerName = nameVariant(a.buyerName); // new scan: different file hash, same facts
  if (kind === "renumbered_format") {
    b.invoiceNumber = numberVariant(a.invoiceNumber);
    b.buyerName = nameVariant(a.buyerName);
  }
  if (kind === "amount_rounding") {
    b.invoiceNumber = `INV-${String(int(1, 99999)).padStart(5, "0")}`; // re-issued under a new number
    b.totalCents = Math.round(a.totalCents * (1 + (random() - 0.5) * 0.006));
    b.issueDate = addDays(a.issueDate, int(0, 5));
    b.buyerName = nameVariant(a.buyerName);
  }
  cases.push({ kind, a, b, duplicate: true });
}
for (let i = 0; i < 300; i++) {
  const a = base();
  const kind = pick(["unrelated", "recurring_monthly", "same_number_other_buyer", "same_buyer_other_amount"]);
  let b: InvoiceFacts = { ...base() };
  if (kind === "recurring_monthly") b = { ...a, id: `inv-${counter++}`, documentHash: hash(), invoiceNumber: `INV-${String(int(1, 99999)).padStart(5, "0")}`, issueDate: addDays(a.issueDate, int(28, 31)) };
  if (kind === "same_number_other_buyer") b = { ...base(), invoiceNumber: a.invoiceNumber };
  if (kind === "same_buyer_other_amount") b = { ...a, id: `inv-${counter++}`, documentHash: hash(), invoiceNumber: `INV-${String(int(1, 99999)).padStart(5, "0")}`, totalCents: Math.round(a.totalCents * (1.05 + random())), issueDate: addDays(a.issueDate, int(0, 6)) };
  cases.push({ kind, a, b, duplicate: false });
}

function evaluate() {
  let tp = 0, fp = 0, fn = 0, tn = 0;
  const byKind: Record<string, { total: number; flagged: number }> = {};
  for (const c of cases) {
    const flagged = findDuplicates(c.b, [c.a]).length > 0;
    byKind[c.kind] ??= { total: 0, flagged: 0 };
    byKind[c.kind].total++;
    if (flagged) byKind[c.kind].flagged++;
    if (flagged && c.duplicate) tp++;
    else if (flagged) fp++;
    else if (c.duplicate) fn++;
    else tn++;
  }
  const precision = tp / Math.max(1, tp + fp);
  const recall = tp / Math.max(1, tp + fn);
  return { tp, fp, fn, tn, precision, recall, f1: (2 * precision * recall) / Math.max(1e-9, precision + recall), byKind };
}

const result = evaluate();
const report = {
  dataset: { synthetic: true, seed: 20261113, positives: 200, negatives: 300 },
  thresholds: NEAR_DUPLICATE,
  metrics: { precision: Number(result.precision.toFixed(4)), recall: Number(result.recall.toFixed(4)), f1: Number(result.f1.toFixed(4)), confusion: { tp: result.tp, fp: result.fp, fn: result.fn, tn: result.tn } },
  flagRateByCaseType: Object.fromEntries(Object.entries(result.byKind).map(([kind, v]) => [kind, `${v.flagged}/${v.total}`])),
  note: "Synthetic pairs: measures the rules against the variations modelled here, not real-world fraud.",
};
const out = path.resolve(process.cwd(), "ml", "reports", "duplicates_report.json");
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report.metrics), JSON.stringify(report.flagRateByCaseType));
