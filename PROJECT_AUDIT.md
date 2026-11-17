# Fintrix — Project Audit (Phase 1)

**Date:** 2026-11-12  **Branch:** `main` @ `446d500`  **Auditor:** Claude Code (automated + manual review)

Everything here comes from reading the source and running the toolchain locally. Each finding names the file it comes from. Nothing has been changed yet except adding this file.

---

## 1. What Fintrix is supposed to be

From the README, `docs/`, the UI copy and the contract, the product is:

> **An invoice-financing marketplace on Stellar.** An SME (seller) uploads an unpaid invoice. AI pulls out the invoice data and gives it a risk/"Trust Score". The invoice is listed. Investors fund it at a discount through a Soroban escrow. When the buyer pays, the seller repays principal plus yield to the investor.

How the requested concepts map to the repo:

| Concept | In the repo? | Evidence |
|---|---|---|
| AI invoice processing | **Yes, but faked in the UI** | `backend/service.ts::parseInvoice` (Gemini), `frontend/src/components/InvoiceUploader.tsx:65` (random mock data) |
| Financing marketplace | Yes | `MarketplaceView.tsx`, `DealDetailView.tsx` |
| Blockchain escrow | **Yes, but no funds are held** | `contracts/src/contract.rs` changes status only. No token transfer. |
| AI assistant | Yes | `FintrixAssistant.tsx`, `backend/service.ts::askAssistant` |
| "Simulation" / gamification | Yes | `SimulationFlow.tsx`, leaderboard in `constants.ts` |

---

## 2. Current architecture

```
frontend/ (React 19 + Vite 5 + Tailwind 3 + motion + three.js)
   src/App.tsx            view-state "router" (useState, no URLs)
   src/services/*.ts      Stellar + API clients   ⚠ shadowed by stale *.js twins
   server.ts              Express dev server (Vite middleware) + all /api routes
   api/                   Vercel functions (NOT deployed: Vercel root is the repo root)
api/main.ts               Vercel function: one "?action=" multiplexer
backend/                  Shared TS modules (service, store, auth, env, validation…)
   store.ts               JSON files on disk  ← the "database" actually in use
   supabase.ts + migrations/001_initial.sql  ← only used for wallet-auth nonces
contracts/                Soroban (Rust, soroban-sdk 25.3) invoice "escrow"
```

- **Frontend:** React 19 SPA. No router. Navigation is `useState<AppView>`, so there are no URLs, deep links or back button.
- **Backend:** The same handlers exist **three times** and have drifted apart: `frontend/server.ts` (Express), `api/main.ts` (Vercel), and `frontend/api/*` (Vercel, never deployed). There is also `backend/apiHandlers.ts`, which nothing uses.
- **Database:** Invoices, transactions and visitors live in JSON files (`backend/store.ts`). The frontend mostly ignores them and keeps invoices in **`localStorage`** (`stellarService.ts::getLocalInvoices`, seeded with 3 hardcoded invoices). Supabase is only touched by wallet-auth, which no client calls.
- **Blockchain:** These are **Stellar Classic XLM payments** built by the backend and signed in Freighter. The Soroban contract is **not deployed and not called anywhere**. `frontend/src/lib/stellar.ts` is a non-compiling sketch that signs with a raw `Keypair` and calls APIs that don't exist.
- **AI:** Calls Claude (`claude-3-5-sonnet-20241022`, a retired model) or Gemini through a raw `fetch` with no streaming, and **falls back silently to keyword-matched canned answers** on both server and client.

---

## 3. Toolchain results (actually run)

