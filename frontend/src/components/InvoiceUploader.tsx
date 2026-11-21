import { FileText, LoaderCircle, RefreshCcw, ShieldCheck, UploadCloud } from "lucide-react";
import { useEffect, useRef, useState, type DragEvent } from "react";
import { confirmAndListInvoice, uploadInvoiceDocument, type ExtractedFields, type UploadResult } from "../services/stellarService";
import type { ConnectedWallet, Invoice } from "../types";

export interface ParsedInvoice {
  fileName: string;
  fileSize: string;
  previewUrl: string | null;
  isPDF: boolean;
  extractedData: {
    invoiceNumber: string;
    company: string;
    amount: string;
    dueDate: string;
    currency: string;
  };
}

interface InvoiceUploaderProps {
  onParsed?: (data: ParsedInvoice) => void;
  wallet?: ConnectedWallet | null;
  onListed?: (invoice: Invoice) => void;
}

const MAX_BYTES = 4 * 1024 * 1024;

function emptyFields(): ExtractedFields {
  return { invoiceNumber: null, issueDate: null, dueDate: null, issuer: { name: null, address: null, taxId: null }, recipient: { name: null, address: null, taxId: null }, currency: "USD", subtotal: null, tax: null, total: null, lineItems: [] };
}

const fieldStyle: React.CSSProperties = { width: "100%", background: "#020617", border: "1px solid #1e293b", borderRadius: "6px", padding: "8px 10px", color: "#e2e8f0", fontFamily: "monospace", fontSize: "0.82rem", outline: "none", boxSizing: "border-box" };
const labelStyle: React.CSSProperties = { color: "#6b7280", fontSize: "0.7rem", display: "block", marginBottom: "4px" };

const ACCEPTED = ["application/pdf", "image/png", "image/jpeg", "image/jpg"];

