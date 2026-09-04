#![cfg(test)]
extern crate std;

use super::*;
use ed25519_dalek::{Signer, SigningKey};
use soroban_sdk::testutils::{
    Address as _, AuthorizedFunction, AuthorizedInvocation, Events as _, Ledger, MockAuth,
    MockAuthInvoke,
};
use soroban_sdk::xdr::{
    HashIdPreimage, HashIdPreimageSorobanAuthorization, InvokeContractArgs, Limits, ScAddress,
    ScBytes, ScSymbol, ScVal, SorobanAddressCredentials, SorobanAuthorizationEntry,
    SorobanAuthorizedFunction, SorobanAuthorizedInvocation, SorobanCredentials, WriteXdr,
};
use soroban_sdk::{token, Address, Bytes, Env, Event as _, IntoVal, TryFromVal, Vec};

const MAX_AMOUNT: i128 = 1_000_000_000; // 100 XLM at seven decimals.
const MAX_TTL: u32 = 8_640;
const SEQ: u32 = 1_000; // setup() sets this sequence number.
const EXP_OK: u32 = 1_200; // In the future and inside the cap.

/// The lifetimes that the application offers, in ledgers of about five seconds.
/// They are 5 minutes, 15 minutes as the default, 1 hour, and 12 hours. The
/// last one equals the cap of the contract.
const LIFETIME_5M: u32 = 60;
const LIFETIME_15M: u32 = 180;
const LIFETIME_1H: u32 = 720;
const LIFETIME_12H: u32 = 8_640;

struct Fixture {
    env: Env,
    admin: Address,
    contract_id: Address,
    token_id: Address,
    token: token::TokenClient<'static>,
    client: SenetVoucherClient<'static>,
}

fn setup() -> Fixture {
    let env = Env::default();
    env.ledger().set_sequence_number(SEQ);
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let sac = env.register_stellar_asset_contract_v2(admin.clone());
    let token_id = sac.address();

    let contract_id = env.register(SenetVoucher, ());
    let client = SenetVoucherClient::new(&env, &contract_id);
    client.init_with_token(&admin, &token_id, &MAX_AMOUNT, &MAX_TTL);

    Fixture {
        token: token::TokenClient::new(&env, &token_id),
        client,
        env,
        admin,
        contract_id,
        token_id,
    }
}

fn fund(f: &Fixture, who: &Address, amount: i128) {
    f.env.mock_all_auths();
    token::StellarAssetClient::new(&f.env, &f.token_id).mint(who, &amount);
}

// Fast cases, with a mock that stands in for the payer's signature.

#[test]
fn redeem_pays_a_recipient_the_signer_never_saw() {
    let f = setup();
    let payer = Address::generate(&f.env);
    let recipient = Address::generate(&f.env);
    fund(&f, &payer, 500_000_000);

    // The mock authorizes amount, voucher_id and expire_at only. The submitter
    // supplies the recipient later.
    f.env.mock_auths(&[MockAuth {
        address: &payer,
        invoke: &MockAuthInvoke {
            contract: &f.contract_id,
            fn_name: "redeem",
            args: (100_000_000i128, 7u64, EXP_OK).into_val(&f.env),
            sub_invokes: &[MockAuthInvoke {
                contract: &f.token_id,
                fn_name: "transfer",
                args: (payer.clone(), f.contract_id.clone(), 100_000_000i128).into_val(&f.env),
                sub_invokes: &[],
            }],
        },
    }]);

    f.client.redeem(&payer, &100_000_000, &7, &EXP_OK, &recipient);

    assert_eq!(f.token.balance(&recipient), 100_000_000);
    assert_eq!(f.token.balance(&payer), 400_000_000);
    assert_eq!(f.token.balance(&f.contract_id), 0);
}

#[test]
fn void_returns_the_amount_to_the_payer() {
    let f = setup();
    let payer = Address::generate(&f.env);
    fund(&f, &payer, 500_000_000);
    f.env.mock_all_auths();

    // The recipient equals the payer. The network consumes the nonce and the
    // balance does not change.
    f.client.redeem(&payer, &100_000_000, &9, &EXP_OK, &payer);
    assert_eq!(f.token.balance(&payer), 500_000_000);
}

