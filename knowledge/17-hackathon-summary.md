---
title: Summary for judges and reviewers
category: business
---
# Fintrix in two minutes (for judges and reviewers)

**Problem:** SMEs wait months to be paid; invoice finance is slow, opaque and prone to double-financing fraud.

**Solution:** an invoice marketplace where invoices are extracted by AI, verified by the seller, and financed through a Soroban escrow contract on Stellar.

**What is technically interesting:**
1. **Real escrow contract with on-chain duplicate protection.** The contract records each invoice with its document's SHA-256 hash and refuses a second active listing of the same document. Funding moves tokens investor → seller atomically; repayments are held in the contract until the investor claims them. 12 Rust tests cover lifecycle, auth and failure cases.
2. **Tamper-evident transaction flow.** The server prepares and simulates every transaction, the user signs in their wallet (Freighter or Albedo), and the server accepts only the exact prepared transaction (hash check), waits for network confirmation, then syncs its database from contract state.
3. **Human-in-the-loop document AI.** Claude or local OCR extracts invoice fields with per-field confidence; deterministic validators check the arithmetic; nothing becomes an invoice without explicit review.
4. **Grounded assistant.** RAG over this knowledge base with hybrid vector + full-text retrieval, cited sources, audience modes and prompt-injection boundaries; no canned fallbacks.
5. **Honest ML.** A logistic-regression late-payment model with documented data and metrics, and an evaluated duplicate detector.

**Status:** fully working end-to-end on Stellar testnet. Limitations are listed in "Known limitations".
