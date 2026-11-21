---
title: Security
category: technical
---
# Security in Fintrix

## Keys and custody
- Fintrix never asks for, receives or stores private keys or seed phrases. All signing happens in your wallet.
- Signing in proves account ownership through a one-time SEP-53 signed message that states it does not authorise any transaction.

## Sessions
- Sessions are random 256-bit tokens in an HTTP-only, SameSite=Lax cookie (Secure in production). The database stores only a SHA-256 hash of each token.
- Sign-in challenges expire after 5 minutes and can be used once.
- **Disconnect** in the sidebar ends your session on the server.

## Request protection
- State-changing API requests require a custom CSRF header, and any Origin header must match the site.
- CORS allows only configured origins.
- Rate limits apply to sign-in, blockchain, AI, upload and general API traffic. They are stored in Postgres, so they hold across serverless instances.
- All input is validated with strict schemas. Free text is stripped of markup.
- SQL uses parameterised queries only.

## Transactions
- The server prepares every transaction and records its hash. A signed transaction is only accepted if it is exactly the prepared one.
- Success is reported only after network confirmation, and the database is synced from the contract's state.
- AI output can never trigger a transaction. Financial actions always require your wallet signature.

## Uploads
- The file type is detected from the file's bytes (magic numbers), not the name or the declared type. Only PDF, PNG, JPEG and WebP up to 4 MB are accepted.
- Files are stored in the database and served only to their owner, with a sandboxing Content-Security-Policy and `nosniff`.

## Data access
- Draft invoices and documents are visible only to their owner. Conversations are private to their user.
- Security-relevant events (sign-in, uploads, chain actions) are written to an audit log without secrets.

## Known limitations
The smart contract and application have not had an external security audit. Fintrix is a testnet prototype.