#[test]
fn amount_over_cap_is_rejected() {
    let f = setup();
    let payer = Address::generate(&f.env);
    let recipient = Address::generate(&f.env);
    fund(&f, &payer, 5_000_000_000);
    f.env.mock_all_auths();

    let err = f
        .client
        .try_redeem(&payer, &(MAX_AMOUNT + 1), &1, &EXP_OK, &recipient)
        .unwrap_err()
        .unwrap();
    assert_eq!(err, Error::AmountAboveCap);
}

#[test]
fn non_positive_amount_is_rejected() {
    let f = setup();
    let payer = Address::generate(&f.env);
    let recipient = Address::generate(&f.env);
    f.env.mock_all_auths();

    for amount in [0i128, -1i128] {
        let err = f
            .client
            .try_redeem(&payer, &amount, &1, &EXP_OK, &recipient)
            .unwrap_err()
            .unwrap();
        assert_eq!(err, Error::InvalidAmount);
    }
}

#[test]
fn a_payer_without_the_balance_cannot_redeem() {
    let f = setup();
    let payer = Address::generate(&f.env);
    let recipient = Address::generate(&f.env);
    fund(&f, &payer, 10_000_000);
    f.env.mock_all_auths();

    let res = f
        .client
        .try_redeem(&payer, &100_000_000, &1, &EXP_OK, &recipient);
    assert!(res.is_err(), "a transfer above the balance must fail");
    assert_eq!(f.token.balance(&recipient), 0);
    assert_eq!(f.token.balance(&f.contract_id), 0);
}

#[test]
fn recipient_is_outside_the_signed_payload() {
    // One signature payload serves any recipient. This test reads the recorded
    // authorization tree and proves that the recipient is absent from it.
    let f = setup();
    let payer = Address::generate(&f.env);
    let r1 = Address::generate(&f.env);
    fund(&f, &payer, 500_000_000);
    f.env.mock_all_auths();
    f.client.redeem(&payer, &10_000_000, &1, &EXP_OK, &r1);

    let auths = f.env.auths();
    let (addr, invocation) = auths[0].clone();
    assert_eq!(addr, payer);
    let AuthorizedFunction::Contract((c, fname, args)) = invocation.function.clone() else {
        panic!("expected a contract function")
    };
    assert_eq!(c, f.contract_id);
    assert_eq!(fname, soroban_sdk::symbol_short!("redeem"));
    // Three arguments only: amount, voucher_id and expire_at. No recipient.
    assert_eq!(args.len(), 3);
    assert_eq!(
        args,
        (10_000_000i128, 1u64, EXP_OK).into_val(&f.env),
        "the signed arguments must be exactly amount, voucher_id and expire_at"
    );

    // The signed tree holds one sub-invocation. It moves the amount from the
    // payer to the contract, and to no other address.
    let recorded: AuthorizedInvocation = invocation;
    assert_eq!(recorded.sub_invocations.len(), 1);
    let AuthorizedFunction::Contract((sub_c, sub_fname, sub_args)) =
        recorded.sub_invocations[0].function.clone()
    else {
        panic!("expected a contract function")
    };
    assert_eq!(sub_c, f.token_id);
    assert_eq!(sub_fname, soroban_sdk::symbol_short!("transfer"));
    assert_eq!(
        sub_args,
        (payer.clone(), f.contract_id.clone(), 10_000_000i128).into_val(&f.env),
        "the signed transfer must move the amount from the payer to the contract"
    );
    assert_eq!(recorded.sub_invocations[0].sub_invocations.len(), 0);
}

/// The event is the only channel that a merchant reconciles against, because a
/// Soroban transaction carries no memo.
#[test]
fn redeem_publishes_one_event_for_the_merchant() {
    let f = setup();
    let payer = Address::generate(&f.env);
    let recipient = Address::generate(&f.env);
    fund(&f, &payer, 500_000_000);
    f.env.mock_all_auths();
    f.client
        .redeem(&payer, &10_000_000, &4242, &EXP_OK, &recipient);

    let expected = Redeemed {
        voucher_id: 4242,
        payer: payer.clone(),
        recipient: recipient.clone(),
        amount: 10_000_000,
        expire_at: EXP_OK,
    }
    .to_xdr(&f.env, &f.contract_id);

    let published = f.env.events().all().filter_by_contract(&f.contract_id);
    assert_eq!(published, [expected]);
}

// The rules that govern initialization.

