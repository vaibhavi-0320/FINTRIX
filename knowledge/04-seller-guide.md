---
title: Guide for sellers
category: workflow
---
# Guide for sellers: getting an invoice financed

## Before you start
- Use **Freighter** (browser extension from freighter.app; set its network to **Testnet**) or **Albedo** (web wallet at albedo.link, no install).
- Fund your testnet account with free test XLM: in Freighter use *Fund with Friendbot*, or open `https://friendbot.stellar.org/?addr=<your address>`. A new account cannot sign transactions until it is funded.
- On the Fintrix landing page press **Connect Wallet**, choose your wallet, press **Click to connect** and approve the sign-in message.

## Step 1 – Upload the invoice
Open **Simulation** in the sidebar. In the Financing Journey's **Upload Invoice** step, press **Browse Files** (or drag the file in) and choose a PDF, PNG or JPG of up to 4 MB. Fintrix stores the file privately, calculates its SHA-256 fingerprint and extracts the fields. Claude is used when an AI key is configured; otherwise local PDF text reading and OCR are used. The panel then shows the issuer, buyer, invoice number, due date and amount it found.

## Step 2 – Review the fields
The review form shows every extracted field. Check and correct the invoice number, issue and due dates, your business (issuer), the buyer, currency, subtotal, tax and total. Nothing extracted is used until you confirm it.

## Step 3 – Set your discount
Enter the discount you offer investors (0–30%, default 3%). The form shows the result: the investor pays the total minus the discount now, and you repay the full total by the due date. Example: on a $1,000 invoice with a 3% discount, the investor pays $970 now and receives $1,000 at repayment.

## Step 4 – Confirm and list on-chain
Press **Confirm fields & list on marketplace →**. Fintrix saves the reviewed invoice, converts the USD amounts into XLM at the configured testnet rate, prepares a `create_invoice` contract call and asks your wallet to approve it. When the network confirms it, you see "Listed on Stellar testnet" with an explorer link, and the invoice appears on the Marketplace.

Only USD invoices with a due date in the future can be listed. If you decline in the wallet or listing fails, your reviewed invoice is kept as a draft and the error is shown. Press the button again to retry: the same draft is reused.

## Step 5 – Receive funding
When an investor funds your invoice, the price moves from the investor's wallet to yours in the same transaction. Your XLM balance in the sidebar rises and the deal shows FULLY FUNDED.

## Step 6 – Repay
When your buyer has paid you, open the deal (**Marketplace** → search for it → **View Details**) and press **REPAY INTO ESCROW**. You sign a `repay_invoice` transaction that moves the full repayment amount into the smart contract. The contract holds it in escrow until the investor claims it, and you see the **Repayment Complete** screen.

## Cancelling
Before anyone funds it, you can open the deal and choose **Cancel listing**. After cancellation the same document can be listed again.
