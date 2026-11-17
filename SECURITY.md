# Security

Fintrix is a **testnet prototype**. Neither the application nor the smart contract has had an external security audit. Do not use it with real funds.

**Reporting a vulnerability:** please open a private security advisory on the repository, or contact the maintainer directly, rather than filing a public issue.

## Review summary (November 2026)

The review covered the original code and the rebuild. Each finding is listed with its fix and the evidence.

| # | Area | Finding (original code unless noted) | Severity | Remediation | Evidence |
|---|---|---|---|---|---|
| 1 | AuthZ | Vercel API had no authentication on any route | Critical | All non-public routes require a session; ownership checks on every resource | `tests/backend/auth.test.ts` (protected routes 401), `invoices.test.ts`, `documents.test.ts`, `assistant.test.ts` (cross-user 404) |
| 2 | Funding integrity | Any string accepted as a "transaction hash" to mark an invoice funded | Critical | Server prepares the tx and records its hash; submit only accepts that exact signed tx; success only after network confirmation; DB synced from contract state | `soroban.test.ts`, testnet test "rejects a signed transaction that differs" |
| 3 | Replay | A resubmitted signed tx was counted twice (found during Stage 0 testing) | High | Unique `tx_hash` per prepared action; state comes from the contract, not from submissions | testnet integration test |
| 4 | Escrow | Contract moved no funds; "escrow" was a status flag | High | Contract rewritten: real token transfers, escrowed repayments, `require_auth`, checks-effects-interactions | 12 Rust tests incl. balance and auth assertions |
| 5 | Auth bypass | `SECURITY_RELAXED_LOCAL=true` made every request an admin | High | Removed. Wallet sign-in only | – |
| 6 | Sign-in | Wallet challenge verified the wrong bytes; `Math.random` nonces | High | SEP-53 verification, crypto-random 128-bit nonces, single-use, 5-min expiry, atomic consumption | `auth.test.ts` (replay, expiry, wrong signer) |
| 7 | CSRF | Cookie auth without CSRF protection | High | Custom header required on non-GET + Origin check; SameSite=Lax | `auth.test.ts` |
| 8 | CORS | Any `*.vercel.app` origin allowed with credentials; `*` on functions | High | Strict allow-list from `APP_ORIGIN`; same-origin by default | `auth.test.ts` |
| 9 | Dependencies | 37 npm vulnerabilities (2 critical) | High | Removed unused packages, upgraded Stellar SDK 15→17, Vite 5→8 | `npm audit --omit=dev`: **0** |
| 10 | Rate-limit bypass | `trust proxy` always on → spoofable `X-Forwarded-For` (found in rebuild review) | Medium | Proxy trusted only when configured (`TRUST_PROXY_HOPS`, auto 1 on Vercel) | `auth.test.ts` "ignores spoofed X-Forwarded-For" |
| 11 | Uploads | Client-declared MIME trusted | Medium | Magic-byte detection, declared-type mismatch rejected, 4 MB limit, filename sanitised, owner-only download with `CSP: sandbox` and `nosniff` | `documents.test.ts` |
| 12 | Prompt injection | User-controlled fields concatenated into prompts | Medium | Retrieved and user data wrapped in tags and declared non-instructional; the assistant has no tools or actions; extraction output schema-validated and human-reviewed | `assistant.test.ts` |
| 13 | Information leak | Raw upstream errors returned to clients | Medium | 5xx details hidden; mapped, user-safe messages | `auth.test.ts` (malformed JSON) |
| 14 | Data exposure | Public visitor list endpoint | Medium | Removed (no tracking) | – |
| 15 | XSS | `innerHTML` toast; Markdown rendering | Low | React rendering only; Markdown without raw HTML; unsafe link schemes dropped | `components.test.tsx` |
| 16 | Open redirect | Post-login redirect | Low | Only same-site relative paths | `lib.test.ts` |
| 17 | Logging | Signed XDR logged in the browser console | Low | Removed; server logs contain no bodies; pino redaction for auth headers/cookies | – |
| 18 | Secrets in history | `.env.local` committed earlier | Low | Contents were placeholders (`demo…` Clerk secret, public `pk_test` key); `.env*` now ignored | git history reviewed |

## Controls in place
- **Custody:** Fintrix never receives keys. Every on-chain action requires a wallet signature; AI output can never trigger a transaction.
- **Sessions:** 256-bit random tokens in an HTTP-only, SameSite=Lax cookie (Secure in production); only SHA-256 hashes are stored; 7-day expiry; per-session and global revocation.
- **Input validation:** strict zod schemas (unknown fields rejected), sanitised free text, parameterised SQL only.
- **Network safety:** the browser refuses to sign on a network that differs from the app; the server refuses mainnet outside production.
- **Headers:** Helmet defaults, CSP in `index.html`, HSTS, X-Frame-Options DENY and Permissions-Policy on Vercel.
- **Rate limiting:** Postgres-backed, so it holds across serverless instances.
- **Audit log:** sign-ins, uploads, reviews, chain actions; no secrets or document contents.

## Smart-contract notes
- Authorisation: `seller.require_auth()` (create/cancel), `investor.require_auth()` (fund/claim/default), `payer.require_auth()` (repay).
- Reentrancy: Soroban does not allow re-entrant calls into the same contract; state is written before transfers anyway.
- Integer safety: `i128` amounts; overflow checks enabled in release builds.
- Known limitations: no admin/upgrade path; due dates use ledger time; the contract cannot verify that an off-chain invoice is genuine.

## Remaining risks
- **No external audit** of the contract or application.
- **Dev-only advisories:** 7 moderate (`minimatch` ReDoS via `typescript-eslint`), not shipped to production; fixing requires a forced breaking upgrade.
- **Assistant:** a model can still produce wrong statements. Answers cite sources, and the UI states that it is not advice.
- **Demo key file:** `npm run demo:seed` stores a **testnet-only** key in `.data/demo-sellers.json` (git-ignored).
- **Upload processing:** OCR and PDF parsing run in-process; very complex files could be slow (bounded by the size limit, upload rate limit and function timeout).
