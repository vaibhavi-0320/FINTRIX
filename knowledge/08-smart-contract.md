---
title: The Fintrix escrow smart contract
category: blockchain
---
# The Fintrix escrow smart contract

The contract (`contracts/src/contract.rs`, crate `fintrix-escrow`) is a Soroban contract written in Rust. On testnet it is deployed at `CBH6Q4U2ESHZOHBS66JSLFRYR6SLFOHO4LKAF2MOHATM3KYIFAJXSSRX` and uses the native XLM Stellar Asset Contract as its settlement token.

## Invoice record on-chain
Each invoice stores: id (assigned by the contract), seller, investor (once funded), price, repayment, due date (Unix seconds), the SHA-256 hash of the invoice document, status, and creation/funding/repayment timestamps. Amounts are in the token's base units (1 XLM = 10,000,000 stroops).

## Status lifecycle
Listed → Funded → Repaid → Settled. A listed invoice can be Cancelled by the seller. A funded invoice can be marked Defaulted by the investor after the due date; repayment is still accepted after a default.

## Methods
| Method | Who must sign | What it does |
|---|---|---|
| `create_invoice(seller, price, repayment, due_date, doc_hash)` | seller | Validates amounts (price > 0, repayment ≥ price), due date in the future and that the document hash is not already active; stores the invoice and returns its id. |
| `fund_invoice(id, investor)` | investor | Requires status Listed, investor ≠ seller and not past due; transfers `price` from investor to seller. |
| `repay_invoice(id, payer)` | payer (anyone) | Requires Funded or Defaulted; transfers `repayment` from the payer into the contract (escrow). |
| `claim(id)` | investor | Requires Repaid; transfers the escrowed repayment to the investor; status Settled. |
| `cancel_invoice(id)` | seller | Requires Listed; status Cancelled; frees the document hash for relisting. |
| `mark_defaulted(id)` | investor | Requires Funded and past the due date; status Defaulted. |
| `get_invoice(id)`, `invoice_count()`, `invoice_for_document(hash)`, `token()` | – | Read-only queries. |

## Events
The contract emits `created`, `funded`, `repaid`, `settled`, `cancelled` and `defaulted` events with the invoice id as a topic.

## Safety properties
- Every state-changing call checks authorisation with `require_auth` for the relevant party.
- State is updated before token transfers (checks-effects-interactions). Soroban executes atomically: if a transfer fails, the whole call reverts, including state changes.
- The contract never holds investor principal: funding goes directly to the seller. It only holds repayments until the investor claims them.
- Only one active invoice per document hash, which prevents double financing on-chain.
- Contract errors are numbered (1–10) and mapped to readable messages by the API.

## Error codes
1 invoice not found · 2 invalid amounts · 3 invalid due date · 4 duplicate document · 5 wrong status for this action · 6 self-funding · 7 invoice expired · 8 not the investor · 9 not the seller · 10 not yet due.

## Tests
`cargo test --manifest-path contracts/Cargo.toml` runs 12 unit tests against a real Stellar Asset Contract token in the Soroban test environment. They cover the full lifecycle with balance checks, authorisation requirements, invalid inputs, duplicate documents, state-machine ordering, defaults and insufficient balances.

## Limitations
The contract is not audited. It has no admin, upgrade or pause function: a new version requires a new deployment. It does not verify that the off-chain invoice is genuine; it only guarantees the on-chain terms and money movements.