#[test]
fn init_runs_only_once() {
    let f = setup();
    let other = Address::generate(&f.env);
    f.env.mock_all_auths();
    let err = f
        .client
        .try_init_with_token(&other, &f.token_id, &MAX_AMOUNT, &MAX_TTL)
        .unwrap_err()
        .unwrap();
    assert_eq!(err, Error::AlreadyInitialized);
    assert_eq!(f.client.admin(), f.admin);
}

#[test]
fn init_rejects_invalid_limits() {
    let f = setup();
    let fresh = f.env.register(SenetVoucher, ());
    let client = SenetVoucherClient::new(&f.env, &fresh);
    f.env.mock_all_auths();

    for (amount, ttl) in [(0i128, MAX_TTL), (-1i128, MAX_TTL), (MAX_AMOUNT, 0u32)] {
        let err = client
            .try_init_with_token(&f.admin, &f.token_id, &amount, &ttl)
            .unwrap_err()
            .unwrap();
        assert_eq!(err, Error::InvalidLimits);
    }
    // The refusals stored nothing, so a valid call still succeeds.
    client.init_with_token(&f.admin, &f.token_id, &MAX_AMOUNT, &MAX_TTL);
    assert_eq!(client.limits(), (MAX_AMOUNT, MAX_TTL));
}

#[test]
fn redeem_before_init_is_rejected() {
    let f = setup();
    let fresh = f.env.register(SenetVoucher, ());
    let client = SenetVoucherClient::new(&f.env, &fresh);
    let payer = Address::generate(&f.env);
    let recipient = Address::generate(&f.env);
    f.env.mock_all_auths();

    let err = client
        .try_redeem(&payer, &10_000_000, &1, &EXP_OK, &recipient)
        .unwrap_err()
        .unwrap();
    assert_eq!(err, Error::NotInitialized);
}

// The rules that govern the admin.

#[test]
fn the_admin_changes_the_limits() {
    let f = setup();
    f.env.mock_auths(&[MockAuth {
        address: &f.admin,
        invoke: &MockAuthInvoke {
            contract: &f.contract_id,
            fn_name: "set_limits",
            args: (2_000_000_000i128, 100u32).into_val(&f.env),
            sub_invokes: &[],
        },
    }]);
    f.client.set_limits(&2_000_000_000, &100);
    assert_eq!(f.client.limits(), (2_000_000_000i128, 100u32));
}

#[test]
fn a_non_admin_cannot_change_the_limits() {
    let f = setup();
    let stranger = Address::generate(&f.env);
    f.env.mock_auths(&[MockAuth {
        address: &stranger,
        invoke: &MockAuthInvoke {
            contract: &f.contract_id,
            fn_name: "set_limits",
            args: (2_000_000_000i128, 100u32).into_val(&f.env),
            sub_invokes: &[],
        },
    }]);
    let res = f.client.try_set_limits(&2_000_000_000, &100);
    assert!(res.is_err(), "only the admin may change the limits");
    assert_eq!(f.client.limits(), (MAX_AMOUNT, MAX_TTL));
}

#[test]
fn set_limits_rejects_invalid_limits() {
    let f = setup();
    f.env.mock_all_auths();
    for (amount, ttl) in [(0i128, 100u32), (-1i128, 100u32), (MAX_AMOUNT, 0u32)] {
        let err = f
            .client
            .try_set_limits(&amount, &ttl)
            .unwrap_err()
            .unwrap();
        assert_eq!(err, Error::InvalidLimits);
    }
    assert_eq!(f.client.limits(), (MAX_AMOUNT, MAX_TTL));
}

/// A lower cap applies to a voucher that the payer signed before the change.
/// The contract reads the caps at redemption, so such a voucher pays nothing.
/// A change of the caps therefore strands the vouchers that are in circulation,
/// for a period as long as the longest lifetime that the application offers.
#[test]
fn a_lower_cap_strands_a_voucher_already_in_circulation() {
    let f = setup();
    let payer = Address::generate(&f.env);
    let recipient = Address::generate(&f.env);
    fund(&f, &payer, 500_000_000);
    f.env.mock_all_auths();

    f.client.set_limits(&5_000_000, &60);

    let amount_err = f
        .client
        .try_redeem(&payer, &10_000_000, &1, &(SEQ + 30), &recipient)
        .unwrap_err()
        .unwrap();
    assert_eq!(amount_err, Error::AmountAboveCap);

    let ttl_err = f
        .client
        .try_redeem(&payer, &1_000_000, &2, &(SEQ + 61), &recipient)
        .unwrap_err()
        .unwrap();
    assert_eq!(ttl_err, Error::TtlTooLong);
}

