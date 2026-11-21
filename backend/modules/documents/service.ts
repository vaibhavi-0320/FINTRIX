import crypto from "crypto";
import { getConfig } from "../../config";
import { getDb } from "../../db";
import { HttpError } from "../../errors";
import { audit } from "../../audit";
import { logger } from "../../logger";
import type { SessionUser } from "../auth/service";
import { createInvoice, updateDraft } from "../invoices/service";
import { runExtraction, type DocumentMime } from "./extractors";
import { extractedInvoiceSchema, validateInvoice, type Confidence, type ExtractedInvoice, type ValidationIssue } from "./schema";

/** Identifies the real file type from its first bytes; the client-declared type is not trusted. */
export function sniffMime(buffer: Buffer): DocumentMime | null {
  if (buffer.length >= 5 && buffer.subarray(0, 5).toString("latin1") === "%PDF-") return "application/pdf";
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "image/jpeg";
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString("latin1") === "RIFF" && buffer.subarray(8, 12).toString("latin1") === "WEBP") return "image/webp";
  return null;
}

export function safeFilename(name: string) {
  const base = name.split(/[\\/]/).pop() ?? "document";
  const cleaned = base.normalize("NFKC").replace(/[^\w.\- ()]+/g, "_").replace(/\s+/g, " ").trim();
  return (cleaned || "document").slice(0, 120);
}

interface ExtractionRow {
  id: string;
  document_id: string;
  engine: string;
  status: "succeeded" | "failed";
  fields: ExtractedInvoice | null;
  confidence: Confidence | null;
  issues: ValidationIssue[];
  error: string | null;
  reviewed_fields: ExtractedInvoice | null;
  reviewed_at: Date | null;
  created_at: Date;
}

