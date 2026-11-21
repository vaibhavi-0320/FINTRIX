---
title: Financial concepts
category: finance
---
# Financial concepts used in Fintrix

## Invoice
A document a seller sends a buyer requesting payment for goods or services delivered. It normally states an invoice number, issue date, due date, the two parties, line items, subtotal, tax and total.

## Accounts receivable
Money owed to a business by its customers. Unpaid invoices are accounts receivable.

## Invoice financing and factoring
Invoice financing lets a business get cash now against its unpaid invoices. In **factoring**, the business sells the invoice at a discount to a financier, who receives the payment later. Fintrix's model is close to factoring: the investor pays a discounted price now and receives the full repayment later.

## Discount and price
The **discount** is the reduction the seller offers in exchange for being paid early, expressed in basis points (bps). 100 bps = 1%. Price = total × (1 − discount).

## Return and annualised yield
Return = repayment − price. Annualised yield expresses the return as a yearly rate so deals of different lengths can be compared: (return ÷ price) × (365 ÷ days to due date). Fintrix uses this simple-interest formula; it ignores compounding and assumes repayment exactly on the due date.

## Payment terms
How long the buyer has to pay, often written "Net 30" (30 days after the issue date).

## Late payment and default
A payment is **late** when it arrives after the due date. A **default** is a failure to pay. In Fintrix, an investor can record a default on-chain after the due date; it does not by itself recover money.

## Credit risk
The risk that the payer does not pay in full or on time. Fintrix's risk score estimates the probability of late payment; it is not a credit rating and not financial advice.

## Double financing
A fraud where the same invoice is sold or pledged to several financiers. Fintrix blocks this on-chain by allowing only one active listing per document fingerprint.

## Stablecoin
A token designed to track a currency such as the US dollar. A production deployment of invoice financing would normally settle in a stablecoin (such as USDC on Stellar) rather than XLM, to avoid exchange-rate risk. The Fintrix contract accepts any Stellar token configured at deployment; the testnet deployment uses XLM.
