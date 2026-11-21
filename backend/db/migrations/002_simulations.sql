-- Testnet "simulation" proofs from the Simulation page: a 1 XLM self-payment that
-- records the investor's projected return on-chain (memo) without moving funds to anyone.
ALTER TABLE chain_transactions DROP CONSTRAINT IF EXISTS chain_transactions_kind_check;
ALTER TABLE chain_transactions ADD CONSTRAINT chain_transactions_kind_check
  CHECK (kind IN ('create', 'fund', 'repay', 'claim', 'cancel', 'default', 'simulation'));
