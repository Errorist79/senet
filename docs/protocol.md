# Senet voucher protocol

Senet transfers native XLM on Stellar testnet. A payer signs one authorization entry before the recipient is known.
The recipient can be any address that the submitter selects. The fee-payer service submits the transaction and pays its network fee.

The entry is a bearer instrument. Anyone with a copy can redeem it while it remains valid and unspent.
The payer needs the amount at redemption. Voucher creation does not reserve funds.

## Configuration

A reader needs these values before it accepts a voucher:

- The network passphrase.
- The voucher contract address.
- The token contract address.

The testnet passphrase is `Test SDF Network ; September 2015`.
The native token address comes from `Asset.native().contractId(network)` in the pinned SDK.
The [configuration module](../packages/core/src/config.ts) supplies the deployment defaults.
The service exposes its configuration at `GET /api/config`.

## Authorization entry

The body is the XDR serialization of one `SorobanAuthorizationEntry`.
It contains `credentials` and `rootInvocation`.
The project pins `@stellar/stellar-sdk` to `16.3.0`.

The credential arm must be `SOROBAN_CREDENTIALS_ADDRESS_V2`, with discriminant `2`.
Its `SorobanAddressCredentials` contains these fields:

| Field | XDR type | Meaning |
|---|---|---|
| `address` | `SCAddress` | The payer address. |
| `nonce` | `int64` | A nonce for this payer and entry. |
| `signatureExpirationLedger` | `uint32` | The host deadline. It equals `expire_at`. |
| `signature` | `SCVal` | The signature representation that the payer account accepts. |

An unsigned entry uses `SCV_VOID` for `signature`.
An ed25519 signer and a passkey account use different signature representations.
A reader preserves this field. It does not convert the signature to text or require one fixed entry size.

Both nodes in the authorized tree use the contract-function arm of `SorobanAuthorizedFunction`.
Each node contains a contract address, a function name and an ordered vector of `SCVal` arguments.
The complete tree is:

```text
voucher contract: redeem
  arguments:
    amount       SCV_I128
    voucher_id   SCV_U64
    expire_at    SCV_U32
  subInvocations: exactly one
    token contract: transfer
      arguments:
        payer             SCV_ADDRESS
        voucher contract  SCV_ADDRESS
        amount            SCV_I128
      subInvocations: empty
```

The amount in both nodes is the same integer.
One XLM is 10,000,000 stroops.
The voucher identifier is an unsigned 64-bit value, so a reader must preserve integers above JavaScript's safe integer range.
The nonce is a signed 64-bit value. The identifier and nonce have different purposes.

The actual contract call has five arguments:

```text
redeem(
  payer: Address,
  amount: i128,
  voucher_id: u64,
  expire_at: u32,
  recipient: Address
)
```

The contract calls `payer.require_auth_for_args` with only `(amount, voucher_id, expire_at)`.
The recipient appears in neither node of the payer's authorized tree.
The contract transfers the amount from the payer to itself, then from itself to the recipient in the same call.
The second transfer needs no payer authorization because the voucher contract directly calls the token contract with its own funds.

