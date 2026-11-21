import fs from "fs";
import path from "path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { safeFilename, sniffMime } from "../../backend/modules/documents/service";
import { emptyInvoice, validateInvoice } from "../../backend/modules/documents/schema";
import { extractFromText, parseAmount, parseDate } from "../../backend/modules/documents/textRules";
import { setupApp, signIn, teardown, type TestContext } from "./helpers";

const fixtures = path.resolve(process.cwd(), "tests", "fixtures");
const sample = JSON.parse(fs.readFileSync(path.join(fixtures, "sample.json"), "utf8"));
let ctx: TestContext;
beforeAll(async () => {
  ctx = await setupApp();
});
afterAll(() => teardown(ctx));
const csrf = { "x-fintrix-csrf": "1" };

describe("text rules", () => {
  it("parses common date formats", () => {
    expect(parseDate("2026-11-02")).toBe("2026-11-02");
    expect(parseDate("02/11/2026")).toBe("2026-02-11");
    expect(parseDate("25/12/2026")).toBe("2026-12-25");
    expect(parseDate("3 March 2027")).toBe("2027-03-03");
    expect(parseDate("Sept 4, 2026")).toBe("2026-09-04");
    expect(parseDate("31/02/2026")).toBeNull();
    expect(parseDate("no date")).toBeNull();
  });
  it("parses amounts in US and EU notation", () => {
    expect(parseAmount("$1,234.56")).toBe(1234.56);
    expect(parseAmount("1.234,56")).toBe(1234.56);
    expect(parseAmount("USD 99")).toBe(99);
    expect(parseAmount("abc")).toBeNull();
  });
  it("derives a due date from Net terms when no due date is printed", () => {
    const { fields, confidence } = extractFromText("ACME LLC\nInvoice No: X-9\nInvoice Date: 2026-01-10\nPayment terms: Net 30\nBill To: Buyer Co\nTotal: $500.00");
    expect(fields.dueDate).toBe("2026-02-09");
    expect(confidence.dueDate).toBeLessThan(0.6);
    expect(fields.currency).toBe("USD");
  });

  it("does not mistake words inside company names for party labels", () => {
    const { fields } = extractFromText("Acme Seller Ltd\nInvoice No: X-10\nBill To:\nCustomer First Inc\nTotal: $500.00");
    expect(fields.issuer.name).toBe("Acme Seller Ltd");
    expect(fields.recipient.name).toBe("Customer First Inc");
  });
});

describe("validation", () => {
  const valid = () => ({
    ...emptyInvoice(),
    invoiceNumber: "A",
    issueDate: "2026-11-01",
    dueDate: "2027-01-01",
    issuer: { name: "S", address: null, taxId: null },
    recipient: { name: "B", address: null, taxId: null },
    currency: "USD",
    subtotal: 100,
    tax: 10,
    total: 110,
    lineItems: [{ description: "x", quantity: 2, unitPrice: 50, amount: 100 }],
  });
  it("passes a consistent invoice", () => {
    expect(validateInvoice(valid(), {}, "2026-11-13")).toEqual([]);
  });
  it("catches arithmetic, date, currency and missing-field errors", () => {
    const issues = validateInvoice({ ...valid(), total: 120, currency: "XYZ", dueDate: "2026-10-01", invoiceNumber: null }, { total: 0.3 }, "2026-11-13");
    const fields = issues.map((issue) => `${issue.severity}:${issue.field}`);
    expect(fields).toEqual(expect.arrayContaining(["error:total", "error:currency", "error:dueDate", "error:invoiceNumber"]));
  });
  it("warns on line items that do not add up", () => {
    const issues = validateInvoice({ ...valid(), lineItems: [{ description: "x", quantity: 2, unitPrice: 50, amount: 90 }] }, {}, "2026-11-13");
    expect(issues.some((issue) => issue.field === "lineItems" && issue.severity === "warning")).toBe(true);
  });
});

describe("file checks", () => {
  it("identifies files by magic bytes, not extension", () => {
    expect(sniffMime(fs.readFileSync(path.join(fixtures, "invoice-sample.pdf")))).toBe("application/pdf");
    expect(sniffMime(fs.readFileSync(path.join(fixtures, "invoice-sample.png")))).toBe("image/png");
    expect(sniffMime(fs.readFileSync(path.join(fixtures, "fake.pdf")))).toBeNull();
  });
  it("sanitises filenames", () => {
    expect(safeFilename("../../etc/passwd")).toBe("passwd");
    expect(safeFilename("in<voice>.pdf")).toBe("in_voice_.pdf");
  });
});