// Expiry and the lifetime cap.

/// Every lifetime that the application offers must succeed. The list contains
/// the lifetime that sits exactly on the cap of the contract.
#[test]
fn all_offered_lifetimes_are_accepted() {
    for (i, lifetime) in [LIFETIME_5M, LIFETIME_15M, LIFETIME_1H, LIFETIME_12H]
        .into_iter()
        .enumerate()
    {
        let f = setup();
        let payer = Address::generate(&f.env);
        let recipient = Address::generate(&f.env);
        fund(&f, &payer, 500_000_000);
        f.env.mock_all_auths();
        f.client
            .redeem(&payer, &10_000_000, &(i as u64), &(SEQ + lifetime), &recipient);
        assert_eq!(
            f.token.balance(&recipient),
            10_000_000,
            "the contract must accept a lifetime of {} ledgers",
            lifetime
        );
    }
}

#[test]
fn expire_at_exactly_on_the_cap_is_accepted() {
    let f = setup();
    let payer = Address::generate(&f.env);
    let recipient = Address::generate(&f.env);
    fund(&f, &payer, 500_000_000);
    f.env.mock_all_auths();
    f.client
        .redeem(&payer, &10_000_000, &1, &(SEQ + MAX_TTL), &recipient);
    assert_eq!(f.token.balance(&recipient), 10_000_000);
}

#[test]
fn expire_at_one_past_the_cap_is_rejected() {
    let f = setup();
    let payer = Address::generate(&f.env);
    let recipient = Address::generate(&f.env);
    fund(&f, &payer, 500_000_000);
    f.env.mock_all_auths();
    let err = f
        .client
        .try_redeem(&payer, &10_000_000, &1, &(SEQ + MAX_TTL + 1), &recipient)
        .unwrap_err()
        .unwrap();
    assert_eq!(err, Error::TtlTooLong);
    assert_eq!(f.token.balance(&recipient), 0);
}

#[test]
fn expire_at_in_the_past_is_rejected() {
    let f = setup();
    let payer = Address::generate(&f.env);
    let recipient = Address::generate(&f.env);
    fund(&f, &payer, 500_000_000);
    f.env.mock_all_auths();
    let err = f
        .client
        .try_redeem(&payer, &10_000_000, &1, &(SEQ - 1), &recipient)
        .unwrap_err()
        .unwrap();
    assert_eq!(err, Error::Expired);
}

/// `expire_at` equal to the current sequence is the last ledger on which the
/// voucher is still good.
#[test]
fn expire_at_equal_to_current_ledger_is_still_valid() {
    let f = setup();
    let payer = Address::generate(&f.env);
    let recipient = Address::generate(&f.env);
    fund(&f, &payer, 500_000_000);
    f.env.mock_all_auths();
    f.client.redeem(&payer, &10_000_000, &1, &SEQ, &recipient);
    assert_eq!(f.token.balance(&recipient), 10_000_000);
}

/// The contract applies the cap while the signature of the payer is still
/// valid. This check catches an offline ledger estimate that overshoots.
#[test]
fn the_cap_applies_even_with_a_valid_host_signature() {
    let (f, signer) = real_fixture();
    let recipient = Address::generate(&f.env);
    let far = SEQ + MAX_TTL + 5_000;
    let entry = signed_entry(
        &f.env, &signer, &f.contract_id, &f.token_id, 100_000_000, 20, far, 9, 50_000,
    );
    f.env.set_auths(&[entry]);
    let res = f
        .client
        .try_redeem(&signer.address, &100_000_000, &20, &far, &recipient);
    assert_eq!(res.unwrap_err().unwrap(), Error::TtlTooLong);
    assert_eq!(f.token.balance(&recipient), 0);
}

// The path that uses a real signed entry.
//
// `set_auths` needs a signature that the host verifies. An address from
// `Address::generate` holds no key that the test controls, so the payer here is
// a small account contract. It checks one ed25519 key in `__check_auth`, which
// is the shape that a passkey smart account also has.

