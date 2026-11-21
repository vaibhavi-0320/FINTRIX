#![cfg(test)]
extern crate std;

use soroban_sdk::testutils::{Address as _, AuthorizedFunction, Ledger};
use soroban_sdk::token::{StellarAssetClient, TokenClient};
use soroban_sdk::{Address, BytesN, Env, IntoVal, Symbol};

use crate::contract::{InvoiceEscrowContract, InvoiceEscrowContractClient};
use crate::errors::ContractError;
use crate::types::InvoiceStatus;

const NOW: u64 = 1_800_000_000;
const DAY: u64 = 86_400;

struct Setup<'a> {
    env: Env,
    client: InvoiceEscrowContractClient<'a>,
    token: TokenClient<'a>,
    seller: Address,
    investor: Address,
    contract: Address,
}

fn setup() -> Setup<'static> {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().with_mut(|ledger| ledger.timestamp = NOW);

    let issuer = Address::generate(&env);
    let sac = env.register_stellar_asset_contract_v2(issuer);
    let token_id = sac.address();
    let minter = StellarAssetClient::new(&env, &token_id);

    let seller = Address::generate(&env);
    let investor = Address::generate(&env);
    minter.mint(&seller, &1_000_000);
    minter.mint(&investor, &1_000_000);

    let contract = env.register(InvoiceEscrowContract, (token_id.clone(),));
    let client = InvoiceEscrowContractClient::new(&env, &contract);
    let token = TokenClient::new(&env, &token_id);
    Setup { env, client, token, seller, investor, contract }
}

fn hash(env: &Env, byte: u8) -> BytesN<32> {
    BytesN::from_array(env, &[byte; 32])
}

fn create(s: &Setup, byte: u8) -> u64 {
    s.client.create_invoice(&s.seller, &9_000, &10_000, &(NOW + 30 * DAY), &hash(&s.env, byte))
}

#[test]
fn full_lifecycle_moves_funds_and_escrows_repayment() {
    let s = setup();
    let id = create(&s, 1);
    assert_eq!(id, 1);
    assert_eq!(s.client.invoice_count(), 1);
    assert_eq!(s.client.get_invoice(&id).status, InvoiceStatus::Listed);

    // Funding: investor pays the seller the price directly.
    let funded = s.client.fund_invoice(&id, &s.investor);
    assert_eq!(funded.status, InvoiceStatus::Funded);
    assert_eq!(funded.investor, Some(s.investor.clone()));
    assert_eq!(s.token.balance(&s.investor), 1_000_000 - 9_000);
    assert_eq!(s.token.balance(&s.seller), 1_000_000 + 9_000);
    assert_eq!(s.token.balance(&s.contract), 0);

    // Repayment: seller pays into the contract, which holds it in escrow.
    let repaid = s.client.repay_invoice(&id, &s.seller);
    assert_eq!(repaid.status, InvoiceStatus::Repaid);
    assert_eq!(s.token.balance(&s.contract), 10_000);
    assert_eq!(s.token.balance(&s.seller), 1_000_000 + 9_000 - 10_000);

    // Claim: escrow released to the investor.
    let settled = s.client.claim(&id);
    assert_eq!(settled.status, InvoiceStatus::Settled);
    assert_eq!(s.token.balance(&s.contract), 0);
    assert_eq!(s.token.balance(&s.investor), 1_000_000 - 9_000 + 10_000);
}

#[test]
fn fund_requires_investor_authorization() {
    let s = setup();
    let id = create(&s, 2);
    s.client.fund_invoice(&id, &s.investor);
    let auths = s.env.auths();
    let (who, invocation) = &auths[0];
    assert_eq!(who, &s.investor);
    assert_eq!(
        invocation.function,
        AuthorizedFunction::Contract((s.contract.clone(), Symbol::new(&s.env, "fund_invoice"), (id, s.investor.clone()).into_val(&s.env)))
    );
}

#[test]
fn create_requires_seller_authorization() {
    let s = setup();
    create(&s, 3);
    let auths = s.env.auths();
    assert_eq!(auths[0].0, s.seller);
}

#[test]
fn rejects_invalid_amounts_and_due_dates() {
    let s = setup();
    let h = hash(&s.env, 4);
    assert_eq!(s.client.try_create_invoice(&s.seller, &0, &10, &(NOW + DAY), &h), Err(Ok(ContractError::InvalidAmount)));
    assert_eq!(s.client.try_create_invoice(&s.seller, &100, &99, &(NOW + DAY), &h), Err(Ok(ContractError::InvalidAmount)));
    assert_eq!(s.client.try_create_invoice(&s.seller, &100, &110, &NOW, &h), Err(Ok(ContractError::InvalidDueDate)));
}

