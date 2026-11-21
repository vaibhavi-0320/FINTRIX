# Deployment (Vercel)

> **Not deployed yet.** Nothing has been deployed or pushed. Deploy only after you have tested the local build.

## What runs where
| Component | Hosting | Notes |
|---|---|---|
| React app | Vercel static/CDN | `.vercel/output/static` |
| API (Express) | **One Vercel Node.js 22 function** | `.vercel/output/functions/api/index.func` (~66 MB), 60 s max duration, response streaming on |
| Database | **External Postgres with pgvector**, e.g. Neon or Supabase | PGlite is for local/tests only; production refuses to start without `DATABASE_URL` |
| Smart contract | Stellar testnet (already deployed) | redeploy only if you change the contract |
| Embeddings | **Voyage AI** on Vercel (`EMBEDDINGS_PROVIDER=voyage`), or `none` for keyword-only retrieval | The local model runtime (~135 MB) is deliberately excluded from the function |
| OCR (local extraction) | inside the function | Tesseract language data downloads to `/tmp` on first use (cold start ~10 MB) |
| ML training | **Not on Vercel**: run `npm run ml:train` locally or in CI | The trained model JSON ships with the function |
| Contract build/deploy | Developer machine or CI with the Stellar CLI | |

## How the build works
`vercel.json` runs `npm run build:vercel`, which:
1. builds the frontend with Vite,
2. bundles `backend/vercel-entry.ts` with esbuild (kept out of `api/` so Vercel doesn't auto-build over it) (ESM, Node 22),
3. traces the remaining runtime files (pdf.js, tesseract) with `@vercel/nft`,
4. copies `knowledge/`, migrations and the risk model next to the function,
5. writes `.vercel/output/config.json`: `/api/*` goes to the function, SPA fallback to `index.html`, security headers, immutable caching for `/assets/*`.

This was verified locally: the generated function was started from its output directory and passed the smoke checks for health, knowledge ingestion, wallet sign-in, PDF extraction, OCR, risk scoring, Soroban preparation and keyword retrieval.

## Steps
1. **Create the database.** Create a Postgres 15+ database with the `vector` extension available (Neon and Supabase both support it). Copy the pooled connection string. Migrations run automatically on the first request.
2. **Import the repository** in Vercel. Framework preset: *Other*. The build command comes from `vercel.json`.
3. **Set environment variables** (Project → Settings → Environment Variables):

| Variable | Value | Secret? |
|---|---|---|
| `NODE_ENV` | `production` | |
| `DATABASE_URL` | Postgres connection string | **yes** |
| `APP_ORIGIN` | `https://<your-domain>` | |
| `STELLAR_NETWORK` | `testnet` | |
| `FINTRIX_CONTRACT_ID` | `CBH6Q4U2ESHZOHBS66JSLFRYR6SLFOHO4LKAF2MOHATM3KYIFAJXSSRX` | |
| `SETTLEMENT_TOKEN_ID` | `CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC` | |
| `USD_PER_XLM` | `0.11` | |
| `EMBEDDINGS_PROVIDER` | `voyage` (with `VOYAGE_API_KEY`) or `none` | |
| `VOYAGE_API_KEY` | from dash.voyageai.com | **yes** |
| `ANTHROPIC_API_KEY` | from console.anthropic.com | **yes** |
| `VITE_STELLAR_NETWORK` | `testnet` | |

   Do **not** set `VITE_E2E_WALLET`. `TRUST_PROXY_HOPS` defaults to 1 on Vercel automatically.
4. **Deploy.** After it is live, open `/api/health`. Expect `database: "postgres"`, `contractConfigured: true` and `aiConfigured: true`.
5. If you changed `EMBEDDINGS_PROVIDER`, the knowledge base is re-embedded automatically on the first request (checksums/model changes trigger re-ingestion).

## Runtime limits to know
- **Request body 4.5 MB** on Vercel, so uploads are capped at 4 MB (`MAX_UPLOAD_BYTES`).
- **60 s function duration:** OCR and Claude extraction usually take 5–30 s. Transaction confirmation waits up to ~25 s, then returns "pending" and the UI polls.
- **Cold starts:** the first OCR on a fresh instance downloads language data; the first request runs migrations (fast once applied).
- **Rate limits** are stored in Postgres, so they hold across instances.

## Mainnet (not recommended)
The contract has not been audited and is not deployed on mainnet. Going to mainnet would require: an audit, deployment with a stablecoin SAC (e.g. USDC), `STELLAR_NETWORK=mainnet` with an RPC provider in `STELLAR_RPC_URL`, legal/compliance work (KYC/AML, lending and securities rules), and updated copy throughout the app.
