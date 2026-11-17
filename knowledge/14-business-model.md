---
title: Business model and roadmap
category: business
---
# Business model, market and roadmap

## Who it serves
- **Sellers:** small and medium-sized businesses, including exporters, that issue invoices with 30–90 day payment terms and need working capital sooner.
- **Investors:** individuals or funds seeking short-duration, asset-backed returns with transparent on-chain settlement.

## How Fintrix could earn revenue (not implemented)
The current prototype charges no fees. A production model could include a platform fee on each financed invoice (a share of the discount), a fee on investor returns, and paid verification services. None of these fees exist in the code today.

## Why Stellar
Fast finality (about 5 seconds), very low fees, built-in support for regulated stablecoins such as USDC, and a growing network of anchors for moving between local currencies and on-chain assets. These matter for cross-border SME finance.

## What is implemented today
Wallet sign-in; invoice upload, extraction, validation and review; draft management; on-chain listing, funding, repayment escrow, claim, cancel and default on Stellar testnet; marketplace; transaction history; RAG assistant; risk scoring and duplicate detection.

## What a production launch would still need
- Legal structure, licences and compliance (KYC/AML for sellers and investors, securities and lending rules per jurisdiction).
- Settlement in a stablecoin and fiat on/off-ramps through Stellar anchors.
- Buyer verification and confirmation that invoices are genuine (e.g. buyer acknowledgement, e-invoicing network integration).
- Partial funding by multiple investors, secondary market, credit insurance.
- External security audit of the contract and application.
- A risk model trained on real repayment data from the platform.
