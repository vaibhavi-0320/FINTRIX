/**
 * Generates SYNTHETIC invoice fixtures (fictional companies and amounts) used by the
 * extraction tests and the end-to-end test. Run: npx tsx scripts/make-fixtures.ts
 */
import fs from "fs";
import path from "path";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import sharp from "sharp";

const out = path.resolve(process.cwd(), "tests", "fixtures");
fs.mkdirSync(out, { recursive: true });

export const SAMPLE = {
  invoiceNumber: "INV-2026-0417",
  issueDate: "2026-11-02",
  dueDate: "2027-01-31",
  issuer: "Northwind Components Ltd",
  recipient: "Contoso Retail Group",
  currency: "USD",
  lines: [
    { description: "Steel brackets (box of 50)", qty: 40, unit: 18.5, amount: 740.0 },
    { description: "Assembly service hours", qty: 12, unit: 45.0, amount: 540.0 },
  ],
  subtotal: 1280.0,
  tax: 102.4,
  total: 1382.4,
};

const lines = [
  SAMPLE.issuer,
  "12 Harbour Road, Bristol, UK",
  "VAT No: GB123456789",
  "",
  "INVOICE",
  `Invoice No: ${SAMPLE.invoiceNumber}`,
  `Invoice Date: ${SAMPLE.issueDate}`,
  `Due Date: ${SAMPLE.dueDate}`,
  "",
  "Bill To:",
  SAMPLE.recipient,
  "400 Market Street, Seattle, WA",
  "",
  "Description Qty Unit Price Amount",
  ...SAMPLE.lines.map((line) => `${line.description} ${line.qty} ${line.unit.toFixed(2)} ${line.amount.toFixed(2)}`),
  "",
  `Subtotal USD ${SAMPLE.subtotal.toFixed(2)}`,
  `Tax (8%) USD ${SAMPLE.tax.toFixed(2)}`,
  `Total Due USD ${SAMPLE.total.toFixed(2)}`,
  "",
  "Payment terms: Net 90. Thank you for your business.",
];

async function makePdf(file: string, content: string[]) {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([595, 842]);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  let y = 790;
  for (const line of content) {
    if (line) page.drawText(line, { x: 50, y, size: 12, font, color: rgb(0.1, 0.1, 0.1) });
    y -= 20;
  }
  pdf.setTitle("Synthetic test invoice");
  fs.writeFileSync(path.join(out, file), await pdf.save());
}

async function makePng(file: string, content: string[]) {
  const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const height = 60 + content.length * 34;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1100" height="${height}">
    <rect width="100%" height="100%" fill="#ffffff"/>
    ${content.map((line, i) => `<text x="40" y="${60 + i * 34}" font-family="Arial, Helvetica, sans-serif" font-size="24" fill="#111">${escape(line)}</text>`).join("\n")}
  </svg>`;
  await sharp(Buffer.from(svg)).png().toFile(path.join(out, file));
}

await makePdf("invoice-sample.pdf", lines);
await makePng("invoice-sample.png", lines);
// A PDF with no text layer (simulates a scanned document).
{
  const pdf = await PDFDocument.create();
  pdf.addPage([595, 842]);
  fs.writeFileSync(path.join(out, "scanned-no-text.pdf"), await pdf.save());
}
fs.writeFileSync(path.join(out, "sample.json"), JSON.stringify(SAMPLE, null, 2));
fs.writeFileSync(path.join(out, "fake.pdf"), "<html><script>alert(1)</script></html>");
console.log("fixtures written to", out);