function extractionDto(row: ExtractionRow) {
  return {
    id: row.id,
    documentId: row.document_id,
    engine: row.engine,
    status: row.status,
    fields: row.fields,
    confidence: row.confidence ?? {},
    issues: row.issues ?? [],
    error: row.error,
    reviewedFields: row.reviewed_fields,
    reviewedAt: row.reviewed_at ? new Date(row.reviewed_at).toISOString() : null,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

async function loadDocument(owner: SessionUser, documentId: string) {
  if (!/^[0-9a-f-]{36}$/i.test(documentId)) throw new HttpError(404, "Document not found.");
  const db = await getDb();
  const { rows } = await db.query<{ id: string; filename: string; mime_type: DocumentMime; size_bytes: number; sha256: string; created_at: Date }>(
    `SELECT id, filename, mime_type, size_bytes, sha256, created_at FROM documents WHERE id = $1 AND owner_id = $2`,
    [documentId, owner.id],
  );
  if (!rows[0]) throw new HttpError(404, "Document not found.");
  return rows[0];
}

async function latestExtraction(documentId: string) {
  const db = await getDb();
  const { rows } = await db.query<ExtractionRow>(`SELECT * FROM extractions WHERE document_id = $1 ORDER BY created_at DESC LIMIT 1`, [documentId]);
  return rows[0] ? extractionDto(rows[0]) : null;
}

/** Other invoices (any seller) already registered with this exact document. */
async function documentReuse(sha256: string, ownerId: string) {
  const db = await getDb();
  const { rows } = await db.query<{ id: string; invoice_number: string; status: string; mine: boolean }>(
    `SELECT id, invoice_number, status, seller_id = $2 AS mine FROM invoices WHERE document_hash = $1 AND status <> 'cancelled'`,
    [sha256, ownerId],
  );
  return rows.map((row) => ({ invoiceId: row.mine ? row.id : null, invoiceNumber: row.mine ? row.invoice_number : null, status: row.status, yours: row.mine }));
}

export async function getDocument(owner: SessionUser, documentId: string) {
  const doc = await loadDocument(owner, documentId);
  return {
    document: {
      id: doc.id,
      filename: doc.filename,
      mimeType: doc.mime_type,
      sizeBytes: doc.size_bytes,
      sha256: doc.sha256,
      createdAt: new Date(doc.created_at).toISOString(),
    },
    extraction: await latestExtraction(doc.id),
    alreadyRegistered: await documentReuse(doc.sha256, owner.id),
  };
}

export async function getDocumentContent(owner: SessionUser, documentId: string) {
  await loadDocument(owner, documentId);
  const db = await getDb();
  const { rows } = await db.query<{ content: Uint8Array; mime_type: string; filename: string }>(
    `SELECT content, mime_type, filename FROM documents WHERE id = $1 AND owner_id = $2`,
    [documentId, owner.id],
  );
  return { content: Buffer.from(rows[0].content), mimeType: rows[0].mime_type, filename: rows[0].filename };
}

async function extractAndStore(documentId: string, buffer: Buffer, mime: DocumentMime, requested?: "claude" | "local") {
  const db = await getDb();
  try {
    const result = await runExtraction(buffer, mime, requested);
    const issues = validateInvoice(result.fields, result.confidence);
    if (result.text) await db.query(`UPDATE documents SET extracted_text = $2 WHERE id = $1`, [documentId, result.text.slice(0, 50_000)]);
    await db.query(`INSERT INTO extractions (document_id, engine, status, fields, confidence, issues) VALUES ($1, $2, 'succeeded', $3, $4, $5)`, [
      documentId,
      result.engine,
      JSON.stringify(result.fields),
      JSON.stringify(result.confidence),
      JSON.stringify(issues),
    ]);
  } catch (error) {
    const message = error instanceof HttpError && error.expose ? error.message : "Extraction failed.";
    if (!(error instanceof HttpError)) logger.error({ err: error instanceof Error ? error.message : String(error) }, "extraction failed");
    await db.query(`INSERT INTO extractions (document_id, engine, status, error) VALUES ($1, $2, 'failed', $3)`, [documentId, requested ?? "auto", message]);
  }
}

export async function uploadDocument(owner: SessionUser, file: { buffer: Buffer; originalname: string; mimetype: string }) {
  const config = getConfig();
  if (!file.buffer?.length) throw new HttpError(400, "The uploaded file is empty.");
  if (file.buffer.length > config.MAX_UPLOAD_BYTES) throw new HttpError(413, `File is larger than ${Math.round(config.MAX_UPLOAD_BYTES / 1024 / 1024)} MB.`);
  const mime = sniffMime(file.buffer);
  if (!mime) throw new HttpError(415, "Unsupported file. Upload a PDF, PNG, JPEG or WebP invoice.");
  if (file.mimetype && file.mimetype !== "application/octet-stream" && file.mimetype !== mime) {
    throw new HttpError(415, `File content (${mime}) does not match its declared type (${file.mimetype}).`);
  }

  const sha256 = crypto.createHash("sha256").update(file.buffer).digest("hex");
  const db = await getDb();
  const existing = await db.query<{ id: string }>(`SELECT id FROM documents WHERE owner_id = $1 AND sha256 = $2`, [owner.id, sha256]);
  if (existing.rows[0]) {
    const result = await getDocument(owner, existing.rows[0].id);
    return { ...result, duplicateUpload: true };
  }

  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO documents (owner_id, filename, mime_type, size_bytes, sha256, content) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [owner.id, safeFilename(file.originalname), mime, file.buffer.length, sha256, file.buffer],
  );
  await audit(db, owner.id, "document.upload", "document", rows[0].id, { mime, size: file.buffer.length });
  await extractAndStore(rows[0].id, file.buffer, mime);
  return { ...(await getDocument(owner, rows[0].id)), duplicateUpload: false };
}

export async function reExtract(owner: SessionUser, documentId: string, engine?: "claude" | "local") {
  const content = await getDocumentContent(owner, documentId);
  await extractAndStore(documentId, content.content, content.mimeType as DocumentMime, engine);
  return getDocument(owner, documentId);
}

async function loadExtractionForOwner(owner: SessionUser, extractionId: string) {
  if (!/^[0-9a-f-]{36}$/i.test(extractionId)) throw new HttpError(404, "Extraction not found.");
  const db = await getDb();
  const { rows } = await db.query<ExtractionRow>(
    `SELECT e.* FROM extractions e JOIN documents d ON d.id = e.document_id WHERE e.id = $1 AND d.owner_id = $2`,
    [extractionId, owner.id],
  );
  if (!rows[0]) throw new HttpError(404, "Extraction not found.");
  return rows[0];
}

/** Stores the human-reviewed version of the fields. Only reviewed data can become an invoice. */
export async function reviewExtraction(owner: SessionUser, extractionId: string, fields: ExtractedInvoice) {
  const row = await loadExtractionForOwner(owner, extractionId);
  const reviewed = extractedInvoiceSchema.parse(fields);
  const issues = validateInvoice(reviewed);
  const db = await getDb();
  await db.query(`UPDATE extractions SET reviewed_fields = $2, reviewed_at = now(), issues = $3 WHERE id = $1`, [
    row.id,
    JSON.stringify(reviewed),
    JSON.stringify(issues),
  ]);
  await audit(db, owner.id, "extraction.review", "extraction", row.id);
  return extractionDto((await loadExtractionForOwner(owner, extractionId)) as ExtractionRow);
}

export async function createInvoiceFromExtraction(owner: SessionUser, extractionId: string, terms: { discountBps: number; notes?: string | null; buyerCountry?: string | null }) {
  const row = await loadExtractionForOwner(owner, extractionId);
  if (!row.reviewed_at || !row.reviewed_fields) {
    throw new HttpError(400, "Review and confirm the extracted fields before creating an invoice.");
  }
  const fields = row.reviewed_fields;
  const errors = validateInvoice(fields).filter((issue) => issue.severity === "error");
  if (errors.length) throw new HttpError(400, `Fix these issues first: ${errors.map((issue) => issue.message).join(" ")}`);

  const input = {
    invoiceNumber: fields.invoiceNumber!,
    issuerName: fields.issuer.name!,
    buyerName: fields.recipient.name!,
    buyerCountry: terms.buyerCountry ?? null,
    currency: fields.currency!,
    issueDate: fields.issueDate!,
    dueDate: fields.dueDate!,
    subtotal: fields.subtotal,
    tax: fields.tax,
    total: fields.total!,
    lineItems: fields.lineItems,
    discountBps: terms.discountBps,
    notes: terms.notes ?? null,
    documentId: row.document_id,
    extractionId: row.id,
  };

  // Idempotent: if listing failed earlier (e.g. the wallet request was declined), the draft
  // made from this extraction is updated and reused instead of failing on a duplicate number.
  const db = await getDb();
  const existing = await db.query<{ id: string; status: string }>(
    `SELECT id, status FROM invoices WHERE extraction_id = $1 AND seller_id = $2 ORDER BY created_at DESC LIMIT 1`,
    [row.id, owner.id],
  );
  if (existing.rows[0]?.status === "draft") return updateDraft(owner, existing.rows[0].id, input);
  if (existing.rows[0] && existing.rows[0].status !== "cancelled") {
    throw new HttpError(409, "This invoice has already been listed. Find it on the Marketplace.");
  }
  return createInvoice(owner, input);
}

export async function listDocuments(owner: SessionUser) {
  const db = await getDb();
  const { rows } = await db.query<{ id: string; filename: string; mime_type: string; size_bytes: number; created_at: Date; invoice_id: string | null }>(
    `SELECT d.id, d.filename, d.mime_type, d.size_bytes, d.created_at,
            (SELECT id FROM invoices i WHERE i.document_id = d.id LIMIT 1) AS invoice_id
       FROM documents d WHERE d.owner_id = $1 ORDER BY d.created_at DESC LIMIT 100`,
    [owner.id],
  );
  return rows.map((row) => ({
    id: row.id,
    filename: row.filename,
    mimeType: row.mime_type,
    sizeBytes: row.size_bytes,
    createdAt: new Date(row.created_at).toISOString(),
    invoiceId: row.invoice_id,
  }));
}

export async function deleteDocument(owner: SessionUser, documentId: string) {
  await loadDocument(owner, documentId);
  const db = await getDb();
  const used = await db.query(`SELECT 1 FROM invoices WHERE document_id = $1 AND status <> 'draft'`, [documentId]);
  if (used.rows.length) throw new HttpError(409, "This document backs a listed invoice and cannot be deleted.");
  await db.query(`DELETE FROM documents WHERE id = $1 AND owner_id = $2`, [documentId, owner.id]);
  await audit(db, owner.id, "document.delete", "document", documentId);
}
