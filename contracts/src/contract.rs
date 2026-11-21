use soroban_sdk::{contract, contractevent, contractimpl, token, Address, BytesN, Env};

use crate::errors::ContractError;
use crate::storage;
use crate::types::{Invoice, InvoiceStatus};

#[contractevent(topics = ["created"])]
pub struct InvoiceCreated {
    #[topic]
    pub id: u64,
    pub seller: Address,
    pub price: i128,
    pub repayment: i128,
    pub due_date: u64,
}

#[contractevent(topics = ["funded"])]
pub struct InvoiceFunded {
    #[topic]
    pub id: u64,
    pub investor: Address,
    pub price: i128,
}

#[contractevent(topics = ["repaid"])]
pub struct InvoiceRepaid {
    #[topic]
    pub id: u64,
    pub payer: Address,
    pub amount: i128,
}

#[contractevent(topics = ["settled"])]
pub struct InvoiceSettled {
    #[topic]
    pub id: u64,
    pub investor: Address,
    pub amount: i128,
}

#[contractevent(topics = ["cancelled"])]
pub struct InvoiceCancelled {
    #[topic]
    pub id: u64,
}

#[contractevent(topics = ["defaulted"])]
pub struct InvoiceDefaulted {
    #[topic]
    pub id: u64,
}

/// Invoice-financing escrow.
///
/// * Funding moves `price` from the investor straight to the seller (the advance);
///   the contract never holds investor principal, so it cannot get stuck.
/// * Repayment moves `repayment` from the payer INTO the contract, where it is held
///   in escrow until the investor claims it.
/// * A document hash can back only one active invoice, preventing double financing.
#[contract]
pub struct InvoiceEscrowContract;

#[contractimpl]
impl InvoiceEscrowContract {
    pub fn __constructor(env: Env, token: Address) {
        storage::set_token(&env, &token);
        storage::bump_instance(&env);
    }

    pub fn token(env: Env) -> Address {
        storage::token(&env)
    }

    pub fn invoice_count(env: Env) -> u64 {
        storage::invoice_count(&env)
    }

    pub fn get_invoice(env: Env, id: u64) -> Result<Invoice, ContractError> {
        storage::read_invoice(&env, id)
    }

    pub fn invoice_for_document(env: Env, doc_hash: BytesN<32>) -> Option<u64> {
        storage::active_invoice_for_hash(&env, &doc_hash)
    }

    pub fn create_invoice(
        env: Env,
        seller: Address,
        price: i128,
        repayment: i128,
        due_date: u64,
        doc_hash: BytesN<32>,
    ) -> Result<u64, ContractError> {
        seller.require_auth();
        if price <= 0 || repayment < price {
            return Err(ContractError::InvalidAmount);
        }
        let now = env.ledger().timestamp();
        if due_date <= now {
            return Err(ContractError::InvalidDueDate);
        }
        if storage::active_invoice_for_hash(&env, &doc_hash).is_some() {
            return Err(ContractError::DuplicateDocument);
        }

        let id = storage::next_id(&env);
        let invoice = Invoice {
            id,
            seller: seller.clone(),
            investor: None,
            price,
            repayment,
            due_date,
            doc_hash: doc_hash.clone(),
            status: InvoiceStatus::Listed,
            created_at: now,
            funded_at: 0,
            repaid_at: 0,
        };
        storage::write_invoice(&env, &invoice);
        storage::set_hash_owner(&env, &doc_hash, id);
        storage::bump_instance(&env);

        InvoiceCreated { id, seller, price, repayment, due_date }.publish(&env);
        Ok(id)
    }

    pub fn cancel_invoice(env: Env, id: u64) -> Result<Invoice, ContractError> {
        let mut invoice = storage::read_invoice(&env, id)?;
        invoice.seller.require_auth();
        if invoice.status != InvoiceStatus::Listed {
            return Err(ContractError::InvalidStatus);
        }
        invoice.status = InvoiceStatus::Cancelled;
        storage::write_invoice(&env, &invoice);
        InvoiceCancelled { id }.publish(&env);
        Ok(invoice)
    }

    pub fn fund_invoice(env: Env, id: u64, investor: Address) -> Result<Invoice, ContractError> {
        investor.require_auth();
        let mut invoice = storage::read_invoice(&env, id)?;
        if invoice.status != InvoiceStatus::Listed {
            return Err(ContractError::InvalidStatus);
        }
        if investor == invoice.seller {
            return Err(ContractError::SelfFunding);
        }
        let now = env.ledger().timestamp();
        if now >= invoice.due_date {
            return Err(ContractError::InvoiceExpired);
        }

        // Effects before interactions.
        invoice.investor = Some(investor.clone());
        invoice.status = InvoiceStatus::Funded;
        invoice.funded_at = now;
        storage::write_invoice(&env, &invoice);

        token::Client::new(&env, &storage::token(&env)).transfer(&investor, &invoice.seller, &invoice.price);

        InvoiceFunded { id, investor, price: invoice.price }.publish(&env);
        Ok(invoice)
    }

    /// Anyone may repay on the seller's behalf (e.g. the debtor paying the invoice).
    pub fn repay_invoice(env: Env, id: u64, payer: Address) -> Result<Invoice, ContractError> {
        payer.require_auth();
        let mut invoice = storage::read_invoice(&env, id)?;
        if invoice.status != InvoiceStatus::Funded && invoice.status != InvoiceStatus::Defaulted {
            return Err(ContractError::InvalidStatus);
        }

        invoice.status = InvoiceStatus::Repaid;
        invoice.repaid_at = env.ledger().timestamp();
        storage::write_invoice(&env, &invoice);

        let contract = env.current_contract_address();
        token::Client::new(&env, &storage::token(&env)).transfer(&payer, &contract, &invoice.repayment);

        InvoiceRepaid { id, payer, amount: invoice.repayment }.publish(&env);
        Ok(invoice)
    }

    /// Releases escrowed repayment to the investor.
    pub fn claim(env: Env, id: u64) -> Result<Invoice, ContractError> {
        let mut invoice = storage::read_invoice(&env, id)?;
        if invoice.status != InvoiceStatus::Repaid {
            return Err(ContractError::InvalidStatus);
        }
        let investor = invoice.investor.clone().ok_or(ContractError::NotInvestor)?;
        investor.require_auth();

        invoice.status = InvoiceStatus::Settled;
        storage::write_invoice(&env, &invoice);

        let contract = env.current_contract_address();
        token::Client::new(&env, &storage::token(&env)).transfer(&contract, &investor, &invoice.repayment);

        InvoiceSettled { id, investor, amount: invoice.repayment }.publish(&env);
        Ok(invoice)
    }

    /// Investor records that the invoice is overdue. Repayment is still accepted afterwards.
    pub fn mark_defaulted(env: Env, id: u64) -> Result<Invoice, ContractError> {
        let mut invoice = storage::read_invoice(&env, id)?;
        let investor = invoice.investor.clone().ok_or(ContractError::NotInvestor)?;
        investor.require_auth();
        if invoice.status != InvoiceStatus::Funded {
            return Err(ContractError::InvalidStatus);
        }
        if env.ledger().timestamp() <= invoice.due_date {
            return Err(ContractError::NotYetDue);
        }
        invoice.status = InvoiceStatus::Defaulted;
        storage::write_invoice(&env, &invoice);
        InvoiceDefaulted { id }.publish(&env);
        Ok(invoice)
    }
}
