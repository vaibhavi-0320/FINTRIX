<div align="center">

<img src="frontend/public/fintrix-brand.png" alt="Fintrix" width="96" />

# Fintrix

### Invoice financing on Stellar, with a Soroban escrow contract and human-reviewed AI

[![Stellar](https://img.shields.io/badge/Stellar-Testnet-000000?style=flat-square&logo=stellar&logoColor=4fc3f7&labelColor=000000)](STELLAR_INTEGRATION.md)
[![Soroban](https://img.shields.io/badge/Soroban-escrow_contract-000000?style=flat-square&labelColor=000000&color=4fc3f7)](contracts/src/contract.rs)
[![React](https://img.shields.io/badge/React-19-000000?style=flat-square&logo=react&logoColor=4fc3f7&labelColor=000000)](frontend)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-000000?style=flat-square&logo=typescript&logoColor=4fc3f7&labelColor=000000)](tsconfig.json)
[![License: MIT](https://img.shields.io/badge/License-MIT-000000?style=flat-square&labelColor=000000&color=4fc3f7)](LICENSE)

**Testnet prototype. Test tokens have no value. Not a regulated financial service, not financial advice.**

</div>

---

## What is Fintrix?

Small businesses wait 30–90 days to be paid. Fintrix lets them turn an unpaid invoice into cash now:

1. **Upload** an invoice (PDF or image). Fintrix extracts the fields with Claude AI, or with local OCR and rules when no AI key is configured, and checks the arithmetic.
2. **Review and confirm.** Every field shows a confidence score. Nothing extracted is used until the seller confirms it.
3. **List on-chain.** A Soroban smart contract records the terms and the document's SHA-256 fingerprint. The same document cannot be listed twice, which blocks double financing.
4. **Fund.** An investor signs a transaction in their own Freighter wallet; the price (total minus discount) moves directly to the seller.
5. **Repay and settle.** The seller repays into the contract, which holds the money in escrow until the investor claims it.

Every success message appears only after the Stellar network confirms the transaction, with a link to the block explorer.

## Screenshots

| Landing page | Dashboard |
|---|---|
| ![Landing Page](Screenshots/Landing-Page.png) | ![Dashboard](Screenshots/Dashboard.png) |
| **Upload invoice** | **Investment simulator** |
| ![Upload Invoice](Screenshots/Invoice-Upload.png) | ![Simulator](Screenshots/Investment-Simulator.png) |
| **Marketplace** | **Deal detail** |
| ![Marketplace](Screenshots/Marketplace.png) | ![Deal Detail](Screenshots/Deal-Detail.png) |
| **Resources** | |
| ![Resources](Screenshots/Resources.png) | |

## Main features

| | |
|---|---|
| **Wallet sign-in** | Freighter or Albedo from the Connect Wallet screen; the wallet signs a one-time SEP-53 challenge, the server verifies it and sets an HTTP-only session cookie |
| **Invoice extraction** | Claude (structured output, per-field confidence) or local pdf.js/Tesseract OCR + rules; deterministic validation; mandatory human review |
| **Soroban escrow** | create, fund, repay (escrowed), claim, cancel, default; on-chain duplicate-document block; 12 Rust tests |
| **Verified transactions** | server prepares and simulates → wallet signs → server accepts only the exact prepared tx → waits for confirmation → syncs from contract state |
| **Marketplace & deal detail** | real on-chain listings; the deal page shows the next valid action (fund, repay, claim, cancel, mark defaulted) and confirms each one on testnet |
| **Investment simulator** | projects a deal's return and records the simulation on testnet as a 1 XLM self-payment with a memo (no investment is made) |
| **Dashboard** | balance, portfolio, activity and simulations computed only from real data |
| **AI assistant** | streaming RAG over a 17-article knowledge base, numbered citations, 5 audience styles, follow-up suggestions, saved conversations, no canned fallbacks |
| **ML** | late-payment logistic-regression model (metrics documented) and an evaluated duplicate detector |
| **Resources** | guides and articles about invoice financing and Fintrix |

## Architecture

```
React SPA ──(same-origin, session cookie, CSRF header)──▶ Express API
                                                           ├─ Postgres + pgvector (PGlite locally)
                                                           ├─ Stellar RPC → Soroban escrow contract
                                                           ├─ Horizon (balances, activity)
                                                           └─ Claude API (optional) · Voyage (optional)
Freighter / Albedo ◀── signs sign-in messages and every transaction
```
Details: [ARCHITECTURE.md](ARCHITECTURE.md) · API: [docs/API.md](docs/API.md)

## Tech stack
- **Frontend:** React 19 (single-page app, view state in `App.tsx`), Tailwind CSS 3, Vite 8, motion, lucide-react
- **Backend:** Node 22, Express 4, zod, pino, multer, express-rate-limit (Postgres store)
- **Database:** PostgreSQL + pgvector (production), PGlite (local and tests)
- **Blockchain:** Soroban (Rust, soroban-sdk 25), `@stellar/stellar-sdk` 17, `@stellar/freighter-api` 6, Stellar CLI
- **AI/ML:** `@anthropic-ai/sdk` (Claude), transformers.js (MiniLM embeddings), pdf.js, tesseract.js, Python + scikit-learn
- **Testing:** Vitest, Testing Library, Supertest, Playwright, cargo test

## Quick start (local)

**Prerequisites:** Node.js 22+ and npm 10+. Optional: Python 3.11+ (ML retraining), Rust with the `wasm32v1-none` target and the Stellar CLI (contract work), and the [Freighter](https://www.freighter.app/) browser extension.

```bash
npm ci
cp .env.example .env          # works as-is: testnet contract, local database, no AI key needed
npm run dev                   # http://127.0.0.1:3000
```

The first start creates the local database (`.data/pglite`), applies migrations, and indexes the knowledge base. Indexing downloads the ~23 MB embedding model once.

**Try it with Freighter:**
1. In Freighter, switch the network to **Testnet** and create or select an account.
2. Get free test XLM: in Freighter use *Fund with Friendbot*, or open `https://friendbot.stellar.org/?addr=<your address>`.
3. Open http://127.0.0.1:3000 → **Connect Wallet** → **Freighter** (or **Albedo**) → approve the sign-in message.
4. Optional: `npm run demo:seed` creates three clearly labelled demo listings on testnet that you can fund. After funding, run `npm run demo:repay`, then **CLAIM REPAYMENT** on the deal page.
5. To test as seller **and** investor, use two Freighter accounts. You can't fund your own invoice.

## Environment variables
All variables are documented in [.env.example](.env.example). The important ones:

| Variable | Needed for | Where to get it |
|---|---|---|
| `ANTHROPIC_API_KEY` | AI extraction + assistant | console.anthropic.com → API keys. Put it in `.env` (server-only) |
| `DATABASE_URL` | production database | Neon / Supabase Postgres with pgvector |
| `FINTRIX_CONTRACT_ID`, `SETTLEMENT_TOKEN_ID` | on-chain features | preset to the deployed testnet contract |
| `EMBEDDINGS_PROVIDER`, `VOYAGE_API_KEY` | retrieval | `local` needs nothing; use `voyage` on Vercel |
| `USD_PER_XLM` | USD → XLM conversion | fixed testnet rate (default 0.11) |

Without `ANTHROPIC_API_KEY`, extraction uses local OCR, and the assistant shows a clear error together with the matching help articles.

## Database setup
- **Local:** nothing to do. PGlite stores data in `.data/pglite`; delete the folder to reset.
- **Production:** set `DATABASE_URL` to a Postgres 15+ database with the `vector` extension. Migrations in `backend/db/migrations/` run automatically. Backup and recovery are covered in [DATASET_DOCUMENTATION.md](DATASET_DOCUMENTATION.md#backup-and-recovery).

## AI setup
Add `ANTHROPIC_API_KEY` to `.env` and restart. The default model is `claude-opus-5-5` (`ANTHROPIC_MODEL`). The knowledge base lives in `knowledge/*.md`; after editing it, run `npm run kb:ingest` (it also re-ingests automatically on start). See [AI_ML_DOCUMENTATION.md](AI_ML_DOCUMENTATION.md).

## Dataset and ML setup
```bash
py -m venv ml/.venv            # macOS/Linux: python3 -m venv ml/.venv
ml/.venv/Scripts/python -m pip install -r ml/requirements.txt
npm run ml:data                # synthetic ledger → ml/data (git-ignored)
npm run ml:train               # retrains → backend/modules/ml/models/risk-model.json
npm run ml:eval-duplicates     # duplicate-detector metrics
```
The training data is **synthetic and labelled as such**. [DATASET_DOCUMENTATION.md](DATASET_DOCUMENTATION.md) explains why no public dataset was used.

## Stellar testnet setup
The app is preconfigured with the deployed testnet contract. To deploy your own, see [STELLAR_INTEGRATION.md](STELLAR_INTEGRATION.md):
```bash
npm run contract:test && npm run contract:build
stellar contract deploy --wasm target/wasm32v1-none/release/fintrix_escrow.wasm \
  --source-account <identity> --network testnet -- --token $(stellar contract id asset --asset native --network testnet)
```

## Testing
```bash
npm run check              # typecheck + lint + unit/integration tests + build
npm run contract:test      # Soroban contract (12 tests)
npx playwright install chromium && npm run test:e2e
npm run test:testnet       # full lifecycle on Stellar testnet (network)
npm run test:e2e:testnet   # the same, through the UI
```
Coverage and current results: [TESTING.md](TESTING.md).

## Deployment
A Vercel build (static app plus one Node function) is ready (`npm run build:vercel`) but **has not been deployed**. See [DEPLOYMENT.md](DEPLOYMENT.md) for what runs where and the required variables.

## Known limitations
- Testnet only; contract and app **not audited**.
- Settles in XLM at a fixed configured rate; only USD invoices can be listed; one investor per invoice.
- No buyer verification, KYC, fees or legal agreements.
- Only the Freighter wallet is supported.
- Local extraction cannot read scanned PDFs; Claude extraction and assistant answers were not quality-evaluated (no API key during development).
- The risk model is trained on **synthetic** data and was not evaluated on buyers without history.
- Full list: [knowledge/15-limitations.md](knowledge/15-limitations.md).

## Documentation
[PROJECT_AUDIT.md](PROJECT_AUDIT.md) · [ARCHITECTURE.md](ARCHITECTURE.md) · [docs/API.md](docs/API.md) · [STELLAR_INTEGRATION.md](STELLAR_INTEGRATION.md) · [AI_ML_DOCUMENTATION.md](AI_ML_DOCUMENTATION.md) · [DATASET_DOCUMENTATION.md](DATASET_DOCUMENTATION.md) · [SECURITY.md](SECURITY.md) · [TESTING.md](TESTING.md) · [DEPLOYMENT.md](DEPLOYMENT.md) · [Beta feedback (previous version)](docs/BETA_FEEDBACK.md)

## License
[MIT](LICENSE)
