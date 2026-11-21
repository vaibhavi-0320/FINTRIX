---
title: Architecture
category: technical
---
# Fintrix architecture

## Components

- **Web app (frontend):** React 19 single-page app built with Vite and Tailwind CSS. It keeps the current screen in React state (no URL routing) and talks to the API over HTTPS on the same origin. It connects to the Freighter browser wallet for signing.
- **API (backend):** A Node.js Express application. Locally it is served by `backend/dev-server.ts` together with the web app; on Vercel the same app runs as one serverless function (`backend/vercel-entry.ts`).
- **Database:** PostgreSQL with the pgvector extension. In local development and automated tests Fintrix uses PGlite, an embedded build of Postgres, so no database server is needed. Production uses a hosted Postgres (for example Neon or Supabase) through `DATABASE_URL`. Schema changes are SQL migrations applied automatically at startup.
- **Smart contract:** A Soroban (Rust) contract, `fintrix-escrow`, deployed on Stellar testnet. It records invoices, moves the settlement token for funding, escrows repayments and pays out claims.
- **Stellar access:** The backend uses Stellar RPC to simulate and submit contract transactions and to read contract state, and Horizon to read account balances and history.
- **AI services:** Anthropic Claude (model `claude-opus-5-5` by default) for invoice extraction and for the assistant. Embeddings for knowledge retrieval run locally (all-MiniLM-L6-v2) or through Voyage AI.
- **ML models:** A logistic-regression late-payment risk model trained offline in Python and served from a JSON file, and a rule-plus-similarity duplicate-invoice detector.

## Request flow for a blockchain action

1. The browser asks the API to prepare an action (for example "fund invoice 42").
2. The API checks the user is allowed to perform it, builds the contract call with the user's account as the transaction source, and simulates it on Stellar RPC. Simulation computes fees, the storage footprint and the required authorisations, and catches contract errors before anything is signed.
3. The API stores the expected transaction hash and returns the unsigned transaction.
4. The browser asks the user's wallet (Freighter or Albedo) to sign it. The user sees and approves the transaction in the wallet.
5. The browser sends the signed transaction to the API. The API rejects it unless its hash equals the prepared hash, so nobody can substitute a different transaction.
6. The API submits to Stellar RPC and polls until the network reports SUCCESS or FAILED.
7. On success the API re-reads the invoice from the contract and updates the database from the on-chain state. The chain, not the database, is the source of truth.

## Main data model

users, sessions, auth_challenges, documents, extractions, invoices, chain_transactions, conversations, messages, kb_documents, kb_chunks, rate_limits and audit_log.

## Key source locations

- `backend/app.ts` – all API routes
- `backend/modules/` – auth, invoices, chain (Soroban), documents (extraction), assistant (LLM + RAG), ml
- `backend/db/migrations/` – database schema
- `contracts/src/` – the Soroban smart contract and its tests
- `frontend/src/` – the web app
- `ml/` – Python training and evaluation scripts
- `knowledge/` – this knowledge base
