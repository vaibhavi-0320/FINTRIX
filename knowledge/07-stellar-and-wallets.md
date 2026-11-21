---
title: Stellar network and wallets
category: blockchain
---
# Stellar, Soroban and wallets

## Stellar
Stellar is a public blockchain designed for payments and asset issuance. Transactions settle in about five seconds with very low fees. Each account is identified by a public key starting with **G** (56 characters) and controlled by a secret key starting with **S**, which must never be shared.

## Testnet vs mainnet
- **Testnet** is a public test network. Its XLM is free (from Friendbot) and has no value. The network may be reset. Fintrix currently runs here.
- **Mainnet** (the public network) uses real XLM and real assets. Fintrix's configuration refuses to use mainnet outside a production deployment, and its contract is not deployed on mainnet.

The two networks are separated by their **network passphrase**. A transaction signed for testnet is invalid on mainnet. Fintrix checks that the wallet is on the same network as the app before asking you to sign.

## Soroban
Soroban is Stellar's smart-contract platform. Contracts are written in Rust, compiled to WebAssembly and identified by an address starting with **C**. Calling a contract is a Stellar transaction containing an `invoke_host_function` operation.

## Stellar Asset Contract (SAC)
Every Stellar asset, including native XLM, has a built-in contract interface so Soroban contracts can transfer it. Fintrix's escrow contract uses the native XLM SAC on testnet as its settlement token.

## Horizon and Stellar RPC
- **Horizon** is an API for account balances, payments and transaction history.
- **Stellar RPC** is used for smart contracts: simulating calls, submitting transactions and checking their status.

## Wallets: Freighter and Albedo

Fintrix supports two wallets, chosen on the Connect Wallet screen. **Albedo** is a web wallet (albedo.link) that opens in a popup and needs no extension; Fintrix asks it to sign on testnet.

### Freighter
Freighter is a browser extension wallet for Stellar maintained by the Stellar Development Foundation. Fintrix uses it to:
- share your public key (connect),
- sign the sign-in message (SEP-53 message signing),
- sign every contract transaction.

Your secret key never leaves Freighter. To set up: install Freighter from freighter.app, create an account, open Freighter's settings → Network and choose Testnet, then fund the account with Friendbot.

## Friendbot
A testnet service that creates and funds an account with 10,000 test XLM: `https://friendbot.stellar.org/?addr=<your G... address>`.

## Explorer
Stellar Expert (stellar.expert) shows transactions and contracts. Fintrix links every confirmed transaction there.