use soroban_sdk::auth::Context;
use soroban_sdk::{contract as sc_contract, contractimpl as sc_contractimpl, symbol_short, BytesN};

#[sc_contract]
pub struct TestAccount;

#[sc_contractimpl]
impl TestAccount {
    pub fn __constructor(env: Env, pk: BytesN<32>) {
        env.storage().instance().set(&symbol_short!("pk"), &pk);
    }

    #[allow(non_snake_case)]
    pub fn __check_auth(
        env: Env,
        signature_payload: BytesN<32>,
        signature: BytesN<64>,
        _contexts: Vec<Context>,
    ) {
        let pk: BytesN<32> = env.storage().instance().get(&symbol_short!("pk")).unwrap();
        env.crypto()
            .ed25519_verify(&pk, &signature_payload.into(), &signature);
    }
}

struct RealSigner {
    key: SigningKey,
    address: Address,
}

fn i128_parts(v: i128) -> soroban_sdk::xdr::Int128Parts {
    soroban_sdk::xdr::Int128Parts {
        hi: (v >> 64) as i64,
        lo: v as u64,
    }
}

fn scval_address(env: &Env, a: &Address) -> ScVal {
    ScVal::try_from_val(env, &a.to_val()).unwrap()
}

fn contract_hash(env: &Env, a: &Address) -> soroban_sdk::xdr::ContractId {
    match scval_address(env, a) {
        ScVal::Address(ScAddress::Contract(h)) => h,
        other => panic!("expected a contract address, got {:?}", other),
    }
}

fn make_signer(env: &Env, seed: u8) -> RealSigner {
    let key = SigningKey::from_bytes(&[seed; 32]);
    let pk = BytesN::from_array(env, &key.verifying_key().to_bytes());
    let address = env.register(TestAccount, (pk,));
    RealSigner { key, address }
}

/// Build the authorization tree that the contract demands, then sign it.
///
/// Root invocation: `redeem(amount, voucher_id, expire_at)`, with no recipient.
/// Sub-invocation: `<token>.transfer(payer, contract, amount)`.
fn signed_entry(
    env: &Env,
    signer: &RealSigner,
    contract_id: &Address,
    token_id: &Address,
    amount: i128,
    voucher_id: u64,
    expire_at: u32,
    nonce: i64,
    expiration: u32,
) -> SorobanAuthorizationEntry {
    let payer_sc = scval_address(env, &signer.address);
    let contract_sc = scval_address(env, contract_id);

    let invocation = SorobanAuthorizedInvocation {
        function: SorobanAuthorizedFunction::ContractFn(InvokeContractArgs {
            contract_address: ScAddress::Contract(contract_hash(env, contract_id)),
            function_name: ScSymbol("redeem".try_into().unwrap()),
            args: std::vec![
                ScVal::I128(i128_parts(amount)),
                ScVal::U64(voucher_id),
                ScVal::U32(expire_at)
            ]
            .try_into()
            .unwrap(),
        }),
        sub_invocations: std::vec![SorobanAuthorizedInvocation {
            function: SorobanAuthorizedFunction::ContractFn(InvokeContractArgs {
                contract_address: ScAddress::Contract(contract_hash(env, token_id)),
                function_name: ScSymbol("transfer".try_into().unwrap()),
                args: std::vec![payer_sc.clone(), contract_sc, ScVal::I128(i128_parts(amount))]
                    .try_into()
                    .unwrap(),
            }),
            sub_invocations: std::vec::Vec::new().try_into().unwrap(),
        }]
        .try_into()
        .unwrap(),
    };

    let network_id = env.ledger().network_id();
    let preimage = HashIdPreimage::SorobanAuthorization(HashIdPreimageSorobanAuthorization {
        network_id: soroban_sdk::xdr::Hash(network_id.into()),
        nonce,
        signature_expiration_ledger: expiration,
        invocation: invocation.clone(),
    });
    let payload = preimage.to_xdr(Limits::none()).unwrap();
    let digest: [u8; 32] = env
        .crypto()
        .sha256(&Bytes::from_slice(env, &payload))
        .to_bytes()
        .into();
    let sig = signer.key.sign(&digest).to_bytes();

    SorobanAuthorizationEntry {
        credentials: SorobanCredentials::Address(SorobanAddressCredentials {
            address: match payer_sc {
                ScVal::Address(a) => a,
                _ => unreachable!(),
            },
            nonce,
            signature_expiration_ledger: expiration,
            signature: ScVal::Bytes(ScBytes(sig.to_vec().try_into().unwrap())),
        }),
        root_invocation: invocation,
    }
}