The [contract](../contracts/senet-voucher/src/lib.rs) and [entry builder](../packages/core/src/voucher.ts) define this tree.
The standard Stellar XDR representation applies, including its integer widths, union tags and four-byte alignment.
The [pinned SDK XDR definitions](https://github.com/stellar/js-stellar-sdk/blob/v16.3.0/src/base/generated/curr_generated.js) define the wire types.

## What the signature binds

`ADDRESS_V2` uses `ENVELOPE_TYPE_SOROBAN_AUTHORIZATION_WITH_ADDRESS`, with discriminant `10`.
The XDR preimage contains these fields in order:

1. The envelope discriminant.
2. The full 32-byte network ID, which is SHA-256 of the UTF-8 network passphrase.
3. The nonce.
4. The signature expiration ledger.
5. The payer address.
6. The complete authorized invocation tree.

The SDK hashes that XDR preimage with SHA-256 for authorization.
The account's signature scheme authenticates that value.
Neither the transaction source nor the fee payer is part of this authorization preimage.
The recipient is absent because it is outside the authorized tree.

[CAP-71](https://github.com/stellar/stellar-protocol/blob/master/core/cap-0071.md) defines the address-bound preimage.
The [SDK authorization code](https://github.com/stellar/js-stellar-sdk/blob/v16.3.0/src/base/auth.ts) constructs it.
Legacy `ADDRESS` credentials omit the payer address from that preimage. Senet rejects them.

## QR payload

The QR symbol carries raw bytes in Byte mode. It carries neither a URI nor a base64 string.

| Byte offset | Length | Value |
|---|---|---|
| `0` | 1 byte | Payload version `0x01`. |
| `1` | 4 bytes | The first four bytes of SHA-256 of the UTF-8 network passphrase. |
| `5` | All remaining bytes | The signed authorization entry as XDR. |

The complete testnet prefix is `01 ce e0 30 2d`.
The four network bytes are raw digest bytes in their original order. They are not hexadecimal text.
The payload must contain more than five bytes.

The prefix is a property of the payload only. It changes no byte of the signed entry.
The prefix is not a separate signed field.
Its short network tag provides an early mismatch check. The full network ID in the authorization preimage provides the signature binding.

The application uses error correction level M and selects the smallest QR version that fits.
A 792-byte entry produces a 797-byte payload and a version-23 symbol.
A 900-byte entry produces a 905-byte payload and a version-24 symbol.
The [QR tests](../packages/core/test/qr.test.ts) cover both sizes. A reader must not require version 23.

## Reader procedure

1. Obtain the raw bytes from the symbol.
2. Reject a payload that contains five bytes or fewer.
3. Reject any version byte other than `0x01`.
4. Compare bytes 1 through 4 with the configured network tag.
5. Decode all remaining bytes as one `SorobanAuthorizationEntry`.
6. Require `ADDRESS_V2` credentials and the address-bound authorization preimage.
7. Require a root contract call to `redeem` on the configured voucher contract.
8. Read the three root arguments in their declared order.
9. Require the contract deadline and host deadline to be equal.
10. Obtain the current ledger before an offer to the merchant.
11. Require at least six ledgers before the deadline.
12. Preserve the entry for submission.

The [payload reader](../packages/core/src/payload.ts) converts malformed XDR into `VoucherFormatError`.
Other early refusals include `PayloadVersionError`, `NetworkMismatchError`, `CredentialTypeError` and `DeadlineMismatchError`.

The current reader checks the root argument count and converts the numeric values to whole numbers.
It does not fully validate the signed subtree or require every numeric `SCVal` tag shown above.
It does not check the signature, balance, nonce availability or current contract caps.
Those checks require enforcing simulation and execution on chain.
A successful decode alone is not a payment authorization verdict.

## Lifetime

The payer application caches a ledger sequence and the local time when it observes that sequence.
It computes the deadline as follows:

```text
elapsed_seconds = (current_local_time_ms - cached_local_time_ms) / 1000
estimated_ledger = cached_ledger + floor(elapsed_seconds / 5.007) + 0
expire_at = estimated_ledger + lifetime_ledgers
signatureExpirationLedger = expire_at
```

The divisor is an estimate. It is not a guarantee of the next ledger's close time.
A wrong clock or an old observation can put the estimate ahead of or behind the current ledger.
The formula has no positive margin and no clock correction.

The application offers these approximate wall-clock lifetimes:

| Choice | Ledgers |
|---|---:|
| 5 minutes | 60 |
| 15 minutes, default | 180 |
| 1 hour | 720 |
| 12 hours | 8,640 |

The contract uses the current ledger at redemption, not the estimated ledger at creation.
It rejects `expire_at < current_ledger` with `Expired`, code `6`.
It rejects `expire_at - current_ledger > max_ttl_ledgers` with `TtlTooLong`, code `7`.
The contract accepts equality at either boundary.
The merchant's six-ledger requirement is stricter than the contract's expiry boundary.

The application cap is 8,640 ledgers. The amount cap is 1,000,000,000 stroops, or 100 XLM.
The admin can change the contract's stored caps through `set_limits`.
The service compares both caps with its constants at startup. It does not continuously track later admin changes.

The client computes one deadline and uses it in both fields.
`signVoucher` checks their equality after the signer returns. `readVoucher` checks it again.
Contract code cannot read `signatureExpirationLedger`, so the contract cannot enforce this equality.
The host enforces its own expiration rules independently.

On 2026-09-22, testnet reports `maxEntryTTL` of 3,110,400 ledgers, approximately 180 days at five seconds per ledger.
The host's maximum signature deadline is the current ledger plus that TTL minus one.
It rejects a later deadline. It does not reduce the deadline to that ceiling.
This network ceiling is separate from the contract's much shorter cap.
The [host authorization source](https://docs.rs/crate/soroban-env-host/27.0.1/source/src/auth.rs) contains the expiration checks.

## Redemption, void and confirmation

The merchant sends the entry as base64 XDR with a recipient to `POST /api/redeem`.
This HTTP representation omits the QR prefix. The service obtains the payment terms from the entry.
It constructs the five-argument call, attaches the entry, simulates with authorization, then submits through a channel account.

The network consumes the authorization nonce on a successful redemption.
The contract stores no state for an individual voucher.
`voucher_id` is an event reference, not a replay key. A fresh valid nonce can authorize another payment with the same identifier.

To void a voucher, submit the same entry with the payer as recipient.
The two transfers return the amount to the payer and consume the nonce.
The fee-payer service still pays a network fee.
A void needs sufficient funds, a valid entry and network access. A copier can win the race before the void succeeds.

A successful call emits one `Redeemed` event.
Its topic includes `voucher_id`. Its fields include the payer, recipient, amount and `expire_at`.
The event feed confirms the recipient that actually received the funds.
The [security note](security.md) describes the trust limits and tests.
