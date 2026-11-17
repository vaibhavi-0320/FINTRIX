# Stellar integration

Fintrix uses **both** Stellar layers:
- **Soroban smart contract** (`contracts/`) for the invoice escrow: create, fund, repay, claim, cancel, default.
- **Stellar Classic / Horizon** for account balances and wallet activity history, and **Friendbot** for testnet funding.

The previous version made plain XLM payments to a hard-coded address and never called its contract; that was replaced.

## Networks

| | Testnet (default) | Mainnet |
|---|---|---|
| Passphrase | `Test SDF Network ; September 2015` | `Public Global Stellar Network ; September 2015` |
| Horizon | https://horizon-testnet.stellar.org | https://horizon.stellar.org |
| RPC | https://soroban-testnet.stellar.org | must be configured (`STELLAR_RPC_URL`) |
| Explorer | stellar.expert/explorer/testnet | stellar.expert/explorer/public |

`STELLAR_NETWORK` selects the network on the server and `VITE_STELLAR_NETWORK` in the browser; the two must match. The server **refuses mainnet** unless `NODE_ENV=production` and an RPC URL is configured. The browser refuses to sign if Freighter is on a different network, or if the server's network passphrase differs from the app's. A small badge on every screen shows "Testnet · no real funds". **The contract is deployed on testnet only.**

## Deployed contract (testnet)

| | |
|---|---|
| Contract id | `CBH6Q4U2ESHZOHBS66JSLFRYR6SLFOHO4LKAF2MOHATM3KYIFAJXSSRX` |
| Settlement token | native XLM Stellar Asset Contract `CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC` |
| Deploy tx | [3df75375…](https://stellar.expert/explorer/testnet/tx/3df75375b8e62a8a8565902bcb60009ca6812cd01c4df30e1f4f032334e4b690) |
| WASM | `target/wasm32v1-none/release/fintrix_escrow.wasm` (12.5 KB), soroban-sdk 25.3 |

### Contract interface
| Method | Auth | Effect |
|---|---|---|
| `__constructor(token)` | – | sets the settlement token |
| `create_invoice(seller, price, repayment, due_date, doc_hash) → u64` | seller | validates (price > 0, repayment ≥ price, due date in future, doc hash not active); stores the invoice; emits `created` |
| `fund_invoice(id, investor)` | investor | Listed, investor ≠ seller, not past due → transfer **price investor → seller**; emits `funded` |
| `repay_invoice(id, payer)` | payer | Funded/Defaulted → transfer **repayment payer → contract (escrow)**; emits `repaid` |
| `claim(id)` | investor | Repaid → transfer **repayment contract → investor**; Settled; emits `settled` |
| `cancel_invoice(id)` | seller | Listed → Cancelled; frees the document hash |
| `mark_defaulted(id)` | investor | Funded and past due → Defaulted (record only) |
| `get_invoice`, `invoice_count`, `invoice_for_document`, `token` | – | read-only |

Error codes 1–10 are mapped to readable messages in `backend/modules/chain/soroban.ts`. Storage TTLs are extended on every touch (about 30 days).

### Safety properties
- `require_auth` on every state-changing call for the correct party.
- State is written before token transfers. Soroban calls are atomic, so a failed transfer reverts everything.
- The contract never holds investor principal; it holds only repayments awaiting claim.
- One active invoice per document SHA-256 blocks double financing.
- `overflow-checks = true` in the release profile.
- **Not audited.** There is no admin/upgrade/pause function; upgrades require a new deployment.

### Build, test, deploy
```bash
npm run contract:test     # 12 Rust tests with a real Stellar Asset Contract token
npm run contract:build    # stellar contract build
stellar keys generate fintrix-deployer --network testnet --fund
stellar contract id asset --asset native --network testnet           # XLM SAC id
stellar contract deploy --wasm target/wasm32v1-none/release/fintrix_escrow.wasm \
  --source-account fintrix-deployer --network testnet -- --token <XLM_SAC_ID>
```
Put the printed contract id in `FINTRIX_CONTRACT_ID` and the SAC id in `SETTLEMENT_TOKEN_ID`.

## Wallet connection and sign-in
- **Freighter** (`@stellar/freighter-api` v6) is the supported wallet. Connecting calls `requestAccess` / `getAddress` and checks `getNetworkDetails` against the app's network.
- **Sign-in (SEP-53 message signing):** the server issues a one-time challenge (5-minute expiry) naming the domain, account, network and nonce, and stating that signing authorises no payment. Freighter signs it (`signMessage`). The server verifies it with `Keypair.verifyMessage` (raw-message signatures over the exact challenge are also accepted) and creates an HTTP-only session.
- Albedo and other wallets are **not** supported. They appeared in the old UI without a working signing path and were removed.

## Transaction lifecycle
```
Browser                         API                                Stellar RPC
  │ POST /invoices/:id/actions/fund
  │ ─────────────────────────────▶ authorisation checks
  │                                build invokeHostFunction (source = user)
  │                                prepareTransaction ───────────────▶ simulate
  │                                store expected tx hash  ◀────────── footprint, fees, auth
  │ ◀───────────────────────────── unsigned XDR + summary
  │ Freighter: user approves & signs
  │ POST /chain/transactions/:id/submit {signedXdr}
  │ ─────────────────────────────▶ reject unless hash == prepared hash
  │                                sendTransaction ──────────────────▶
  │                                poll getTransaction until SUCCESS/FAILED (≤ ~25 s)
  │                                get_invoice (read) ───────────────▶ contract state
  │                                sync DB from chain state
  │ ◀───────────────────────────── status, ledger, explorer link, updated invoice
```
- Success is reported **only** after the network returns `SUCCESS`. If confirmation takes longer, the status is `submitted` (shown as Pending) and `GET /api/chain/transactions/:id` re-checks it.
- A prepared transaction expires after 5 minutes (time bounds); expired ones are rejected with 410.
- Simulation errors (insufficient balance, wrong state, duplicate document, unfunded account) are shown **before** the user signs anything.
- Every confirmed transaction links to Stellar Expert. The Transactions page has both the Fintrix-submitted transactions and the wallet's recent Horizon operations.

## Amounts and conversion
Invoices are in USD; the testnet contract settles in XLM. `USD_PER_XLM` (default 0.11) is a **fixed, configured conversion rate, not a market price**. On-chain amounts are fixed at listing and shown before signing. Only USD invoices can be listed. A production deployment should settle in a stablecoin such as USDC: the contract is token-agnostic, so deploy it with the USDC SAC address.

## Evidence (testnet)
- `tests/backend/testnet.integration.test.ts` (`npm run test:testnet`): fresh Friendbot accounts → list → tamper attempt rejected → fund (seller balance +485 XLM exactly) → duplicate document blocked by the contract → repay → claim (contract state Settled) → history. 7/7 passing.
- `e2e/testnet-journey.spec.ts` (`npm run test:e2e:testnet`): the same lifecycle through the real UI in Chromium. Passing.

## Keys and secrets
Fintrix never handles user keys. The deployer and test identities live in the Stellar CLI keystore on the developer machine, outside the repo. `npm run demo:seed` stores the **testnet-only** demo seller key in `.data/demo-sellers.json` (git-ignored) so `npm run demo:repay` can complete the demo lifecycle. Never put a mainnet secret there.
