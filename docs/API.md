# API reference

Base path `/api`. JSON in and out. Every response has the shape `{ "success": true, "data": … }` or `{ "success": false, "error": "message", "details"?: [{ "path", "message" }] }`.

**Authentication:** a `fintrix_session` HTTP-only cookie set by `/auth/verify`.
**CSRF:** every non-GET request must send the header `x-fintrix-csrf: 1`. If an `Origin` header is present it must match the site.
**Rate limits** (per user, or per IP when signed out): general 300/min, auth 10/min, chain 20/min, AI 12/min, uploads 20 per 10 min. Exceeding one returns 429 with `RateLimit-*` headers.

## Public
| Method | Path | Description |
|---|---|---|
| GET | `/health` | status, database driver, network, contract/AI configured, risk model id |
| GET | `/config` | network, passphrase, explorer, contract id, settlement asset, conversion rate, upload limit, AI/extraction engine |
| GET | `/knowledge` | knowledge-base article list + index status |
| GET | `/knowledge/search?q=` | hybrid search; returns matching sections |
| GET | `/knowledge/:slug` | article Markdown |
| POST | `/auth/challenge` | `{ address }` → `{ nonce, message, expiresAt }` |
| POST | `/auth/verify` | `{ address, nonce, signature }` (base64/hex string or serialised Buffer) → sets cookie, `{ user }` |
| GET | `/auth/session` | `{ user \| null }` |
| POST | `/auth/logout` | revokes the current session |

## Signed in (401 otherwise)
### Profile and sessions
| Method | Path | Description |
|---|---|---|
| GET | `/me` | current user |
| PATCH | `/me` | `{ displayName }` |
| GET | `/me/sessions` | active sessions |
| POST | `/me/sessions/revoke-all` | sign out everywhere |
| GET | `/dashboard` | aggregates as seller/investor, marketplace totals, recent confirmed transactions |

### Invoices
| Method | Path | Description |
|---|---|---|
| GET | `/invoices?scope=mine\|marketplace\|investments\|all&status=&q=&limit=&offset=` | list (drafts visible only to their seller) |
| POST | `/invoices` | create a draft (manual entry) |
| GET | `/invoices/:id` | invoice + `actions` the viewer may take |
| PUT | `/invoices/:id` | edit a draft (seller only) |
| DELETE | `/invoices/:id` | delete a draft (seller only) |
| POST | `/invoices/:id/reconcile` | re-read the contract and sync |

Invoice body:
```json
{ "invoiceNumber": "INV-1", "issuerName": "Seller Ltd", "buyerName": "Buyer Inc", "buyerCountry": "US",
  "currency": "USD", "issueDate": "2026-11-01", "dueDate": "2027-01-15",
  "subtotal": 1000, "tax": 80, "total": 1080, "discountBps": 300, "notes": null,
  "lineItems": [{ "description": "Widgets", "quantity": 10, "unitPrice": 100, "amount": 1000 }] }
```

### Blockchain
| Method | Path | Description |
|---|---|---|
| POST | `/invoices/:id/actions/:action` | `action` ∈ `create, fund, repay, claim, cancel, default` → `{ transactionId, xdr, hash, networkPassphrase, expiresAt, summary }` (simulated, unsigned) |
| POST | `/chain/transactions/:txId/submit` | `{ signedXdr }` → submits if the hash matches; returns `{ status: success\|failed\|submitted, hash, ledger, explorerUrl, invoice }` |
| GET | `/chain/transactions` | your submitted transactions |
| GET | `/chain/transactions/:txId` | re-check a pending transaction |
| GET | `/chain/account` | wallet balances (Horizon) + Friendbot link on testnet |
| GET | `/chain/activity` | recent wallet operations (Horizon) |

### Documents and extraction
| Method | Path | Description |
|---|---|---|
| POST | `/documents` | multipart field `file` (PDF/PNG/JPEG/WebP, ≤ 4 MB) → `{ document, extraction, alreadyRegistered, duplicateUpload }` |
| GET | `/documents` | your documents |
| GET | `/documents/:id` | document + latest extraction |
| GET | `/documents/:id/file` | the original file (owner only, sandboxed) |
| POST | `/documents/:id/extract` | `{ engine?: "claude" \| "local" }` re-run extraction |
| DELETE | `/documents/:id` | delete (not if backing a listed invoice) |
| PUT | `/extractions/:id/review` | `{ fields }` save the human-reviewed fields (re-validated) |
| POST | `/extractions/:id/invoice` | `{ discountBps, notes?, buyerCountry? }` create a draft from the reviewed fields |

### Assistant
| Method | Path | Description |
|---|---|---|
| GET | `/assistant/status` | AI configured, model, knowledge index |
| GET/POST | `/assistant/conversations` | list / create `{ audience }` |
| GET/PATCH/DELETE | `/assistant/conversations/:id` | read / `{ audience?, title? }` / delete |
| POST | `/assistant/conversations/:id/messages` | `{ content, context?: { view?, invoiceId? } }` (`view` = the screen the user is on; the server loads the data itself) → **Server-Sent Events**: `start`, `sources`, `text` (`delta`), `followups`, `done` or `error` (`message`, `status`) |

### ML transparency
| GET | `/ml/models` | deployed risk model: version, dataset, metrics, features |
|---|---|---|

## Status codes
400 validation / business rule · 401 not signed in · 403 CSRF or origin · 404 not found or not visible to you · 409 state conflict · 410 prepared transaction expired · 413 too large · 415 unsupported file · 422 unreadable document / AI refusal · 429 rate limited · 502/503 upstream (Stellar, AI) unavailable.
