# Testing

| Suite | Tool | Command | Tests | Result (2026-11-14) |
|---|---|---|---|---|
| Backend API, integration and unit | Vitest + Supertest + in-memory PGlite | `npm run test:backend` | 75 | ✅ pass |
| Retrieval quality (real embeddings) | Vitest | included in `test:backend` | 1 (28 questions) | ✅ hit@3 0.93 |
| Assistant with **real Claude** | Vitest + Anthropic API | `npm run assistant:eval` | 1 (8 graded questions) | ⏳ needs `ANTHROPIC_API_KEY` |
| Stellar **testnet** lifecycle (API) | Vitest + real testnet | `npm run test:testnet` | 7 | ✅ pass (opt-in, needs network) |
| Smart contract | `cargo test` (Soroban test env) | `npm run contract:test` | 12 | ✅ pass |
| End-to-end (local) | Playwright, Chromium desktop + Pixel 7 | `npm run test:e2e` | 3 (2 desktop, 1 mobile) | ✅ pass |
| End-to-end on **testnet** | Playwright | `npm run test:e2e:testnet` | 1 full journey | ✅ pass (opt-in) |
| Type checking | tsc (backend, e2e, frontend; `strict`) | `npm run typecheck` | – | ✅ clean |
| Lint | ESLint 9 + typescript-eslint + react-hooks | `npm run lint` | – | ✅ 0 errors (1 hook-dependency warning) |
| Production build | Vite 8 | `npm run build` | – | ✅ |
| Vercel bundle | esbuild + nft | `npm run build:vercel` | smoke test of the bundle (8 checks) | ✅ |
| ML evaluation | Python / tsx | `npm run ml:train`, `npm run ml:eval-duplicates` | – | metrics in `ml/reports/` |

Run everything except the network-dependent suites with `npm run check`.

## What is covered
**Backend** (`tests/backend/`)
- `auth.test.ts`: SEP-53 sign-in, cookie flags, token hashing, replay/expiry/wrong-signer rejection, logout, revoke-all, profile sanitisation, protected routes, CSRF header, foreign Origin, CORS, JSON 404, security headers, Postgres-backed rate limiting, `X-Forwarded-For` spoofing.
- `invoices.test.ts`: pricing maths, draft privacy, validation rules, duplicate numbers, cross-seller duplicate flags, edit/delete only for drafts, search/scopes, dashboard from real data, authorisation of chain actions, USD-only listing.
- `documents.test.ts`: date/amount parsing, validation rules, magic-byte detection, filename sanitising, PDF extraction (every field), mandatory review before creating an invoice, blocked creation with errors, scanned PDF, disguised/unsupported/oversized files, dedupe and isolation, OCR of the PNG, owner-only download with sandbox CSP, 503 when AI is requested without a key.
- `assistant.test.ts`: follow-up tag filter across chunk boundaries, prompt rules, Markdown chunking, SSE streaming order (sources → text → follow-ups), persistence, multi-turn context, provider failure with sources and no fallback, missing key → 503 event, conversation isolation and validation, public help endpoints; page context: current screen, open deal with its next button, balance and the user's invoices reach the model; another user's draft is not revealed; unknown screens/ids rejected.
- `ml.test.ts`: risk model present, matches the inference feature list, **Python ↔ TypeScript parity**, monotonic behaviour, defaults for missing history; duplicate normalisation, rules and negatives; recorded evaluation metrics.
- `soroban.test.ts`: exact stroop conversion, USD→XLM rounding, contract error mapping, signed-envelope checks.
- `knowledge-eval.test.ts`: retrieval evaluation with the real model.
- `testnet.integration.test.ts` (opt-in): full lifecycle on Stellar testnet with fresh Friendbot accounts, tamper rejection, balance checks, on-chain duplicate block, history.

**End-to-end** (`e2e/`):
- `app.spec.ts`: landing page and the Connect Wallet modal load with **no console errors**; signed-in journey through the original UI: Connect Wallet → Freighter card → wallet signs the challenge → Dashboard (real data for a new wallet) → Marketplace (no hardcoded fallback deals) → Resources → Simulation → upload the sample PDF → extracted values shown → review form → listing fails with the real network error for an unfunded account → assistant widget sends the current screen and, with no AI key, shows the real "not configured" error plus related help articles → Disconnect.
- `responsive.spec.ts` (Pixel 7): sign-in works and there is no horizontal overflow.
- `testnet-journey.spec.ts` (opt-in): through the original screens on real testnet: seller uploads a unique PDF and lists it → investor runs "Simulate on Testnet" → investor funds it from Marketplace → View Details → seller repays (Repayment Complete screen) → investor claims (SETTLED).

E2E tests use a **test signer** injected by Playwright instead of the Freighter extension, which cannot run in headless Chromium. The signer's keys stay in the Node test process; the page only receives signatures. The bridge only exists in builds with `VITE_E2E_WALLET=true` and is removed at compile time otherwise.

## Not automated
- Signing with the real Freighter extension. Test it manually: install Freighter, switch it to Testnet, run `npm run dev`, sign in, and fund one of the demo listings.
- Claude answers and Claude extraction quality (no API key during development). The code paths are tested with a stub provider.
- Visual design review beyond the overflow and style checks.

## Prerequisites for the full suite
- Node 22, `npm ci`
- Rust + `wasm32v1-none` target + Stellar CLI (contract)
- `npx playwright install chromium` (E2E)
- Network access to Stellar testnet (opt-in suites); the first run downloads the embedding model (~23 MB) and OCR data (~10 MB) into `.data/`.