| Check | Result |
|---|---|
| `npm install` (frontend) | OK. 711 packages. Deprecated: `stellar-sdk@11` (moved), `tar@6`, `glob@7`… |
| `tsc --noEmit` | **FAIL**: `main.tsx: TS5097 import path ends in .tsx`. `wallet-auth.ts`, `validation.ts`, `apiHandlers.ts` and `lib/stellar.ts` use `// @ts-nocheck` to hide errors. |
| `vite build` | Passes, but **2.35 MB JS bundle** (611 KB gzip). Includes a 1.55 MB PNG logo. |
| `npm audit --omit=dev` | **37 vulns: 2 critical, 17 high**, 17 moderate, 1 low |
| `cargo test` (repo as-is) | **FAIL**: root `Cargo.toml` workspace points to `contracts/lumensflow-stream`, which doesn't exist. Root `package.json` `contract:test` uses the same bad path. |
| `cargo test` (isolated copy) | see §3a |
| Automated tests | **None run.** `backend/tests/store.test.ts` imports vitest + Testing Library, which aren't installed, and tests Supabase mocks that don't match the code. No test script exists. |
| Python (ML) | **Not installed** on this machine |
| Docker | Installed (29.6.2). Can run a local Postgres. |
| Stellar CLI | Installed (25.1.0). `wasm32v1-none` target present. |

### 3a. Contract test result
I copied `contracts/` to a scratch directory as a standalone crate and ran `cargo test`: it **compiles and 1/1 tests pass** (`create_fund_repay_flow`). The test uses `mock_all_auths()` and only checks status changes, because the contract moves no funds (see §4.4). Only one test exists. There are no negative or authorization tests.

---

## 4. Root-cause findings (why Stellar is "unreliable")

1. **The app ships stale compiled JavaScript, not the TypeScript you edit.** 18 `*.js` files sit next to their `*.ts` twins (`services/stellarService.js`, `aiService.js`, `hooks/*.js`, `App.js`…). Vite resolves `.js` before `.ts`, so `import "./services/stellarService"` loads the **old `.js`**. I confirmed it: error strings that exist only in `stellarService.ts` (e.g. `"Invalid XDR received from server"`) are **absent from `dist/`**. The stale file calls `/api/main?action=stellar-build`; the TS calls `/api/stellar/build`. Fixes made in `.ts` never ran.
2. **There are three funding code paths and they disagree:**
   - `DealDetailView` → `stellarTransactions.fundInvoiceOnChain` sends XLM **to the investor's own address** (`recipientPublicKey` is never passed). The tx is real but meaningless, and the backend "record" call ignores errors.
   - `App.handleFund` → `stellarService.fundInvoice` pays a hardcoded fallback escrow `GBUWCRHT…` at **$0.11/XLM**.
   - `backend/service.ts::buildFundInvoiceTransaction` uses **$25/XLM** (`USD_PER_XLM`). Nothing calls it.
3. **The backend never verifies on-chain confirmation.** `POST /api/invoices/:id/fund` accepts any `txHash` string with no auth and marks the invoice funded. `frontend/api/invoices/[id]/fund.ts` only `console.log`s.
4. **The "escrow" holds no money.** `fund_invoice` sets `status = Funded` with no token transfer. `repay_invoice` takes a number and sets `Repaid`. Nothing moves to or from the contract. `test_snapshots/.../cancel_invoice_flow` refers to a cancel function that no longer exists.
5. **The local server won't start in a default setup.** `env.getEnv()` throws unless Clerk **and** Upstash keys are set, or `SECURITY_RELAXED_LOCAL=true`. With relaxed mode **every** request is treated as `local-dev-user` with **admin** role.
6. **Balance/network handling is hardcoded.** Testnet URLs and passphrases are duplicated in about 10 files. Nothing checks that Freighter is on the same network. Wallet balance is fetched from three places with different rounding.
7. **The "Demo Wallet" makes a random keypair** (`connectManualWallet("demo")`). It is unfunded and can't sign, so every action after it fails. Albedo/"Phyto" give a public key only and **can't sign** (funding is blocked unless provider is Freighter).

---

## 5. Feature status