describe("document upload → extraction → review → invoice", () => {
  it("extracts every field from the sample PDF with the local engine", async () => {
    const { agent } = await signIn(ctx.app);
    const res = await agent.post("/api/documents").set(csrf).attach("file", path.join(fixtures, "invoice-sample.pdf")).expect(201);
    const { document, extraction } = res.body.data;
    expect(document.mimeType).toBe("application/pdf");
    expect(document.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(extraction.status).toBe("succeeded");
    expect(extraction.engine).toBe("local:pdf-text");
    expect(extraction.fields).toMatchObject({
      invoiceNumber: sample.invoiceNumber,
      issueDate: sample.issueDate,
      dueDate: sample.dueDate,
      currency: "USD",
      subtotal: sample.subtotal,
      tax: sample.tax,
      total: sample.total,
    });
    expect(extraction.fields.issuer.name).toBe(sample.issuer);
    expect(extraction.fields.recipient.name).toBe(sample.recipient);
    expect(extraction.fields.lineItems).toHaveLength(2);
    expect(extraction.confidence.total).toBeGreaterThan(0.5);
    expect(extraction.issues.filter((issue: { severity: string }) => issue.severity === "error")).toEqual([]);
  });

  it("requires human review before an invoice can be created, then creates it", async () => {
    const { agent } = await signIn(ctx.app);
    const up = await agent.post("/api/documents").set(csrf).attach("file", path.join(fixtures, "invoice-sample.pdf")).expect(201);
    const extraction = up.body.data.extraction;
    const blocked = await agent.post(`/api/extractions/${extraction.id}/invoice`).set(csrf).send({ discountBps: 250 }).expect(400);
    expect(blocked.body.error).toMatch(/Review and confirm/);

    const reviewed = await agent
      .put(`/api/extractions/${extraction.id}/review`)
      .set(csrf)
      .send({ fields: { ...extraction.fields, recipient: { ...extraction.fields.recipient, name: "Contoso Retail Group Inc" } } })
      .expect(200);
    expect(reviewed.body.data.reviewedAt).not.toBeNull();

    const created = await agent.post(`/api/extractions/${extraction.id}/invoice`).set(csrf).send({ discountBps: 250, buyerCountry: "US" }).expect(201);
    expect(created.body.data.buyerName).toBe("Contoso Retail Group Inc");
    expect(created.body.data.total).toBe(sample.total);
    expect(created.body.data.documentHash).toBe(up.body.data.document.sha256);
    expect(created.body.data.documentId).toBe(up.body.data.document.id);

    // Retrying after a failed/declined listing reuses the same draft with the new terms.
    const retried = await agent.post(`/api/extractions/${extraction.id}/invoice`).set(csrf).send({ discountBps: 400 }).expect(201);
    expect(retried.body.data.id).toBe(created.body.data.id);
    expect(retried.body.data.discountBps).toBe(400);
  });

  it("blocks invoice creation when reviewed data still has errors", async () => {
    const { agent } = await signIn(ctx.app);
    const up = await agent.post("/api/documents").set(csrf).attach("file", path.join(fixtures, "invoice-sample.pdf")).expect(201);
    const extraction = up.body.data.extraction;
    await agent.put(`/api/extractions/${extraction.id}/review`).set(csrf).send({ fields: { ...extraction.fields, total: 1 } }).expect(200);
    const res = await agent.post(`/api/extractions/${extraction.id}/invoice`).set(csrf).send({ discountBps: 250 }).expect(400);
    expect(res.body.error).toMatch(/does not equal total/);
  });

  it("reports a failed extraction for a scanned PDF without crashing", async () => {
    const { agent } = await signIn(ctx.app);
    const res = await agent.post("/api/documents").set(csrf).attach("file", path.join(fixtures, "scanned-no-text.pdf")).expect(201);
    expect(res.body.data.extraction.status).toBe("failed");
    expect(res.body.data.extraction.error).toMatch(/no text layer/);
  });

  it("rejects disguised and unsupported files", async () => {
    const { agent } = await signIn(ctx.app);
    const fake = await agent.post("/api/documents").set(csrf).attach("file", path.join(fixtures, "fake.pdf")).expect(415);
    expect(fake.body.error).toMatch(/Unsupported file/);
    await agent.post("/api/documents").set(csrf).attach("file", Buffer.from("hello"), { filename: "x.txt", contentType: "text/plain" }).expect(415);
    await agent.post("/api/documents").set(csrf).expect(400);
  });

  it("rejects files over the size limit", async () => {
    const { agent } = await signIn(ctx.app);
    const big = Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.alloc(5 * 1024 * 1024)]);
    await agent.post("/api/documents").set(csrf).attach("file", big, { filename: "big.pdf", contentType: "application/pdf" }).expect(413);
  });

  it("deduplicates re-uploads and isolates documents between users", async () => {
    const owner = await signIn(ctx.app);
    const other = await signIn(ctx.app);
    const first = await owner.agent.post("/api/documents").set(csrf).attach("file", path.join(fixtures, "invoice-sample.pdf")).expect(201);
    const again = await owner.agent.post("/api/documents").set(csrf).attach("file", path.join(fixtures, "invoice-sample.pdf")).expect(201);
    expect(again.body.data.duplicateUpload).toBe(true);
    expect(again.body.data.document.id).toBe(first.body.data.document.id);
    const id = first.body.data.document.id;
    await other.agent.get(`/api/documents/${id}`).expect(404);
    await other.agent.get(`/api/documents/${id}/file`).expect(404);
    await other.agent.put(`/api/extractions/${first.body.data.extraction.id}/review`).set(csrf).send({ fields: first.body.data.extraction.fields }).expect(404);
  });

  it("serves the original file only to its owner with a sandboxing CSP", async () => {
    const { agent } = await signIn(ctx.app);
    const up = await agent.post("/api/documents").set(csrf).attach("file", path.join(fixtures, "invoice-sample.png")).expect(201);
    expect(up.body.data.extraction.engine).toBe("local:tesseract-ocr");
    expect(up.body.data.extraction.fields.total).toBe(sample.total);
    const file = await agent.get(`/api/documents/${up.body.data.document.id}/file`).expect(200);
    expect(file.headers["content-type"]).toBe("image/png");
    expect(file.headers["content-security-policy"]).toMatch(/sandbox/);
  }, 60_000);

  it("returns 503 (not fake data) when AI extraction is requested without a key", async () => {
    const { agent } = await signIn(ctx.app);
    const up = await agent.post("/api/documents").set(csrf).attach("file", path.join(fixtures, "invoice-sample.pdf")).expect(201);
    const res = await agent.post(`/api/documents/${up.body.data.document.id}/extract`).set(csrf).send({ engine: "claude" }).expect(200);
    expect(res.body.data.extraction.status).toBe("failed");
    expect(res.body.data.extraction.error).toMatch(/AI is not configured/);
  });
});
