---
title: Features and screens
category: product
---
# Features and screens of the Fintrix app

## Landing page and connecting a wallet
The landing page explains Fintrix. **Connect Wallet** opens the Connect Wallet screen with two choices: **Freighter Wallet** (browser extension) and **Albedo Wallet** (web wallet, no install). Choose one and press **Click to connect**. The wallet then asks you to sign a one-time sign-in message. Signing proves you control the account; it does not authorise any payment. The server verifies the signature and starts a session stored in a secure, HTTP-only cookie (7 days by default). Reloading the page replays the intro and returns to the landing page, but you stay signed in.

## Sidebar
After connecting, the left sidebar has **Dashboard**, **Simulation**, **Marketplace**, **Deals** and **Resources**. The bottom shows your connected wallet address and live XLM balance. **Disconnect** signs you out. On phones the sidebar opens from the menu button.

## Dashboard
Only real data: your XLM balance read from Stellar, your portfolio (invoices you have funded, with amounts and status), your recent on-chain activity, and the simulations you have recorded. A brand-new wallet shows empty states and "Not funded"; nothing is invented.

## Simulation page
It has two parts.

**Financing Journey** shows the four stages of an invoice: Upload Invoice → AI Verification → Marketplace → Funding/Repayment. In the upload stage you press **Browse Files** (or drag a file) to upload a PDF, PNG or JPG invoice of up to 4 MB. Fintrix extracts the invoice number, dates, issuer, buyer, currency and amounts, then shows them in a review form. You correct anything wrong, set the discount you offer investors (0–30%, default 3%), and press **Confirm fields & list on marketplace →**. Your wallet asks you to approve the on-chain listing. When the network confirms it, you see "Listed on Stellar testnet" with an explorer link.

**Investment Simulator** lets you pick a listed deal and an amount and see the projected return. **Simulate on Testnet ▷** records the simulation on-chain: you sign a 1 XLM payment from your account to itself with a memo naming the deal. It makes no investment, and the simulation then appears on your Dashboard.

## Marketplace
The "Invoice Opportunities" page lists invoices open for funding. It has tabs (All, Active, Funded, Repaid), filters for minimum APY and risk, and a **Search Invoices...** box. Each card shows the buyer, amount, Yield (APY), Duration, Risk Rating and a **View Details** button. Drafts and cancelled listings are not shown.

## Deal detail ("Deals")
Opened with **View Details** (the sidebar's **Deals** item opens the first available deal). It shows the invoice amount, APY, duration, repayment date, funding progress (0% or 100%, because funding is all-or-nothing), buyer details, Risk & Structure (with the modelled late-payment probability), a cashflow timeline built from real timestamps, and the **Investment Panel** with the price and your available XLM.

The main button shows the action available to you:
- **FUND THIS INVOICE**: investors, on a listed invoice. You pay the full price in one transaction.
- **LIST ON MARKETPLACE**: sellers, on their own draft.
- **REPAY INTO ESCROW**: sellers, on a funded (or defaulted) invoice.
- **CLAIM REPAYMENT**: the investor, after the seller has repaid.

If no action is available, it shows the status instead: OPEN FOR FUNDING, FULLY FUNDED, REPAID · AWAITING CLAIM, SETTLED, LISTING CANCELLED or MARKED DEFAULTED. Text links below offer **Cancel listing** (the seller, before funding) and **Mark as defaulted** (the investor, after the due date). After every confirmed action the panel shows "Confirmed on Stellar testnet" with the transaction hash and a **View transaction** link.

## Funding success and Repayment Complete
After a confirmed funding, the investor sees a success screen. After a confirmed repayment, the seller sees **Repayment Complete**.

## Resources
Guides, the invoice lifecycle and an FAQ.

## Fintrix AI assistant
The round Fintrix button at the bottom right opens the assistant on every screen after the landing page. It answers from this knowledge base and from your live data: the screen you are on, the deal you have open, your balance, your invoices, investments and recent transactions. It names its sources. **Pre-funding checklist** and **Detect red flags** run checks on the deal you have open. It cannot sign or move anything.