| Feature | Status | Notes |
|---|---|---|
| Landing page | ✅ Renders | 1,360-line `Web3HeroLanding.tsx`. Heavy three.js. Marketing stats need review. |
| Loading screen | ✅ | Purely cosmetic delay before landing |
| Wallet connect: Freighter | ⚠ Works | `@stellar/freighter-api` v6. No network check. |
| Wallet connect: Albedo | ⚠ Public key only | Can't sign. Uses `alert()`. |
| Wallet connect: Phyto / Demo | ❌ Misleading | Phyto doesn't exist as an integration. Demo is an unfunded random key. |
| Authentication / login | ❌ **None in the UI** | Clerk is configured on the server, but the frontend has no Clerk SDK. `useAuth.ts` (challenge/verify) is never imported. "Login" means "a public key in React state". Refresh = logged out. |
| Dashboard | ⚠ Partly fake | Reads `localStorage`. **Fabricates portfolio entries** from seed invoices (`txHash: seed-…`). Chart falls back to hardcoded bar heights `[18,24,30…]`. `simulationsRun` defaults to `"1"`. |
| Invoice upload + AI extraction | ❌ **Fake** | `InvoiceUploader` waits 2.2 s, then shows a **random amount** and a random invoice number. Server `parseInvoice` returns fixed fallback data with no key. `aiService.parseInvoiceWithAI` returns `25000` on failure. No review step is enforced. |
| AI "verification" / Trust Score | ❌ **Fake** | `App.handleCreateInvoice` pushes a hardcoded "Risk Level: LOW. Trust Score: 82/100". `riskScore` = `Math.random()` (client) or `discount*4+…` (server). |
| Marketplace | ⚠ | Lists `localStorage` invoices (3 hardcoded seeds + user-created) |
| Funding | ⚠ Real tx, wrong semantics | See §4.2. Only Freighter. |
| Repayment | ❌ | `repayInvoiceOnBackend` flips a `localStorage` flag. `RepaymentComplete` shows `txId: 0x${Math.random()}`. Nothing on-chain. |
| Transaction history | ❌ | `getTransactions()` returns `[]`. Activity comes from `localStorage` only. |
| Blockchain activity / explorer links | ⚠ | Links appear after a successful tx. No history from Horizon. |
| Simulation | ⚠ | Real 1-XLM **self-payment** with `SIM:` memo, then computed "expected return" |
| Leaderboard | ❌ **Fabricated** | `LEADERBOARD_DATA` = 5 hardcoded named people with ROI/returns |
| AI assistant | ⚠ | Real LLM only if a key is set. Otherwise **silent canned answers** (server and client). No streaming, no RAG, no persistence. The model ID is retired. |
| Resources / Help | ✅ Static | `ResourcesView.tsx` |
| Privacy page | ❌ Unreachable | `PrivacyPage.tsx` isn't imported |
| Settings | ❌ Missing | — |
| Visitor tracking | ⚠ | Stores user-agent/language without a consent UI. **`GET visitors` is unauthenticated on Vercel.** |

**Dead code (never imported):** `LandingPage.tsx`, `UploadInvoiceView.tsx`, `PrivacyPage.tsx`, `CursorGlow.tsx`, `Globe.tsx`, `CustomCursor/*`, `mock/marketplaceMock.ts`, `hooks/useAuth.ts`, `hooks/useWallet.ts`, `services/invoiceApi.ts`, `services/apiClient.ts`, `lib/stellar.ts`, `backend/apiHandlers.ts`, `backend/ai-validation.ts`, `backend/horizon.ts` (listener body is a no-op placeholder), all of `frontend/api/*`, `frontend/server.js`, plus 18 stale `*.js` twins.

---

## 6. Security findings

