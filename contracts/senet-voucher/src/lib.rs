#![no_std]
//! The Senet voucher contract.
//!
//! A payer signs one authorization entry for `redeem`. The signed arguments are
//! `amount`, `voucher_id` and `expire_at`. The `recipient` argument stays
//! outside the signed set. The party that redeems the voucher therefore selects
//! the recipient after the payer signs. A third party submits the transaction.
//!
//! The contract keeps no state for a voucher. The network consumes the nonce of
//! the authorization entry, so one signed entry pays one time. A payer voids a
//! voucher when the payer redeems it to their own address. That call consumes
//! the nonce and returns the amount to the payer.

use soroban_sdk::{
    contract, contracterror, contractevent, contractimpl, contracttype, token, Address, Bytes, Env,
    IntoVal, Val, Vec,
};

/// The XDR form of `stellar::Asset::Native`. The discriminant of the union is
/// `ASSET_TYPE_NATIVE`, which is 0, and the arm carries no body. The value is
/// therefore four zero bytes.
const NATIVE_ASSET_XDR: [u8; 4] = [0, 0, 0, 0];

/// The number of ledgers in one day. The network targets a close time of five
/// seconds, so one day holds 86,400 / 5 ledgers.
const LEDGERS_PER_DAY: u32 = 17_280;

/// The contract extends the lifetime of its instance and its code when less
/// than one day of that lifetime remains. A shorter threshold risks a lapse
/// between two redemptions on a quiet deployment. A longer threshold makes
/// almost every redemption pay for an extension.
const INSTANCE_TTL_THRESHOLD_LEDGERS: u32 = LEDGERS_PER_DAY;

/// The lifetime that an extension sets, which is 30 days. Testnet caps the
/// lifetime of one entry at 3,110,400 ledgers, about 180 days, so the network
/// accepts this value. Each extension costs rent. The contract extends only when
/// less than one day remains, so a contract with no redemption in that last day
/// lapses. An operator outside the contract must extend it.
const INSTANCE_TTL_EXTEND_TO_LEDGERS: u32 = 30 * LEDGERS_PER_DAY;

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Admin,
    Token,
    MaxAmount,
    MaxTtlLedgers,
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    AlreadyInitialized = 1,
    NotInitialized = 2,
    InvalidAmount = 3,
    AmountAboveCap = 4,
    InvalidLimits = 5,
    Expired = 6,
    TtlTooLong = 7,
}

/// The contract publishes this event for every successful redemption.
///
/// A Soroban transaction carries no memo, so this event is the only channel
/// that a merchant reconciles against. The `voucher_id` field is the merchant's
/// reference.
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Redeemed {
    #[topic]
    pub voucher_id: u64,
    pub payer: Address,
    pub recipient: Address,
    pub amount: i128,
    pub expire_at: u32,
}

#[contract]
pub struct SenetVoucher;

#[contractimpl]
impl SenetVoucher {
    /// Initialize the contract against the native asset contract of the
    /// network.
    ///
    /// The contract derives the address of that asset contract from the XDR of
    /// `Asset::Native`. The derivation is deterministic, so the address is
    /// correct on every network and no caller supplies it.
    pub fn init(
        env: Env,
        admin: Address,
        max_amount: i128,
        max_ttl_ledgers: u32,
    ) -> Result<(), Error> {
        let native = env
            .deployer()
            .with_stellar_asset(Bytes::from_array(&env, &NATIVE_ASSET_XDR))
            .deployed_address();
        Self::init_with_token(env, admin, native, max_amount, max_ttl_ledgers)
    }

    /// Initialize the contract against an explicit token contract.
    ///
    /// The test host deploys no native asset contract, so the unit tests point
    /// this function at a mock token. A deployment for an asset other than XLM
    /// also uses it. Both constructors run one time only.
    pub fn init_with_token(
        env: Env,
        admin: Address,
        token: Address,
        max_amount: i128,
        max_ttl_ledgers: u32,
    ) -> Result<(), Error> {
        let storage = env.storage().instance();
        if storage.has(&DataKey::Admin) {
            return Err(Error::AlreadyInitialized);
        }
        if max_amount <= 0 || max_ttl_ledgers == 0 {
            return Err(Error::InvalidLimits);
        }
        storage.set(&DataKey::Admin, &admin);
        storage.set(&DataKey::Token, &token);
        storage.set(&DataKey::MaxAmount, &max_amount);
        storage.set(&DataKey::MaxTtlLedgers, &max_ttl_ledgers);
        Ok(())
    }