export function InvoiceUploader({ onParsed, wallet, onListed }: InvoiceUploaderProps) {
  const [isDragging, setIsDragging] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [parsed, setParsed] = useState<ParsedInvoice | null>(null);
  const [parsing, setParsing] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const previewUrlRef = useRef<string | null>(null);
  const [upload, setUpload] = useState<UploadResult | null>(null);
  const [fields, setFields] = useState<ExtractedFields>(emptyFields());
  const [discount, setDiscount] = useState("3");
  const [listing, setListing] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [listed, setListed] = useState<{ txHash: string; explorerUrl: string } | null>(null);

  useEffect(() => {
    return () => {
      if (previewUrlRef.current) {
        URL.revokeObjectURL(previewUrlRef.current);
      }
    };
  }, []);

  const handleFile = async (nextFile: File) => {
    if (!ACCEPTED.includes(nextFile.type)) {
      window.alert("Please upload a PDF, PNG, or JPG file.");
      return;
    }

    if (nextFile.size > MAX_BYTES) {
      window.alert("File too large. Max 4MB.");
      return;
    }

    if (previewUrlRef.current) {
      URL.revokeObjectURL(previewUrlRef.current);
      previewUrlRef.current = null;
    }

    setFile(nextFile);
    setParsing(true);
    setParsed(null);

    setListError(null);
    setListed(null);

    // Real upload: the server checks the file type, stores it and extracts the fields
    // (Claude when configured, otherwise PDF text / OCR + rules).
    let result: UploadResult;
    try {
      result = await uploadInvoiceDocument(nextFile);
    } catch (error) {
      setParsing(false);
      setFile(null);
      window.alert(error instanceof Error ? error.message : "Upload failed.");
      return;
    }

    const previewUrl = nextFile.type.startsWith("image/") ? URL.createObjectURL(nextFile) : null;
    previewUrlRef.current = previewUrl;
    const extracted = result.extraction?.fields ?? emptyFields();
    const amount = extracted.total !== null ? `${extracted.currency === "USD" || !extracted.currency ? "$" : `${extracted.currency} `}${extracted.total.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : "Not found";

    const parsedData: ParsedInvoice = {
      fileName: nextFile.name,
      fileSize: `${(nextFile.size / 1024).toFixed(1)} KB`,
      previewUrl,
      isPDF: nextFile.type === "application/pdf",
      extractedData: {
        invoiceNumber: extracted.invoiceNumber ?? "Not found",
        company: extracted.issuer.name ?? "Not found",
        amount,
        dueDate: extracted.dueDate ?? "Not found",
        currency: extracted.currency ?? "—",
      },
    };

    setUpload(result);
    setFields({ ...extracted, currency: extracted.currency ?? "USD" });
    setParsed(parsedData);
    setParsing(false);
    onParsed?.(parsedData);

    window.dispatchEvent(
      new CustomEvent("fintrix:chat-notify", {
        detail: {
          message:
            result.extraction?.status === "succeeded"
              ? `Invoice "${nextFile.name}" was read by ${result.extraction.engine}. Found invoice ${parsedData.extractedData.invoiceNumber}, amount ${amount}, due ${parsedData.extractedData.dueDate}. Please review the fields before listing.`
              : `Invoice "${nextFile.name}" was uploaded, but the fields could not be extracted (${result.extraction?.error ?? "unknown error"}). You can enter them manually.`,
          timestamp: new Date().toISOString(),
        },
      }),
    );
  };

  const setField = (patch: Partial<ExtractedFields>) => setFields((current) => ({ ...current, ...patch }));
  const num = (value: string) => (value.trim() === "" ? null : Number(value));

  const listOnMarketplace = async () => {
    if (!upload?.extraction) return;
    if (!wallet) {
      setListError("Connect your wallet first.");
      return;
    }
    const discountBps = Math.round(Number(discount) * 100);
    if (!Number.isFinite(discountBps) || discountBps < 0 || discountBps > 3000) {
      setListError("Discount must be between 0% and 30%.");
      return;
    }
    setListing(true);
    setListError(null);
    try {
      const result = await confirmAndListInvoice(upload.extraction.id, { ...fields, currency: (fields.currency ?? "USD").toUpperCase() }, discountBps, wallet);
      setListed({ txHash: result.txHash, explorerUrl: result.explorerUrl });
      onListed?.(result.invoice as Invoice);
    } catch (error) {
      setListError(error instanceof Error ? error.message : "Listing failed.");
    } finally {
      setListing(false);
    }
  };

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setIsDragging(false);
    const dropped = event.dataTransfer.files[0];
    if (dropped) {
      void handleFile(dropped);
    }
  };

  const reset = () => {
    if (previewUrlRef.current) {
      URL.revokeObjectURL(previewUrlRef.current);
      previewUrlRef.current = null;
    }
    setFile(null);
    setParsed(null);
    setParsing(false);
    setUpload(null);
    setFields(emptyFields());
    setListed(null);
    setListError(null);
    if (inputRef.current) {
      inputRef.current.value = "";
    }
  };

  return (
    <div style={{ marginTop: "16px" }}>
      {!file ? (
        <div
          onDragOver={(event) => {
            event.preventDefault();
            setIsDragging(true);
          }}
          onDragLeave={() => setIsDragging(false)}
          onDrop={onDrop}
          onClick={() => inputRef.current?.click()}
          style={{
            border: `2px dashed ${isDragging ? "#3b82f6" : "#334155"}`,
            borderRadius: "12px",
            padding: "32px 20px",
            textAlign: "center",
            background: isDragging
              ? "linear-gradient(180deg, rgba(2,6,23,0.88) 0%, rgba(15,23,42,1) 100%)"
              : "linear-gradient(180deg, rgba(2,6,23,0.78) 0%, rgba(15,23,42,0.96) 100%)",
            boxShadow: isDragging ? "0 0 0 1px rgba(59,130,246,0.3), 0 0 28px rgba(59,130,246,0.12)" : "none",
            transition: "all 0.2s ease",
          }}
        >
          <div
            style={{
              width: "60px",
              height: "60px",
              margin: "0 auto 14px",
              display: "grid",
              placeItems: "center",
              borderRadius: "18px",
              background: "rgba(59,130,246,0.12)",
              color: "#93c5fd",
              boxShadow: "inset 0 0 0 1px rgba(59,130,246,0.16)",
            }}
          >
            <UploadCloud size={28} />
          </div>
          <p style={{ color: "#e2e8f0", fontWeight: 600, marginBottom: "6px", fontSize: "0.95rem" }}>
            Drop your invoice here
          </p>
          <p style={{ color: "#6b7280", fontSize: "0.8rem", marginBottom: "18px" }}>
            PDF, PNG, JPG. Max 4MB.
          </p>
          <button
            type="button"
            style={{
              padding: "8px 20px",
              background: "rgba(15,23,42,0.9)",
              border: "1px solid #334155",
              borderRadius: "999px",
              color: "#cbd5e1",
              fontSize: "0.8rem",
            }}
          >
            Browse Files
          </button>
          <input
            ref={inputRef}
            type="file"
            accept=".pdf,.png,.jpg,.jpeg"
            style={{ display: "none" }}
            onChange={(event) => {
              if (event.target.files?.[0]) {
                void handleFile(event.target.files[0]);
              }
            }}
          />
        </div>
      ) : parsing ? (
        <div
          style={{
            background: "#0f172a",
            borderRadius: "12px",
            padding: "32px",
            textAlign: "center",
            border: "1px solid #1e293b",
          }}
        >
          <div
            style={{
              width: "56px",
              height: "56px",
              margin: "0 auto 16px",
              display: "grid",
              placeItems: "center",
              borderRadius: "50%",
              border: "1px solid rgba(59,130,246,0.28)",
              background: "rgba(2,6,23,0.9)",
              color: "#60a5fa",
            }}
          >
            <LoaderCircle size={28} style={{ animation: "fintrixSpin 0.8s linear infinite" }} />
          </div>
          <style>{`@keyframes fintrixSpin { to { transform: rotate(360deg); } }`}</style>
          <p style={{ color: "#e2e8f0", fontWeight: 600 }}>AI Parsing Invoice...</p>
          <p style={{ color: "#6b7280", fontSize: "0.78rem", marginTop: "6px" }}>
            Extracting data, running OCR, and checking risk parameters.
          </p>
        </div>
      ) : parsed ? (
        <div
          style={{
            background: "#0f172a",
            borderRadius: "12px",
            border: "1px solid #1e293b",
            overflow: "hidden",
          }}
        >
          <div
            style={{
              padding: "16px 20px",
              borderBottom: "1px solid #1e293b",
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              gap: "12px",
              flexWrap: "wrap",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
              <ShieldCheck size={18} color={upload?.extraction?.status === "succeeded" ? "#4ade80" : "#fbbf24"} />
              <p style={{ color: "#e2e8f0", fontWeight: 600, fontSize: "0.9rem" }}>
                {upload?.extraction?.status === "succeeded" ? `Invoice Parsed Successfully (${upload?.extraction.engine})` : "Extraction failed: enter the details below"}
              </p>
            </div>
            <button
              type="button"
              onClick={reset}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: "8px",
                background: "transparent",
                border: "none",
                color: "#94a3b8",
                fontSize: "0.8rem",
              }}
            >
              <RefreshCcw size={14} />
              Upload different file
            </button>
          </div>

          <div style={{ padding: "20px" }}>
            <div
              style={{
                background: "#020617",
                borderRadius: "8px",
                padding: "20px",
                border: "1px solid #0f172a",
                fontFamily: "monospace",
              }}
            >
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))",
                  gap: "16px",
                  marginBottom: "20px",
                  paddingBottom: "16px",
                  borderBottom: "1px solid #1e293b",
                }}
              >
                <div>
                  <p style={{ color: "#3b82f6", fontSize: "0.7rem", letterSpacing: "0.1em", marginBottom: "4px" }}>
                    INVOICE FROM
                  </p>
                  <p style={{ color: "#e2e8f0", fontSize: "0.85rem", fontWeight: 600 }}>
                    {parsed.extractedData.company}
                  </p>
                  <p style={{ color: "#6b7280", fontSize: "0.72rem" }}>{parsed.fileName}</p>
                </div>
                <div>
                  <p style={{ color: "#3b82f6", fontSize: "0.7rem", letterSpacing: "0.1em", marginBottom: "4px" }}>
                    INVOICE TO
                  </p>
                  <p style={{ color: "#e2e8f0", fontSize: "0.85rem", fontWeight: 600 }}>
                    {fields.recipient.name ?? "Not found"}
                  </p>
                  <p style={{ color: "#6b7280", fontSize: "0.72rem" }}>Buyer (owes the invoice)</p>
                </div>
                <div>
                  <p style={{ color: "#3b82f6", fontSize: "0.7rem", letterSpacing: "0.1em", marginBottom: "4px" }}>
                    PAYMENT DETAILS
                  </p>
                  <p style={{ color: "#e2e8f0", fontSize: "0.85rem", fontWeight: 600 }}>
                    {parsed.extractedData.invoiceNumber}
                  </p>
                  <p style={{ color: "#6b7280", fontSize: "0.72rem" }}>Due: {parsed.extractedData.dueDate}</p>
                </div>
              </div>

              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))",
                  gap: "16px",
                  marginBottom: "16px",
                }}
              >
                <div>
                  <p style={{ color: "#6b7280", fontSize: "0.7rem" }}>DESCRIPTION</p>
                  <p style={{ color: "#e2e8f0", fontSize: "0.82rem", marginTop: "4px" }}>
                    Invoice Financing Request
                  </p>
                </div>
                <div>
                  <p style={{ color: "#6b7280", fontSize: "0.7rem" }}>FILE SIZE</p>
                  <p style={{ color: "#e2e8f0", fontSize: "0.82rem", marginTop: "4px" }}>{parsed.fileSize}</p>
                </div>
                <div>
                  <p style={{ color: "#6b7280", fontSize: "0.7rem" }}>AMOUNT</p>
                  <p style={{ color: "#4ade80", fontSize: "1rem", fontWeight: 700, marginTop: "4px" }}>
                    {parsed.extractedData.amount}
                  </p>
                </div>
              </div>

              <div
                style={{
                  background: "#0f172a",
                  borderRadius: "6px",
                  padding: "10px 14px",
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  gap: "12px",
                  flexWrap: "wrap",
                }}
              >
                <div style={{ display: "flex", gap: "16px", flexWrap: "wrap" }}>
                  {[
                    upload?.extraction?.status === "succeeded" ? (upload?.extraction.engine.startsWith("claude") ? "AI Extraction Complete" : upload?.extraction.engine.includes("ocr") ? "OCR Complete" : "Text Extracted") : "Extraction Failed",
                    (upload?.extraction?.issues ?? []).some((issue) => issue.severity === "error") ? "Fix Highlighted Issues" : "Structure Valid",
                    "Human Review Required",
                  ].map((tag) => (
                    <span
                      key={tag}
                      style={{
                        color: tag.includes("Fail") || tag.includes("Fix") ? "#fbbf24" : "#4ade80",
                        fontSize: "0.7rem",
                        display: "flex",
                        alignItems: "center",
                        gap: "4px",
                      }}
                    >
                      <ShieldCheck size={12} />
                      {tag}
                    </span>
                  ))}
                </div>
                <span
                  style={{
                    background: "#052e16",
                    color: "#4ade80",
                    padding: "3px 12px",
                    borderRadius: "999px",
                    fontSize: "0.7rem",
                    fontWeight: 600,
                  }}
                >
                  {listed ? "LISTED ON-CHAIN" : "REVIEW & CONFIRM BELOW"}
                </span>
              </div>
            </div>

            {parsed.previewUrl && (
              <div
                style={{
                  marginTop: "12px",
                  borderRadius: "8px",
                  overflow: "hidden",
                  border: "1px solid #1e293b",
                  maxHeight: "220px",
                  background: "#020617",
                }}
              >
                <img
                  src={parsed.previewUrl}
                  alt="Invoice preview"
                  style={{ width: "100%", height: "100%", objectFit: "cover" }}
                />
              </div>
            )}

            {parsed.isPDF && (
              <div
                style={{
                  marginTop: "12px",
                  borderRadius: "8px",
                  border: "1px solid #1e293b",
                  background: "#020617",
                  padding: "14px 16px",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: "10px",
                  color: "#94a3b8",
                  fontSize: "0.78rem",
                }}
              >
                <FileText size={16} />
                PDF uploaded: {parsed.fileName}
              </div>
            )}

            {(upload?.alreadyRegistered.length ?? 0) > 0 && (
              <p style={{ marginTop: "12px", color: "#fbbf24", fontSize: "0.78rem" }}>
                This exact document is already registered on Fintrix. The contract will refuse a second active listing of the same document.
              </p>
            )}

            <div style={{ marginTop: "16px", background: "#020617", borderRadius: "8px", padding: "20px", border: "1px solid #0f172a" }}>
              <p style={{ color: "#3b82f6", fontSize: "0.7rem", letterSpacing: "0.1em", marginBottom: "12px" }}>REVIEW EXTRACTED FIELDS</p>
              {(upload?.extraction?.issues ?? []).length > 0 && (
                <ul style={{ listStyle: "none", padding: 0, margin: "0 0 12px", display: "flex", flexDirection: "column", gap: "4px" }}>
                  {(upload?.extraction?.issues ?? []).map((issue, index) => (
                    <li key={index} style={{ color: issue.severity === "error" ? "#f87171" : "#fbbf24", fontSize: "0.75rem" }}>
                      {issue.severity === "error" ? "✕" : "!"} {issue.message}
                    </li>
                  ))}
                </ul>
              )}
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: "12px" }}>
                {([
                  ["Invoice number", fields.invoiceNumber ?? "", (v: string) => setField({ invoiceNumber: v || null }), "text"],
                  ["Issuer (you)", fields.issuer.name ?? "", (v: string) => setField({ issuer: { ...fields.issuer, name: v || null } }), "text"],
                  ["Buyer", fields.recipient.name ?? "", (v: string) => setField({ recipient: { ...fields.recipient, name: v || null } }), "text"],
                  ["Issue date", fields.issueDate ?? "", (v: string) => setField({ issueDate: v || null }), "date"],
                  ["Due date", fields.dueDate ?? "", (v: string) => setField({ dueDate: v || null }), "date"],
                  ["Currency", fields.currency ?? "", (v: string) => setField({ currency: v.toUpperCase() || null }), "text"],
                  ["Subtotal", fields.subtotal?.toString() ?? "", (v: string) => setField({ subtotal: num(v) }), "number"],
                  ["Tax", fields.tax?.toString() ?? "", (v: string) => setField({ tax: num(v) }), "number"],
                  ["Total", fields.total?.toString() ?? "", (v: string) => setField({ total: num(v) }), "number"],
                ] as Array<[string, string, (v: string) => void, string]>).map(([label, value, onChange, type]) => (
                  <label key={label} style={{ display: "block" }}>
                    <span style={labelStyle}>{label.toUpperCase()}</span>
                    <input type={type} value={value} onChange={(event) => onChange(event.target.value)} style={fieldStyle} disabled={Boolean(listed)} />
                  </label>
                ))}
                <label style={{ display: "block" }}>
                  <span style={labelStyle}>DISCOUNT TO INVESTORS (%)</span>
                  <input type="number" value={discount} min="0" max="30" step="0.5" onChange={(event) => setDiscount(event.target.value)} style={fieldStyle} disabled={Boolean(listed)} />
                </label>
              </div>
              {fields.total !== null && Number(discount) >= 0 && (
                <p style={{ color: "#94a3b8", fontSize: "0.75rem", marginTop: "12px" }}>
                  Investor pays {(fields.total * (1 - Number(discount) / 100)).toFixed(2)} {fields.currency} now; you repay {fields.total.toFixed(2)} {fields.currency} by the due date. Only USD invoices can be listed.
                </p>
              )}
              {listed ? (
                <div style={{ marginTop: "12px", padding: "12px", background: "#052e16", borderRadius: "8px", border: "1px solid #16a34a" }}>
                  <p style={{ color: "#4ade80", fontWeight: 600, fontSize: "0.85rem" }}>Listed on Stellar testnet</p>
                  <a href={listed.explorerUrl} target="_blank" rel="noreferrer" style={{ color: "#60a5fa", fontSize: "0.72rem" }}>
                    View transaction {listed.txHash.slice(0, 12)}… →
                  </a>
                </div>
              ) : (
                <button type="button" onClick={() => void listOnMarketplace()} disabled={listing || !upload?.extraction} style={{ marginTop: "16px", width: "100%", padding: "12px 24px", background: "#fff", color: "#000", borderRadius: "999px", border: "none", cursor: listing ? "not-allowed" : "pointer", fontWeight: 600, fontSize: "0.85rem", opacity: listing ? 0.7 : 1 }}>
                  {listing ? "Waiting for wallet & network..." : "Confirm fields & list on marketplace →"}
                </button>
              )}
              {listError && <p style={{ color: "#f87171", fontSize: "0.78rem", marginTop: "8px" }}>{listError}</p>}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
