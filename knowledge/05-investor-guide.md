---
title: Guide for investors
category: workflow
---
# Guide for investors: funding invoices

## How returns work
You pay the **price** of an invoice (its total minus the seller's discount) and later receive the full **repayment** amount when the seller repays. Your return is repayment − price. Fintrix shows the **APY** (annualised yield) with simple interest: (return ÷ price) × (365 ÷ days until the due date). This is an estimate that assumes on-time repayment, not a guarantee. Example: paying $970 for a $1,000 invoice due in 45 days returns $30, about 25.1% annualised.

## Trying it first: the Investment Simulator
On **Simulation**, the Investment Simulator lets you pick a listed deal and an amount and see the projected return. **Simulate on Testnet ▷** records that simulation on-chain as a 1 XLM payment to yourself with a memo. It does not invest.

## Funding an invoice
1. Connect your wallet (Freighter on Testnet, or Albedo) and make sure you hold enough XLM for the price plus a small network fee. Your balance is shown in the sidebar and in the deal's Investment Panel.
2. Open **Marketplace**, filter or search, and press **View Details** on a deal. Review the amount, APY, duration, repayment date, Risk Level, the modelled late-payment probability and any duplicate warnings.
3. Press **FUND THIS INVOICE**. Fintrix prepares a `fund_invoice` transaction and your wallet shows it for approval. Funding is all-or-nothing: you pay the full price in one transaction. The amount field is read-only for that reason.
4. The contract transfers the price from your wallet to the seller. Fintrix shows "Confirmed on Stellar testnet" only after the network confirms it, with the hash and an explorer link.

You cannot fund your own invoice, and you cannot fund an invoice after its due date.

## Getting repaid
When the seller repays, the money sits in the smart contract and the deal shows REPAID · AWAITING CLAIM. Open the deal and press **CLAIM REPAYMENT** to transfer the escrowed amount to your wallet. The deal then shows SETTLED. Repayment is not sent to you automatically: you must claim it.

## If the seller does not repay
After the due date you can press **Mark as defaulted** on the deal. This is a public on-chain record; it does not recover funds. The seller can still repay after a default, and you can then claim. Fintrix offers no guarantee, insurance, collections or legal enforcement. You can lose the amount you paid.

## Risk information (Trust Score)
- The **Trust Score**, **Risk Level** and **Risk Rating** shown in the app come from a machine-learning model's estimated probability of late payment (see "AI and machine learning in Fintrix"). The deal page shows it as "Modelled late-payment probability: N%". Lower is safer: LOW is below 40% (marketplace grade A+), MEDIUM is 40–65% (grade B), HIGH is 65% and above (grade B+). It is an indicator, not a credit rating.
- **Duplicate warnings** appear when an invoice looks like another one (same document, same number and buyer, or same buyer and amount issued days apart).
- Listings marked as demo were created by the Fintrix team for testing.
