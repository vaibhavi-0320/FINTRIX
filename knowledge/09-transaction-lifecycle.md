---
title: Transaction lifecycle
category: blockchain
---
# How a Fintrix transaction moves from click to confirmation

1. **Prepare.** You click an action such as Fund. The API checks you are allowed to do it and builds the contract call with your account as the source.
2. **Simulate.** The API simulates the call on Stellar RPC. Simulation catches contract errors (for example "invoice already funded" or insufficient balance) before you sign anything, and computes the resource fee.
3. **Review and sign.** Your wallet (Freighter or Albedo) opens and shows the transaction. Nothing happens unless you approve. Declining is safe.
4. **Hash check.** The signed transaction goes back to the API, which only accepts it if its hash equals the transaction it prepared.
5. **Submit.** The API sends it to the network.
6. **Confirm.** The API polls the network until the transaction is final. Fintrix only reports success after the network confirms the transaction (status SUCCESS) in a ledger. If confirmation takes longer than about 25 seconds, the transaction is shown as Pending and you can refresh it.
7. **Sync.** The API reads the invoice back from the contract and updates its database from the on-chain state.

## Transaction statuses
- **Prepared** – built but not yet signed. Expires after 5 minutes.
- **Submitted / Pending** – sent to the network, awaiting a final result.
- **Success** – included in a ledger and executed successfully.
- **Failed** – included but failed, or rejected by the network. No state change happened.
- **Expired** – not signed before its time limit.

## Fees
Every Stellar transaction pays a small fee in XLM (on testnet, test XLM). Contract calls also pay a resource fee determined by simulation.