| # | Severity | Finding | Location |
|---|---|---|---|
| S1 | **Critical** | **No authorization on any state-changing route on Vercel.** `api/main.ts` never calls `requireAuth`, so anyone can create invoices, call `repay`, read visitors, and burn AI credits through `chat`/`ai-parse`. | `api/main.ts` |
| S2 | **Critical** | **Funding accepts unverified tx hashes**, with no auth and no ownership check. Anyone can mark any invoice funded. | `frontend/server.ts` `POST /api/invoices/:id/fund` |
| S3 | High | **Wallet-auth signature check is wrong**: it verifies `nonce` bytes directly, but Freighter `signMessage` signs a SEP-53 prefixed hash. Also `Math.random()` nonces (not cryptographically secure). No client calls it. | `backend/wallet-auth.ts` |
| S4 | High | `SECURITY_RELAXED_LOCAL=true` makes every request an **admin**. Committed historically in `.env.local`. | `backend/auth.ts` |
| S5 | High | 37 npm vulnerabilities (2 critical). Duplicate `stellar-sdk@11` + `@stellar/stellar-sdk@15`. | `package.json` |
| S6 | High | **CORS allows any `*.vercel.app` origin with credentials**, and the frontend functions use `*`. | `backend/security.ts`, `frontend/api/*` |
| S7 | Medium | Hardcoded fallback escrow public key. Funds go to an address nobody can confirm control of. | `server.ts`, `api/main.ts` |
| S8 | Medium | Unmitigated **prompt injection**: user-controlled `view`/`walletAddress` are put straight into the prompt, and the model's text is rendered (markdown). | `service.ts::askAssistant` |
| S9 | Medium | Upload "validation" trusts the client `mimeType`. Base64 up to 7 MB in a JSON body. No magic-byte check. | `validation.ts::parseInvoiceSchema` |
| S10 | Medium | Raw upstream error messages are returned to clients (`error.message`, `details: String(error)`). | `api/main.ts`, `server.ts` |
| S11 | Medium | DOM `innerHTML` toast (static string today, but an XSS-prone pattern). | `App.tsx::handleLogout` |
| S12 | Low | `.env.local` / `frontend/.env.development` were committed in `e089afa`/`11c435d`. Contents: placeholder `demo…` Clerk secret + `pk_test` publishable key. **No real secret leaked**, but the history should be noted. | git history |
| S13 | Low | RLS policies use `auth.uid()` (Supabase Auth), but the app uses Clerk IDs and the service-role key, so the policies are meaningless. | `migrations/001_initial.sql` |
| S14 | Low | The contract has no admin/upgrade path, no `due_date` checks, and `create_invoice` lets the caller choose `id` (front-running/collision). | `contracts/src/contract.rs` |

No private keys or secret seeds were found in source or git history. I scanned for `S…` seeds, `sk-ant-`, `AIza`, `sk_live/test` and JWTs.

---

## 7. Missing environment / external dependencies

| Need | Service | Credential | Where it goes |
|---|---|---|---|
| LLM (chat + extraction) | Anthropic | `ANTHROPIC_API_KEY` | root `.env` (server only, never `VITE_`) |
| Embeddings for RAG | Voyage AI **or** local model (no key) | `VOYAGE_API_KEY` (only if Voyage) | root `.env` |
| Database | Postgres + pgvector: local Docker for dev, Supabase/Neon for prod | `DATABASE_URL` | root `.env` / Vercel env |
| Session signing | — | `SESSION_SECRET` (I can generate one locally) | root `.env` |
| Stellar Testnet | Friendbot (free) | Deployer identity in the **Stellar CLI keystore** (never in the repo) | `stellar keys` |
| ML training | Python 3.11+ | — | needs installing on this machine |
| Rate limiting (prod) | Upstash Redis (optional) | `UPSTASH_REDIS_REST_URL/TOKEN` | Vercel env |

---

## 8. Technical debt

