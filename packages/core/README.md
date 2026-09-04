# @senet/core

The voucher library. It builds, signs and reads the detached authorization
entry that a payer produces offline.

The library makes no network request. It knows nothing about the application
that uses it. It depends only on `@stellar/stellar-sdk`.

## The model

A payer signs one `SorobanAuthorizationEntry`. The entry authorizes an amount,
a voucher identifier and a deadline. The entry does not name a recipient. The
party that scans the code chooses the recipient and submits the transaction.

A voucher is bytes first. The QR code is one presentation of those bytes. This
library gives the bytes, and the application draws them.

## Configuration

Every function takes a `VoucherConfig` as its first argument. The type holds
three values:

- `network`, the network passphrase;
- `contractId`, the voucher contract;
- `tokenId`, the token contract that moves the funds.

`TESTNET_CONFIG` holds the testnet values. `nativeTokenId(network)` derives the
native asset's contract address for any network. `TESTNET_CONTRACT_ID` is the
one place that names the deployed testnet contract, and a redeploy changes it
here.

## Types

| Name | What it holds |
|---|---|
| `Voucher` | `payer`, `amount`, `voucherId`, `expireAt` |
| `DecodedVoucher` | a `Voucher`, plus `contractId`, `nonce`, `signatureExpirationLedger` and the entry |
| `VoucherConfig` | `network`, `contractId`, `tokenId` |
| `SignEntry` | `(entry, validUntilLedgerSeq) => Promise<entry>` |
| `LifetimeName` | one key of `LIFETIMES` |

## Functions

**Construction and signature**

- `buildVoucherEntry(config, voucher, nonce)` returns an unsigned entry.
- `signVoucher(config, voucher, nonce, signEntry)` builds one entry, signs it,
  and checks both invariants. This is the path that an application takes.
- `ed25519Signer(config, secret)` returns a `SignEntry` for an account that
  holds an ed25519 secret key. It is the one signer that the library ships. An
  application that uses a passkey account supplies its own signer of the same
  type.
- `redeemArgs(voucher, recipient)` returns the five arguments of a `redeem`
  call, and the recipient is the last one.
- `redeemInvocation(config, voucher)` returns the invocation tree that the
  signature covers.
- `randomNonce()` and `randomVoucherId()` draw from the platform random number
  generator.

**Reading**

- `readVoucher(config, entry)` returns a `DecodedVoucher`. It checks the shape
  of the entry, and it runs both invariants. No caller can read an entry and
  skip them.

**Ledger estimation**

- `estimateLedger(lastSeenLedger, elapsedSeconds)` counts forward from the last
  ledger that the device saw.
- `offlineExpireAt(lastSeenLedger, elapsedSeconds, lifetimeLedgers)` returns the
  `expire_at` of a voucher that a device mints offline.
- `assertLifetime(lifetimeLedgers)` refuses a lifetime that the contract will
  not accept.
- `LIFETIMES` holds the lifetimes that an application offers, in ledgers.

**Invariants**

- `assertSdkVersion(version)` refuses an SDK release that this code cannot
  read.
- `assertAddressV2(config, entry)` refuses an entry that is not address bound.
- `assertDeadlinesAligned(entry, expireAt)` refuses an entry whose two
  deadlines disagree.
- `credentialDiscriminant(entry)`, `addressCredentials(entry)` and
  `authEnvelopeType(entry, network)` read the fields that the two assertions
  judge.

## Errors

A consumer branches on a class, never on a message. Every class extends
`VoucherError`, and every class carries the values that produced the failure.

| Class | When the library raises it |
|---|---|
| `VoucherFormatError` | the entry does not hold a voucher of the expected shape |
| `PayloadVersionError` | the payload starts with a version byte that this reader does not know |
| `NetworkMismatchError` | the payload names another network |
| `CredentialTypeError` | the credentials are not CAP-71 address bound |
| `DeadlineMismatchError` | `expire_at` and `signature_expiration_ledger` differ |
| `ExpiryWindowError` | the lifetime falls outside the window that the contract accepts |
| `SdkVersionError` | the installed `@stellar/stellar-sdk` is the wrong release |

## The two invariants

**The credentials must be CAP-71 `ADDRESS_V2`.** A legacy `ADDRESS` credential
signs a preimage that omits the address which authorizes the call. One
signature then serves every address. `assertAddressV2` checks the credential
arm and the envelope type, because a future SDK release could keep one and
change the other.

**The two deadlines must hold one value.** `expire_at` is a contract argument
and `signature_expiration_ledger` is a host field. Both bound the voucher, and
the effective lifetime is the smaller of the two. Contract code cannot read the
host field, so the contract cannot refuse a voucher that the host field
truncates. `signVoucher` gives one computed value to both fields, and
`assertDeadlinesAligned` catches a signer that moves one of them.

## The payload format

A voucher payload carries a prefix, then the entry:

| Offset | Width | Field |
|---|---|---|
| 0 | 1 byte | the payload version, `PAYLOAD_VERSION` |
| 1 | 4 bytes | the network identifier |
| 5 | rest | the signed entry, as XDR |

The network identifier is the first four bytes of the network id. The network
id is the SHA-256 hash of the network passphrase. A transaction signature
preimage carries the same value. `networkId(network)` returns the
whole hash and `networkTag(network)` returns the identifier as hex. On testnet
the identifier is `cee0302d`.

The prefix exists for two reasons:

- A reader that meets an unknown version stops at the first byte. The reader
  then names the version that it found. A later format therefore ships without
  a break for every reader in the field.
- A reader that meets another network's identifier refuses the voucher at scan
  time. The payer sees a clear message instead of a failure on chain.

Four bytes is the width, for three reasons:

- The set of named Stellar networks is small. A person can therefore enumerate
  the identifiers and check that no two collide.
- The identifier is a check at scan time, not a security boundary. The signed
  preimage already carries the whole network passphrase. A voucher that reaches
  the wrong network fails on chain, even after a collision.
- The width costs almost nothing. A signed entry from a passkey account
  measures 792 bytes. At error correction level M, a QR symbol of version 23
  holds 857 bytes. The five byte prefix brings the payload to 797 bytes, and
  the symbol stays at version 23.

The prefix wraps the entry and never changes it. The bytes of the signed entry
stay identical to the bytes that simulation produces, because that identity is
recorded evidence.

`encodeVoucher` and `decodeVoucher` arrive with the scanner.

## Build and test

```
npm run build --workspace @senet/core
npm test --workspace @senet/core
```

The test suite includes a reference test. It reads
`test/fixtures/reference-entry.json`, which records the entry that an earlier
voucher module built for one fixed input. The test builds the same entry with
this library and compares the XDR bytes. The two must be equal.