fn real_fixture() -> (Fixture, RealSigner) {
    let f = setup();
    let signer = make_signer(&f.env, 42);
    fund(&f, &signer.address, 500_000_000);
    (f, signer)
}

#[test]
fn real_signature_redeems_to_a_late_bound_recipient() {
    let (f, signer) = real_fixture();
    let recipient = Address::generate(&f.env);
    let entry = signed_entry(
        &f.env, &signer, &f.contract_id, &f.token_id, 100_000_000, 11, EXP_OK, 1, 2_000,
    );
    f.env.set_auths(&[entry]);
    f.client
        .redeem(&signer.address, &100_000_000, &11, &EXP_OK, &recipient);
    assert_eq!(f.token.balance(&recipient), 100_000_000);
    assert_eq!(f.token.balance(&signer.address), 400_000_000);
}

#[test]
fn same_signed_entry_cannot_be_used_twice() {
    let (f, signer) = real_fixture();
    let r1 = Address::generate(&f.env);
    let r2 = Address::generate(&f.env);
    let entry = signed_entry(
        &f.env, &signer, &f.contract_id, &f.token_id, 100_000_000, 12, EXP_OK, 2, 2_000,
    );

    f.env.set_auths(&[entry.clone()]);
    f.client
        .redeem(&signer.address, &100_000_000, &12, &EXP_OK, &r1);
    assert_eq!(f.token.balance(&r1), 100_000_000);

    // The same bytes again. The network consumed the nonce.
    f.env.set_auths(&[entry]);
    let res = f
        .client
        .try_redeem(&signer.address, &100_000_000, &12, &EXP_OK, &r2);
    assert!(res.is_err(), "a replay of a consumed entry must fail");
    assert_eq!(f.token.balance(&r2), 0);
}

/// The contract stores nothing for a voucher, so `voucher_id` alone prevents
/// nothing. A second entry that carries the same identifier and a fresh nonce
/// pays again. Single use comes from the nonce, and the identifier only serves
/// the merchant's reconciliation.
#[test]
fn the_same_voucher_id_pays_again_under_a_fresh_nonce() {
    let (f, signer) = real_fixture();
    let r1 = Address::generate(&f.env);
    let r2 = Address::generate(&f.env);

    let first = signed_entry(
        &f.env, &signer, &f.contract_id, &f.token_id, 100_000_000, 30, EXP_OK, 60, 2_000,
    );
    f.env.set_auths(&[first]);
    f.client
        .redeem(&signer.address, &100_000_000, &30, &EXP_OK, &r1);

    let second = signed_entry(
        &f.env, &signer, &f.contract_id, &f.token_id, 100_000_000, 30, EXP_OK, 61, 2_000,
    );
    f.env.set_auths(&[second]);
    f.client
        .redeem(&signer.address, &100_000_000, &30, &EXP_OK, &r2);

    assert_eq!(f.token.balance(&r1), 100_000_000);
    assert_eq!(f.token.balance(&r2), 100_000_000);
}

#[test]
fn expired_signature_is_rejected() {
    let (f, signer) = real_fixture();
    let recipient = Address::generate(&f.env);
    // The current sequence is 1,000 and this entry expired at 999.
    let entry = signed_entry(
        &f.env, &signer, &f.contract_id, &f.token_id, 100_000_000, 13, EXP_OK, 3, 999,
    );
    f.env.set_auths(&[entry]);
    let res = f
        .client
        .try_redeem(&signer.address, &100_000_000, &13, &EXP_OK, &recipient);
    assert!(res.is_err(), "an expired entry must fail");
    assert_eq!(f.token.balance(&recipient), 0);
}

