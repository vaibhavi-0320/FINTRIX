---
title: Troubleshooting
category: support
---
# Troubleshooting

## "Freighter is not installed"
Install Freighter from freighter.app, unlock it, then reload the Fintrix page. Or choose **Albedo Wallet** on the Connect Wallet screen, which needs no install.

## The Albedo popup does not open
Allow popups for the Fintrix site, then press **Click to connect** again.

## "Freighter is on another network"
In Freighter open the network menu and choose Testnet. Fintrix refuses to sign on a network that differs from the app's.

## "Wallet is not activated on testnet"
New Stellar accounts must be funded before use. Open `https://friendbot.stellar.org/?addr=<your address>` (or use *Fund with Friendbot* in Freighter), then try again. Listing an invoice shows "not activated on testnet" until you do.

## "Insufficient balance"
Your wallet needs enough XLM for the amount plus fees. On testnet you can create another funded account with Friendbot. Each account must also keep a minimum XLM reserve.

## "You declined the transaction"
You rejected the request in your wallet. Nothing was sent. Start the action again when ready. If it was a listing, your reviewed invoice was kept as a draft: press **Confirm fields & list on marketplace →** again.

## "This transaction expired before it was signed"
Prepared transactions are valid for 5 minutes. Start the action again.

## Transaction stays "Pending"
The network did not confirm within the wait time. Fintrix does not mark it as successful. Check the Dashboard activity a little later, or the explorer link.

## "Signed transaction does not match the transaction prepared by the server"
The wallet returned a different transaction from the one Fintrix prepared, for example because it was modified. Start the action again.

## "This invoice document is already financed or listed on-chain (duplicate)"
The contract already has an active invoice with the same document fingerprint. If you listed it before, cancel the earlier listing first.

## Extraction failed or fields are empty
- Scanned PDFs have no text layer. Upload a clear PNG/JPEG photo for OCR instead.
- Make sure the image is sharp, upright and well lit.
- You can type or correct any field in the review form before listing.
- With an AI key configured, Claude reads the document directly, which handles harder layouts.

## "AI is not configured on this server"
The administrator has not set `ANTHROPIC_API_KEY`. Extraction uses the local engine; the assistant shows this message and lists the matching help articles instead of answering.

## Signed out unexpectedly
Sessions expire after 7 days. Press **Connect Wallet** and sign in again.

## The page went back to the landing page after a refresh
That is expected: reloading replays the intro. You are still signed in; open the app again from the landing page.

## "No deals yet" when opening Deals
There are no listed invoices yet. Upload one in **Simulation** or check the **Marketplace** later.

## "You already have an invoice numbered …"
You already listed (or saved) an invoice with that number. Each invoice number can be used once per seller.
