use soroban_sdk::contracterror;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum ContractError {
    InvoiceNotFound = 1,
    InvalidAmount = 2,
    InvalidDueDate = 3,
    DuplicateDocument = 4,
    InvalidStatus = 5,
    SelfFunding = 6,
    InvoiceExpired = 7,
    NotInvestor = 8,
    NotSeller = 9,
    NotYetDue = 10,
}
