---
title: Known limitations
category: product
---
# Known limitations

- **Testnet only.** No real funds. The contract is deployed on testnet only and has not been audited.
- **Settlement in XLM.** The testnet deployment settles in XLM using a fixed configured USD conversion rate, not a market price.
- **USD only for listing.** Other currencies can be stored but not listed.
- **One investor per invoice.** No partial or syndicated funding.
- **No buyer verification.** Fintrix cannot confirm an invoice is genuine or that the buyer owes the money. The on-chain duplicate check only prevents the same document being financed twice.
- **Wallets.** Only Freighter and Albedo are supported for signing.
- **No drafts screen.** If listing fails, the draft is reused when you retry from the upload form, but the app has no separate drafts list.
- **Local extraction** cannot read scanned PDFs, and rule-based parsing works best on conventionally laid-out invoices. AI extraction requires an Anthropic API key.
- **Risk model** is trained on public or synthetic data (see AI_ML_DOCUMENTATION.md), not Fintrix repayment history, and has limited predictive power for new buyers.
- **Assistant** requires an Anthropic API key. Its knowledge is limited to this knowledge base and general knowledge.
- **No fees, KYC or legal agreements** are implemented.
