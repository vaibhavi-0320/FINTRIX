use soroban_sdk::{Address, BytesN, Env};

use crate::errors::ContractError;
use crate::types::{DataKey, Invoice, InvoiceStatus};

/// ~30 days of ledgers at 5s per ledger. Entries are bumped on every touch.
const TTL_THRESHOLD: u32 = 17_280 * 15;
const TTL_EXTEND_TO: u32 = 17_280 * 30;

pub fn bump_instance(env: &Env) {
    env.storage().instance().extend_ttl(TTL_THRESHOLD, TTL_EXTEND_TO);
}

pub fn set_token(env: &Env, token: &Address) {
    env.storage().instance().set(&DataKey::Token, token);
}

pub fn token(env: &Env) -> Address {
    env.storage().instance().get(&DataKey::Token).unwrap()
}

pub fn next_id(env: &Env) -> u64 {
    let id: u64 = env.storage().instance().get(&DataKey::NextId).unwrap_or(1);
    env.storage().instance().set(&DataKey::NextId, &(id + 1));
    id
}

pub fn invoice_count(env: &Env) -> u64 {
    let next: u64 = env.storage().instance().get(&DataKey::NextId).unwrap_or(1);
    next - 1
}

pub fn read_invoice(env: &Env, id: u64) -> Result<Invoice, ContractError> {
    let key = DataKey::Invoice(id);
    let invoice: Invoice = env.storage().persistent().get(&key).ok_or(ContractError::InvoiceNotFound)?;
    env.storage().persistent().extend_ttl(&key, TTL_THRESHOLD, TTL_EXTEND_TO);
    Ok(invoice)
}

pub fn write_invoice(env: &Env, invoice: &Invoice) {
    let key = DataKey::Invoice(invoice.id);
    env.storage().persistent().set(&key, invoice);
    env.storage().persistent().extend_ttl(&key, TTL_THRESHOLD, TTL_EXTEND_TO);
}

/// Returns the invoice currently holding this document hash, if it is still active.
pub fn active_invoice_for_hash(env: &Env, hash: &BytesN<32>) -> Option<u64> {
    let id: u64 = env.storage().persistent().get(&DataKey::DocHash(hash.clone()))?;
    match read_invoice(env, id) {
        Ok(invoice) if invoice.status != InvoiceStatus::Cancelled => Some(id),
        _ => None,
    }
}

pub fn set_hash_owner(env: &Env, hash: &BytesN<32>, id: u64) {
    let key = DataKey::DocHash(hash.clone());
    env.storage().persistent().set(&key, &id);
    env.storage().persistent().extend_ttl(&key, TTL_THRESHOLD, TTL_EXTEND_TO);
}
