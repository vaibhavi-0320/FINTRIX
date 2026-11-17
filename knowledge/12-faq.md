---
title: Frequently asked questions
category: support
---
# Frequently asked questions

## Is real money involved?
No. Fintrix runs on the Stellar testnet. Test XLM is free and has no value.

## Which wallets are supported?
Freighter (browser extension) and Albedo (web wallet). Choose one on the Connect Wallet screen. Signing in and every on-chain action are signed in that wallet. Other wallets are not supported yet.

## Why do I have to sign a message to sign in?
Signing proves you control the wallet without revealing your secret key. The message says it does not authorise any transaction, and signing it cannot move funds.

## Why can I only list USD invoices?
Fintrix converts the USD value into the settlement asset at a configured rate. It does not perform currency conversion for other currencies, so they can be stored as drafts but not listed.

## How is the XLM amount calculated?
On testnet, amount in XLM = USD amount ÷ the configured USD-per-XLM rate (`USD_PER_XLM`, 0.11 by default). This is a fixed testnet conversion, not a live market price. The exact on-chain amounts are shown before you sign.

## Who decides the discount?
The seller, in the review form before listing (0–30%, default 3%).

## Can an invoice be funded by several investors?
Not currently. Each invoice is funded in full by one investor, so the deal page's amount is fixed at the price and funding progress is either 0% or 100%.

## Is the repayment sent to me automatically?
No. When the seller repays, the money is held in the smart contract. The investor opens the deal and presses **CLAIM REPAYMENT**.

## What does "Simulate on Testnet" do?
It records a projected investment on-chain as a 1 XLM payment from your account to itself, with a memo naming the deal. It does not fund anything. Simulations appear on the Dashboard.

## Where do I see my transactions?
The Dashboard's activity list shows your confirmed Fintrix transactions and simulations. Every confirmation also shows a link to the Stellar Expert explorer.

## What happens if the seller never repays?
After the due date the investor can mark the invoice as defaulted on-chain. Fintrix does not guarantee, insure or collect payments. Investing carries the risk of loss.

## Can the same invoice be listed twice?
Not while it is active. The contract stores the document's SHA-256 fingerprint and rejects a second active listing with the same fingerprint. Cancelled invoices can be relisted.

## Is the AI extraction always right?
No. Extraction can be wrong, which is why every field shows a confidence score and you must review and confirm the data before it becomes an invoice.

## Does the assistant give financial advice?
No. It explains how Fintrix and financial concepts work. It does not give personalised investment, legal or tax advice.

## Where is my data stored?
In the Fintrix Postgres database: your wallet address, invoices, uploaded documents, extraction results, assistant conversations and session records. On-chain data (invoice terms and transactions) is public on Stellar.

## Can I delete my data?
Drafts, unlisted documents and assistant conversations can be deleted through the API; the current app screens do not show drafts or saved conversations. On-chain records cannot be deleted from the blockchain.
