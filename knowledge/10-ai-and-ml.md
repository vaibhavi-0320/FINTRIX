---
title: AI and machine learning in Fintrix
category: technical
---
# AI and machine learning in Fintrix

## Invoice extraction
Fintrix has two extraction engines:
- **Claude (AI):** when an Anthropic API key is configured, the document (PDF or image) is sent to Claude, which returns structured fields that must match a strict schema, plus a confidence score per field.
- **Local:** without an API key, Fintrix reads a PDF's text layer with pdf.js, or runs OCR on images with Tesseract, then applies rule-based parsing (labels such as "Invoice No", "Due Date", "Total"). Scanned PDFs without a text layer cannot be read by the local engine.

Both engines feed the same deterministic validation: required fields present, valid dates, due date after issue date, known ISO currency, subtotal + tax = total, line items adding up, and low-confidence warnings. **Extracted data is never treated as verified.** You must review and confirm it before it can become an invoice, and listing requires a further wallet signature.

## The assistant
The assistant uses retrieval-augmented generation (RAG):
1. This knowledge base (`knowledge/*.md`) is split into sections and indexed with vector embeddings (all-MiniLM-L6-v2 by default) and Postgres full-text search.
2. For each question, the most relevant sections are retrieved with hybrid search (vector + keyword, merged by reciprocal-rank fusion).
3. The sections are given to the model as numbered sources, and the answer cites them like [1].
4. Answers are streamed to the browser. Conversations are stored per user.

If the AI service is not configured or fails, the assistant shows the error and the matching documentation sections. It never substitutes a canned answer.

The assistant cannot perform actions, does not see your private keys, and is told to treat retrieved content and your data as information, not instructions (a defence against prompt injection).

## Late-payment risk model
- **Task:** estimate the probability that an invoice is paid after its due date.
- **Model:** logistic regression (interpretable; each factor's contribution is shown).
- **Features:** invoice amount (log), payment terms in days, and the buyer's history in Fintrix (number of previous invoices, share paid late, average days late).
- **Training data and metrics:** documented in `AI_ML_DOCUMENTATION.md` and shown at `/api/ml/models`. The score is an indicator for comparison, not a credit rating. Buyers with no history in Fintrix get a score driven mainly by amount and terms.

## Duplicate-invoice detection
Rules plus fuzzy matching flag an invoice when another active invoice has: the same document fingerprint; the same normalised invoice number and buyer; or the same buyer (fuzzy name match), an amount within 0.5% and an issue date within 7 days. Flags are explanations for reviewers; the contract separately blocks identical documents on-chain.