- Three copies of the API that have drifted apart, plus 18 stale JS twins. Huge inline-style components (Dashboard 818 lines, Landing 1,360 lines). No router.
- Two Stellar SDKs, two state stores (`localStorage` + JSON files), and Supabase used for one table.
- Hardcoded network config is spread across many files. The XLM/USD rate is hardcoded at two different values.
- The bundle is 2.35 MB with no code splitting. There's a 1.55 MB logo PNG.
- No tests, no lint config wired up (`eslint.config.js` exists, but there's no eslint dependency). CI workflows reference scripts that don't exist.
- Package names (`stellar99-*`, `lumensflow-stream`) are leftovers from earlier projects.

---

## 9. Recommended implementation plan

I'll **repair, not rewrite**: keep the React/Vite frontend and its visual identity, the Express+Vercel split, the Soroban contract and the Freighter flow. I'll make a **single** Express app that runs locally and as **one** Vercel function, so the API exists in one place.

| Stage | Scope | Done when |
|---|---|---|
| **0. Foundation** | Delete stale `.js` twins and dead code. Fix tsconfig/Cargo workspace. One API app (`server/app.ts`) mounted by both `npm run dev` and `api/index.ts`. Central `config` (network, URLs, passphrase) from env. Drop `stellar-sdk@11`. `npm audit fix`. Add react-router with real URLs. | `tsc`, lint and build are clean. The app starts with only `.env.example` values. |
| **1. Data layer** | Postgres + pgvector (Docker locally). SQL migrations + runner. Tables: `users`, `wallets`, `auth_challenges`, `sessions`, `invoices`, `invoice_documents`, `extractions`, `fundings`, `chain_transactions`, `conversations`, `messages`, `kb_documents`, `kb_chunks`. Idempotent seed only for **clearly labelled demo** data. Remove `localStorage`/JSON stores. | Integration tests against a real Postgres |
| **2. Auth** | Wallet sign-in: server nonce → Freighter `signMessage` (SEP-53) → server verifies → httpOnly, SameSite session cookie. Roles via ownership checks on every route. Rate limiting (in-memory locally, Upstash in prod). | Auth tests: replay, expiry, wrong signer, cross-user access |
| **3. Soroban escrow** | Rewrite the contract so it **really escrows a token** (XLM SAC): `init`, `create_invoice` (seller auth, contract-assigned id), `fund` (investor → contract transfer), `release_advance` to seller, `repay` (seller → contract), `claim` (investor), `cancel`, due-date checks, events. Rust unit tests. Deploy to Testnet with the CLI. | `cargo test` green. Contract ID recorded. Real testnet invocations verified. |
| **4. Stellar integration** | Backend builds and **simulates/prepares** Soroban txs. The browser signs in Freighter (user approval, network check). Backend submits and **polls `getTransaction` until SUCCESS/FAILED**, then records. History from RPC events + Horizon. Explorer links. Clear errors. Balances in one place. | Testnet integration test does create→fund→repay→claim with real hashes |
| **5. Document AI** | Multipart upload, size/type + magic-byte validation. Claude reads the PDF/image (native PDF + vision) with a strict JSON schema: all invoice fields, line items, per-field confidence. Deterministic checks (line-item sums, tax, dates, currency). Stored with original. **Review/correct screen. Listing is blocked until the seller confirms.** | Extraction tests on fixture invoices, plus failure tests |
| **6. AI assistant + RAG** | Provider interface (Claude default, swappable). SSE streaming. Persisted conversations. `knowledge/*.md` knowledge base (product, architecture, workflows, Stellar, contract, security, FAQ, troubleshooting) → chunk → embed → pgvector → top-k retrieval with **cited sources**. System prompt for different audiences, "not financial advice", and treating retrieved/user text as data. Verified-vs-general labelling. Suggested follow-ups. **No canned fallback**: errors are shown as errors. | Retrieval accuracy test set. Provider-failure tests. |
| **7. ML** | Two legitimate candidates. **(a) Duplicate-invoice detection**: needed by the product to stop double-financing. Mostly deterministic and similarity-based, so no fake training. **(b) Late-payment risk model** to replace the fake Trust Score, trained on a public accounts-receivable payment dataset *only if its licence allows*, else a clearly labelled reproducible synthetic set. Python training/eval scripts with reported metrics. Inference exported to JSON/ONNX for Node. | Real metrics in `AI_ML_DOCUMENTATION.md` |
| **8. Frontend completion** | Routes: `/`, `/signin`, `/app` (dashboard), `/app/invoices` (+ upload/review), `/app/marketplace`, `/app/deals/:id`, `/app/transactions`, `/app/assistant`, `/app/settings`, `/help`, `/privacy`. Remove fabricated leaderboard and stats. Loading/empty/error states, toasts, accessible forms. Code-split three.js. | Component + Playwright e2e tests |
| **9. QA** | Vitest (unit/integration), Supertest (API), Playwright (e2e + responsive), `cargo test`, testnet smoke script. | All green, with output in `TESTING.md` |
| **10–11. Docs & Vercel** | README, ARCHITECTURE, API, AI_ML, STELLAR_INTEGRATION, DATASET, SECURITY, TESTING, DEPLOYMENT, `.env.example`, `.gitignore`. Vercel config for SPA + one function. Note what can't run on Vercel (ML training, contract deploy, long-lived listeners). | — |

**No commits, pushes or deploys will happen without your explicit approval.**

---

## 10. Progress log

### Stage 0 — Foundation (2026-11-12) ✅

| Area | Change |
|---|---|
| Root cause | Deleted the 18 stale `.js` twins. I confirmed the bundle now contains the current TS (strings that exist only in the TS are present; `/api/main` and `seed-` are gone). |
| API | **One** Express app (`backend/app.ts`), mounted by `backend/dev-server.ts` (local) and `api/index.ts` (Vercel). Removed `api/main.ts`, `frontend/api/*`, `frontend/server.ts`, `backend/apiHandlers.ts`. |
| Config | `backend/config.ts` + `frontend/src/config.ts`: network presets from env. Mainnet is refused outside production. No hardcoded fallback escrow key. One root `.env`. |
| Stellar | One funding path (`stellarService.fundInvoice`). The deal page no longer pays the investor's own wallet. Freighter network/signer checks. Signed XDR is no longer logged. Fixed a replay bug (a resubmitted signed tx was counted twice). SDK 15 → 17. |
| AI | Official `@anthropic-ai/sdk` with `claude-opus-5-5`. **No canned fallbacks** on server or client: errors are shown. Fixed the chat sending the question twice. |
| Fake data removed | Dashboard's synthesized `seed-…` portfolio, random repayment tx id, "Demo Wallet" (an unfunded random key), the `innerHTML` toast, `alert()` popups. |
| Security | Clerk/relaxed-admin mode removed. CORS restricted to `APP_ORIGIN` (no `*.vercel.app`). Rate limits (general/stellar/AI). Body limit. 5xx details hidden. Public `GET visitors` removed. CSP tightened (no `unsafe-eval`, no Clerk). |
| Deps | 37 vulnerabilities → **0** (`npm audit --omit=dev`). Removed three.js, Clerk, Supabase, Sentry, Upstash, Gemini, `stellar-sdk@11`. |
| Assets | Logos 1024 px/1.5 MB → 256 px. JS 2.35 MB single chunk → about 1.06 MB in four chunks. |
| Tooling | Strict TS for backend and frontend, ESLint 9 flat config, fixed Cargo workspace (`fintrix-escrow`), one CI workflow. |

**Verification run:** `npm run check` (typecheck + lint + build) exits 0. `cargo test`: 1/1 passed. API smoke tests (health, 404 JSON, 400 validation, 503 when there's no AI key, CORS rejection). **Real Testnet E2E:** API built the payment → test investor signed → API submitted → Horizon confirmed independently: tx `d879996396ab0c0ced4b38ed1d66c63e1ebe378765d417375b2b55a2d399cbda` (ledger 5696371, 100 XLM to escrow, memo `INV:#INV-4922`). A replay of a recorded payment against another invoice is rejected (409).

**Still open (scheduled):** no authentication on routes (Stage 2). Invoices still in browser storage on the frontend / JSON file on the server (Stage 1). `/invoices/:id/fund` doesn't yet check that the signed tx pays the escrow the stated amount (Stage 4). Escrow is a plain account, not a contract (Stage 3). Trust Score and marketing copy ("40+ risk parameters") still unbacked (Stages 7–8). No router (Stage 8). Freighter signing in the browser was not automated: the CLI signed in its place.

### Stages 1–11 (2026-11-13 → 2026-11-14) ✅

| Stage | Delivered | Evidence |
|---|---|---|
| 1 Data layer | Postgres + pgvector schema (14 tables, constraints, indexes), auto-applied migrations; PGlite for zero-setup dev and isolated tests; globalThis singleton (fixed a dual-instance data-loss bug found while seeding) | all backend tests run on a fresh DB |
| 2 Auth | Freighter SEP-53 sign-in, single-use nonces, hashed HTTP-only sessions, revoke/revoke-all, CSRF header + Origin check, Postgres-backed rate limits, proxy-aware IPs | `auth.test.ts` 19/19 |
| 3 Contract | Real escrow: token transfers, escrowed repayment, claim, cancel, default, on-chain duplicate-document block, events; deployed to testnet `CBH6Q4U2…SSRX` | `cargo test` 12/12 |
| 4 Stellar | Prepare/simulate → wallet sign → exact-hash check → submit → confirm → sync from contract; Horizon balances/activity; explorer links | testnet API test 7/7; browser testnet journey ✅ |
| 5 Documents | Upload validation (magic bytes, size), local pdf.js/Tesseract + rules, Claude structured extraction, validation, review gate, persistence | `documents.test.ts` |
| 6 Assistant | Provider-agnostic LLM layer (Claude SDK, streaming, refusal fallback), 17-article KB, hybrid RAG (hit@3 0.95), citations, audiences, follow-ups, saved conversations, no canned fallback | `assistant.test.ts`, `knowledge-eval.test.ts` |
| 7 ML | Logistic-regression late-payment model on a documented synthetic dataset (ROC AUC 0.719, CI 0.691–0.745) with TS/Python parity; duplicate detector (P 0.976 / R 1.0 on synthetic pairs) | `ml.test.ts`, `ml/reports/` |
| 8 Frontend | **Original Fintrix UI kept as designed** (an interim redesign was reverted at the owner's request). Same screens and styling, now wired to the real API: wallet sign-in (Freighter/Albedo), real invoices/balances/activity, upload → extraction → review → on-chain listing, fund/repay/claim/cancel/default on the deal page, simulator recorded on testnet, streaming assistant. Hardcoded fallback deals, random mock extraction and fake progress removed | 3 Playwright tests (no console errors, signed-in journey, mobile overflow) + full testnet journey through the original screens |
| 9 QA | See [TESTING.md](TESTING.md) | `npm run check` green |
| 10 Docs | README, ARCHITECTURE, API, AI_ML, STELLAR, DATASET, SECURITY, TESTING, DEPLOYMENT, `.env.example` | – |
| 11 Vercel | Build Output API bundle (static + one 66 MB function), smoke-tested locally | `npm run build:vercel` |

### Acceptance criteria status
| # | Criterion | Status |
|---|---|---|
| 1 | Runs locally without errors | ✅ (`npm run dev`; E2E asserts no console errors) |
| 2 | Major UI features work | ✅ (E2E local + testnet journeys) |
| 3 | Authentication works | ✅ |
| 4 | Database persistence works | ✅ |
| 5 | Chatbot responds through a real model API | ⏳ **Implemented with the official Anthropic SDK; not exercised: needs your `ANTHROPIC_API_KEY`** |
| 6 | Chatbot explains Fintrix from its knowledge base | ⏳ retrieval verified (hit@3 0.95); generation awaits the key |
| 7 | RAG retrieval works | ✅ |
| 8 | ML pipeline works with documented evaluation | ✅ (synthetic data, limitations documented) |
| 9 | Document processing works | ✅ local engine; Claude engine awaits the key |
| 10 | Stellar testnet wallet integration works | ✅ (automated with a test signer; **please verify once with the real Freighter extension**) |
| 11 | Real transactions submitted and verified | ✅ |
| 12 | Smart contracts work | ✅ |
| 13 | Automated tests pass | ✅ |
| 14 | Production build succeeds | ✅ |
| 15 | Documentation complete | ✅ |
| 16 | Secrets protected | ✅ |
| 17 | GitHub/Vercel requirements documented | ✅ (nothing pushed or deployed) |