#[test]
fn void_with_a_real_signature_consumes_the_nonce() {
    let (f, signer) = real_fixture();
    let merchant = Address::generate(&f.env);
    let entry = signed_entry(
        &f.env, &signer, &f.contract_id, &f.token_id, 100_000_000, 14, EXP_OK, 4, 2_000,
    );

    // The payer voids the voucher and redeems it to self. The balance does not
    // change and the network consumes the nonce.
    f.env.set_auths(&[entry.clone()]);
    f.client
        .redeem(&signer.address, &100_000_000, &14, &EXP_OK, &signer.address);
    assert_eq!(f.token.balance(&signer.address), 500_000_000);

    // The merchant now holds a voucher that pays nothing.
    f.env.set_auths(&[entry]);
    let res = f
        .client
        .try_redeem(&signer.address, &100_000_000, &14, &EXP_OK, &merchant);
    assert!(res.is_err(), "a voided voucher must not pay");
    assert_eq!(f.token.balance(&merchant), 0);
}

#[test]
fn signed_amount_cannot_be_changed_by_the_submitter() {
    let (f, signer) = real_fixture();
    let recipient = Address::generate(&f.env);
    let entry = signed_entry(
        &f.env, &signer, &f.contract_id, &f.token_id, 100_000_000, 15, EXP_OK, 5, 2_000,
    );
    f.env.set_auths(&[entry]);
    // The submitter asks for 20 XLM against a signature for 10 XLM.
    let res = f
        .client
        .try_redeem(&signer.address, &200_000_000, &15, &EXP_OK, &recipient);
    assert!(res.is_err(), "the amount is signed and must not change");
}

/// `expire_at` sits inside the signed payload, so the submitter cannot extend
/// the life of the voucher.
#[test]
fn submitter_cannot_change_expire_at() {
    let (f, signer) = real_fixture();
    let recipient = Address::generate(&f.env);
    let entry = signed_entry(
        &f.env, &signer, &f.contract_id, &f.token_id, 100_000_000, 21, EXP_OK, 10, 50_000,
    );
    f.env.set_auths(&[entry]);
    let res = f
        .client
        .try_redeem(&signer.address, &100_000_000, &21, &(EXP_OK + 1), &recipient);
    assert!(res.is_err(), "expire_at is signed and must not change");
}

/// The merchant reconciles on `voucher_id`, so a submitter who changes it
/// breaks that reference. The signature covers it.
#[test]
fn submitter_cannot_change_the_voucher_id() {
    let (f, signer) = real_fixture();
    let recipient = Address::generate(&f.env);
    let entry = signed_entry(
        &f.env, &signer, &f.contract_id, &f.token_id, 100_000_000, 22, EXP_OK, 11, 2_000,
    );
    f.env.set_auths(&[entry]);
    let res = f
        .client
        .try_redeem(&signer.address, &100_000_000, &23, &EXP_OK, &recipient);
    assert!(res.is_err(), "voucher_id is signed and must not change");
}

/// The credentials name the payer, so a submitter cannot charge a third party
/// with an entry that another account signed.
#[test]
fn submitter_cannot_change_the_payer() {
    let (f, signer) = real_fixture();
    let victim = make_signer(&f.env, 43);
    fund(&f, &victim.address, 500_000_000);
    let recipient = Address::generate(&f.env);
    let entry = signed_entry(
        &f.env, &signer, &f.contract_id, &f.token_id, 100_000_000, 24, EXP_OK, 12, 2_000,
    );
    f.env.set_auths(&[entry]);
    let res = f
        .client
        .try_redeem(&victim.address, &100_000_000, &24, &EXP_OK, &recipient);
    assert!(res.is_err(), "the entry authorizes its own payer only");
    assert_eq!(f.token.balance(&victim.address), 500_000_000);
    assert_eq!(f.token.balance(&recipient), 0);
}

/// A budget measurement on the local test host. The network reports no memory
/// figure, because RPC dropped `cost` from `simulateTransaction` and the
/// transaction meta never carried it. This number comes from the test host and
/// from a mock token contract. It is not an on-chain measurement.
#[test]
fn budget_estimate_for_redeem() {
    let f = setup();
    let payer = Address::generate(&f.env);
    let recipient = Address::generate(&f.env);
    fund(&f, &payer, 500_000_000);
    f.env.mock_all_auths();
    f.env.cost_estimate().budget().reset_default();
    f.client
        .redeem(&payer, &100_000_000, &42, &EXP_OK, &recipient);
    let b = f.env.cost_estimate().budget();
    std::println!(
        "BUDGET cpu_instructions={} memory_bytes={}",
        b.cpu_instruction_cost(),
        b.memory_bytes_cost()
    );
}