    /// Redeem a voucher.
    ///
    /// The payer authorizes `amount`, `voucher_id` and `expire_at` only. The
    /// party that assembles the transaction selects `recipient`, and the
    /// signature does not cover that argument.
    ///
    /// `expire_at` is a ledger sequence inside the signed payload, so the
    /// contract reads it and enforces it. The host keeps a second deadline in
    /// the field `signature_expiration_ledger`, which contract code cannot
    /// read. The effective lifetime is the smaller of the two deadlines. The
    /// client derives both deadlines from one calculation.
    ///
    /// The `max_ttl_ledgers` cap guards against a wrong ledger estimate on the
    /// payer's device, not against a hostile payer. A device that stays offline
    /// for a long time estimates the current ledger, and the estimate can
    /// overshoot. The true ledger is known at redemption, so the contract
    /// catches an overshoot here.
    pub fn redeem(
        env: Env,
        payer: Address,
        amount: i128,
        voucher_id: u64,
        expire_at: u32,
        recipient: Address,
    ) -> Result<(), Error> {
        // The recipient is absent from the signed argument set. This omission
        // is the mechanism of the whole contract.
        let signed_args: Vec<Val> = (amount, voucher_id, expire_at).into_val(&env);
        payer.require_auth_for_args(signed_args);

        if amount <= 0 {
            return Err(Error::InvalidAmount);
        }
        let storage = env.storage().instance();
        let max_amount: i128 = storage.get(&DataKey::MaxAmount).ok_or(Error::NotInitialized)?;
        if amount > max_amount {
            return Err(Error::AmountAboveCap);
        }

        let seq = env.ledger().sequence();
        if seq > expire_at {
            return Err(Error::Expired);
        }
        let max_ttl: u32 = storage
            .get(&DataKey::MaxTtlLedgers)
            .ok_or(Error::NotInitialized)?;
        // The check above proves that `expire_at` is not below `seq`, so this
        // subtraction does not underflow.
        if expire_at - seq > max_ttl {
            return Err(Error::TtlTooLong);
        }
        let token_address: Address = storage.get(&DataKey::Token).ok_or(Error::NotInitialized)?;
        storage.extend_ttl(
            INSTANCE_TTL_THRESHOLD_LEDGERS,
            INSTANCE_TTL_EXTEND_TO_LEDGERS,
        );

        let contract = env.current_contract_address();
        let client = token::TokenClient::new(&env, &token_address);

        // The payer pays the contract. This transfer needs the payer's
        // authorization, so it is the single sub-invocation in the signed tree.
        // The destination is the contract address, which the payer knows at the
        // moment of the signature.
        client.transfer(&payer, &contract, &amount);

        // The contract pays the recipient. The contract is the direct caller,
        // so this transfer needs no signature and the recipient is free.
        client.transfer(&contract, &recipient, &amount);

        Redeemed {
            voucher_id,
            payer,
            recipient,
            amount,
            expire_at,
        }
        .publish(&env);
        Ok(())
    }

    /// Change the caps. Only the admin calls this function.
    ///
    /// A lower cap applies to every voucher that a party redeems after the
    /// change, which includes a voucher that a payer signed before it. Such a
    /// voucher fails with `AmountAboveCap` or `TtlTooLong`.
    pub fn set_limits(env: Env, max_amount: i128, max_ttl_ledgers: u32) -> Result<(), Error> {
        let storage = env.storage().instance();
        let admin: Address = storage.get(&DataKey::Admin).ok_or(Error::NotInitialized)?;
        admin.require_auth();
        if max_amount <= 0 || max_ttl_ledgers == 0 {
            return Err(Error::InvalidLimits);
        }
        storage.set(&DataKey::MaxAmount, &max_amount);
        storage.set(&DataKey::MaxTtlLedgers, &max_ttl_ledgers);
        Ok(())
    }

    pub fn limits(env: Env) -> Result<(i128, u32), Error> {
        let storage = env.storage().instance();
        Ok((
            storage.get(&DataKey::MaxAmount).ok_or(Error::NotInitialized)?,
            storage
                .get(&DataKey::MaxTtlLedgers)
                .ok_or(Error::NotInitialized)?,
        ))
    }

    pub fn admin(env: Env) -> Result<Address, Error> {
        env.storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(Error::NotInitialized)
    }

    pub fn token(env: Env) -> Result<Address, Error> {
        env.storage()
            .instance()
            .get(&DataKey::Token)
            .ok_or(Error::NotInitialized)
    }
}

#[cfg(test)]
mod test;
