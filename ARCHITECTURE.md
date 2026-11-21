# Architecture

```
                    ┌─────────────────────────── Browser ───────────────────────────┐
                    │ React 19 SPA (Vite, Tailwind), original Fintrix UI            │
                    │  views: landing · connect wallet · dashboard · simulation     │
                    │  (upload/review/list + simulator) · marketplace · deal detail │
                    │  · resources · floating assistant                             │
                    │  Freighter / Albedo ◀── signs messages & transactions         │
                    └───────────────┬───────────────────────────────────────────────┘
                                    │ same-origin HTTPS, session cookie + CSRF header
                    ┌───────────────▼───────────────────────────────────────────────┐
                    │ Express API (backend/app.ts)                                  │
                    │  http/middleware: session → CSRF → rate limits (Postgres)     │
                    │  modules/                                                     │
                    │   auth       SEP-53 challenge/verify, sessions                │
                    │   invoices   CRUD, terms, visibility, dashboard               │
                    │   chain      prepare → (user signs) → submit → confirm → sync │
                    │   documents  upload, OCR/AI extraction, validation, review    │
                    │   assistant  LLM provider, RAG retrieval, conversations       │
                    │   ml         risk model inference, duplicate detection        │
                    └──┬──────────────┬──────────────────┬──────────────┬───────────┘
                       │              │                  │              │
              ┌────────▼──────┐ ┌─────▼──────────┐ ┌─────▼────────┐ ┌───▼──────────┐
              │ Postgres      │ │ Stellar RPC    │ │ Horizon      │ │ Anthropic    │
              │ + pgvector    │ │ (Soroban)      │ │ (balances,   │ │ Claude API   │
              │ (PGlite in    │ │ escrow contract│ │  activity)   │ │ (optional)   │
              │  dev/tests)   │ └────────────────┘ └──────────────┘ └──────────────┘
              └───────────────┘
```

## Runtime topology
- **Local:** `npm run dev` starts one Node process (`backend/dev-server.ts`). Express serves `/api/*`, and Vite middleware serves the React app with hot reload, all on one origin (http://127.0.0.1:3000). The database is embedded PGlite in `.data/pglite`, so no database server is needed.
- **Vercel:** `npm run build:vercel` produces `.vercel/output/` (Build Output API v3). Static assets go to the CDN; one Node 22 function (`api/index.func`, about 66 MB) runs the same Express app for `/api/*`. Postgres is external (`DATABASE_URL`). See [DEPLOYMENT.md](DEPLOYMENT.md).

## Key design decisions
| Decision | Why |
|---|---|
| One Express app for local and serverless | The old code had three drifting copies of the API. |
| Wallet sign-in instead of email/password | A Stellar account is already a strong identity; no passwords to store. |
| Server prepares, user signs, server verifies the hash, then submits | Users approve exactly what will happen; the server can't sign, and a client can't swap the transaction. |
| Chain is the source of truth | After every confirmed transaction the API re-reads `get_invoice` and syncs the database. |
| Postgres + pgvector, with PGlite locally | One SQL dialect everywhere; vector search without another service; zero-setup local dev and fast isolated tests. |
| Money as integer cents; on-chain amounts as decimal strings | No floating-point drift; no lossy bigint conversion between drivers. |
| Provider interface for LLMs, pluggable embeddings | Swap AI providers without touching business logic. |
| No silent fallbacks | AI or chain failures surface as errors; nothing fabricated is shown. |
| Rate limits stored in Postgres | Correct across serverless instances. |

## Repository layout
```
backend/vercel-entry.ts        Vercel entry (exports the Express app)
backend/
  app.ts                        all routes
  config.ts                     validated environment (zod), network presets
  db/                           driver adapter (pg / PGlite), migrations
  http/middleware.ts            session, CSRF, rate-limit store
  modules/auth|invoices|chain|documents|assistant|ml
  dev-server.ts                 local server (API + Vite)
contracts/                      Soroban escrow contract (Rust) + tests
frontend/                       React app (src/pages, src/components, src/lib)
knowledge/                      knowledge base (assistant)                
ml/                             Python training/eval, duplicate evaluation, reports
scripts/                        fixtures, demo seed/repay, KB ingest, Vercel build
tests/backend/                  Vitest API/integration/unit tests
e2e/                            Playwright tests
```

## Data model
See [DATASET_DOCUMENTATION.md](DATASET_DOCUMENTATION.md#6-application-data-postgres) and `backend/db/migrations/001_init.sql`.

## Invoice state machine
```
draft ──list──▶ listed ──fund──▶ funded ──repay──▶ repaid ──claim──▶ settled
                  │                 │
                cancel        mark_defaulted (after due date)
                  ▼                 ▼
              cancelled         defaulted ──repay──▶ repaid
```
`draft` exists only in the database; every other state is mirrored from the contract.
