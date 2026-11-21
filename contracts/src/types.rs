use soroban_sdk::{contracttype, Address, BytesN};

/// Lifecycle of a financed invoice.
///
/// Listed -> Funded -> Repaid -> Settled
///   |          |
///   v          v
/// Cancelled  Defaulted (record only; repayment is still accepted afterwards)
#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum InvoiceStatus {
    Listed,
    Funded,
    Repaid,
    Settled,
    Cancelled,
    Defaulted,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Invoice {
    pub id: u64,
    pub seller: Address,
    pub investor: Option<Address>,
    /// Amount the investor pays the seller up front (settlement-token base units).
    pub price: i128,
    /// Amount the seller (or the debtor on their behalf) repays; >= price.
    pub repayment: i128,
    /// Unix timestamp (seconds) when repayment is due.
    pub due_date: u64,
    /// SHA-256 of the invoice document. Unique across active invoices to block double financing.
    pub doc_hash: BytesN<32>,
    pub status: InvoiceStatus,
    pub created_at: u64,
    pub funded_at: u64,
    pub repaid_at: u64,
}

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Token,
    NextId,
    Invoice(u64),
    DocHash(BytesN<32>),
}
