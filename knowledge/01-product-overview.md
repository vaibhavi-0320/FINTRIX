---
title: What is Fintrix?
category: product
---
# What is Fintrix?

Fintrix is an invoice-financing marketplace built on the Stellar network. It connects businesses that are waiting to be paid on invoices (sellers) with investors who are willing to pay part of the invoice value now in exchange for receiving the full value when the invoice is paid.

## The problem it addresses

Small and medium-sized businesses often wait 30 to 90 days for customers to pay invoices. During that time the business has delivered goods or services but has no cash, which makes payroll, inventory and growth harder. Traditional invoice factoring exists, but it is often slow, opaque, paperwork-heavy and unavailable to smaller or cross-border businesses.

## What Fintrix does

1. A seller uploads an invoice (PDF or image).
2. Fintrix extracts the invoice data (invoice number, dates, parties, amounts, line items) using AI or local OCR, and validates it with deterministic checks.
3. The seller reviews and corrects the extracted data. Nothing extracted is treated as verified until the seller confirms it.
4. The seller chooses a discount and lists the invoice. Listing records the invoice in a Soroban smart contract on Stellar, together with a fingerprint (SHA-256 hash) of the invoice document.
5. An investor funds the listed invoice by signing a Stellar transaction in their own wallet. The price (invoice value minus the discount) goes directly to the seller.
6. When the buyer pays the seller, the seller repays the full invoice value into the smart contract, which holds it in escrow.
7. The investor claims the escrowed repayment. The difference between what they paid and what they receive is their return.

## Current status

Fintrix currently runs on the **Stellar testnet**. Testnet tokens have no monetary value, and no real money is involved. It is a working prototype, not a regulated financial service.

## What makes it different

- Settlement happens on-chain through a smart contract, so funding and repayment are publicly verifiable on a block explorer.
- The contract refuses to list the same document twice while it is active, which blocks a common invoice-fraud pattern: financing the same invoice with several investors.
- Users keep custody: Fintrix never holds private keys. Every transaction is signed by the user in their own wallet.
- AI is used for document understanding and for an assistant, but every financial action requires explicit human confirmation.