#[test]
fn blocks_double_financing_of_the_same_document() {
    let s = setup();
    create(&s, 5);
    assert_eq!(
        s.client.try_create_invoice(&s.seller, &1, &2, &(NOW + DAY), &hash(&s.env, 5)),
        Err(Ok(ContractError::DuplicateDocument))
    );
    assert_eq!(s.client.invoice_for_document(&hash(&s.env, 5)), Some(1));
}

#[test]
fn cancelled_document_can_be_relisted() {
    let s = setup();
    let id = create(&s, 6);
    s.client.cancel_invoice(&id);
    assert_eq!(s.client.invoice_for_document(&hash(&s.env, 6)), None);
    let relisted = create(&s, 6);
    assert_eq!(relisted, 2);
}

#[test]
fn cannot_fund_twice_self_fund_or_after_due_date() {
    let s = setup();
    let id = create(&s, 7);
    assert_eq!(s.client.try_fund_invoice(&id, &s.seller), Err(Ok(ContractError::SelfFunding)));
    s.client.fund_invoice(&id, &s.investor);
    assert_eq!(s.client.try_fund_invoice(&id, &s.investor), Err(Ok(ContractError::InvalidStatus)));

    let late = create(&s, 8);
    s.env.ledger().with_mut(|ledger| ledger.timestamp = NOW + 31 * DAY);
    assert_eq!(s.client.try_fund_invoice(&late, &s.investor), Err(Ok(ContractError::InvoiceExpired)));
}

#[test]
fn state_machine_rejects_out_of_order_calls() {
    let s = setup();
    let id = create(&s, 9);
    assert_eq!(s.client.try_repay_invoice(&id, &s.seller), Err(Ok(ContractError::InvalidStatus)));
    assert_eq!(s.client.try_claim(&id), Err(Ok(ContractError::InvalidStatus)));
    s.client.fund_invoice(&id, &s.investor);
    assert_eq!(s.client.try_cancel_invoice(&id), Err(Ok(ContractError::InvalidStatus)));
    assert_eq!(s.client.try_claim(&id), Err(Ok(ContractError::InvalidStatus)));
    assert_eq!(s.client.try_get_invoice(&99), Err(Ok(ContractError::InvoiceNotFound)));
}

#[test]
fn default_only_after_due_date_and_repayment_still_accepted() {
    let s = setup();
    let id = create(&s, 10);
    s.client.fund_invoice(&id, &s.investor);
    assert_eq!(s.client.try_mark_defaulted(&id), Err(Ok(ContractError::NotYetDue)));
    s.env.ledger().with_mut(|ledger| ledger.timestamp = NOW + 31 * DAY);
    assert_eq!(s.client.mark_defaulted(&id).status, InvoiceStatus::Defaulted);
    assert_eq!(s.client.repay_invoice(&id, &s.seller).status, InvoiceStatus::Repaid);
    assert_eq!(s.client.claim(&id).status, InvoiceStatus::Settled);
}

#[test]
fn third_party_can_repay_on_behalf_of_seller() {
    let s = setup();
    let id = create(&s, 11);
    s.client.fund_invoice(&id, &s.investor);
    let debtor = Address::generate(&s.env);
    StellarAssetClient::new(&s.env, &s.token.address).mint(&debtor, &50_000);
    s.client.repay_invoice(&id, &debtor);
    assert_eq!(s.token.balance(&debtor), 40_000);
    assert_eq!(s.token.balance(&s.contract), 10_000);
}

#[test]
#[should_panic]
fn claim_without_investor_auth_fails() {
    let s = setup();
    let id = create(&s, 12);
    s.client.fund_invoice(&id, &s.investor);
    s.client.repay_invoice(&id, &s.seller);
    // Drop the blanket auth mock: the investor has not authorised this call.
    s.env.set_auths(&[]);
    s.client.claim(&id);
}

#[test]
fn insufficient_balance_reverts_funding() {
    let s = setup();
    let poor = Address::generate(&s.env);
    let id = create(&s, 13);
    assert!(s.client.try_fund_invoice(&id, &poor).is_err());
    assert_eq!(s.client.get_invoice(&id).status, InvoiceStatus::Listed);
}
