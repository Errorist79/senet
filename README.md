# Senet

Senet is a payer-presented QR payment system on Stellar, for testnet only.

Every QR payment on Stellar today runs one way: the payee presents the code and
the payer scans it. Senet runs the other way. The payer signs one Soroban
authorization entry, and that entry authorizes an amount, a voucher identifier
and an expiry. The entry does not name a recipient. The party that scans the
code sets the recipient and submits the transaction.

## How the mechanism works

The contract exposes one payment entry point:

```
redeem(payer, amount, voucher_id, expire_at, recipient)
```

The contract calls `require_auth_for_args` on the payer with `amount`,
`voucher_id` and `expire_at`. The `recipient` argument stays outside the signed
set, so the party that scans the code selects it after the payer signs.

The contract then moves the amount two times in one call:

1. from the payer to the contract, through the native asset contract;
2. from the contract to the recipient.

The second transfer needs no signature, because the contract is the caller.

The contract keeps no state for a voucher. The network consumes the nonce of
the authorization entry, so one signed entry pays one time. A payer voids a
voucher when the payer redeems it to their own address. That call consumes the
nonce, and the contract needs no separate function for it.

Two values bound the life of a voucher, and the client derives both from one
calculation:

- `expire_at`, which the contract checks against the current ledger and against
  a cap that the admin of the contract sets;
- the field `signature_expiration_ledger` of the entry, which the network
  enforces and the contract cannot read.

## Layout

| Path | Contents |
|---|---|
| `contracts/senet-voucher/` | The voucher contract, in Rust. |
| `packages/core/` | The library that builds, signs, encodes and decodes a voucher. |
| `scripts/` | The evidence commands. |
| `scripts/out/evidence/` | The archived proof of every cited transaction. |
| `.github/workflows/ci.yml` | The build and the test suites. |

## Versions

| Component | Version |
|---|---|
| Stellar network | Testnet, protocol 28 |
| Rust | 1.96.0, target `wasm32v1-none` |
| `soroban-sdk` | 27.0.6 |
| `stellar-cli` | 28.0.0 |
| Node | 22 |

Install the Stellar CLI from the prebuilt release binary. A `cargo install` of
that CLI fails on a bare Ubuntu machine, because the keyring dependency
`libdbus-sys` finds no dbus development headers.

## Build and test

```bash
stellar contract build      # -> target/wasm32v1-none/release/senet_voucher.wasm
cargo test --workspace      # the contract tests
npm install && npm test     # the library tests
```

`rust-toolchain.toml` pins the Rust version and the Wasm target, so `rustup`
installs both on the first build.

## The deployed contract

| | |
|---|---|
| Contract | `CADGZVNCAFRHJ44P33RODTVXGXCX5EMVCYFHYFMGWNFYVILC556XGWBY` |
| Wasm hash | `c93a39a97541555caf3136dfa13dc33e1592ce492a07ad2f00d050352f98bf55` |
| Amount cap | 1,000,000,000 stroops, which is 100 XLM |
| Lifetime cap | 8,640 ledgers, which is about 12 hours |

`stellar contract build` reproduces that wasm hash from a clean checkout. A
`cargo build --release` produces a different artifact, so it does not reproduce
the deployed contract.

## The evidence archive

Testnet resets, and the RPC server keeps about seven days of history. A
transaction hash is therefore not a durable citation. Every cited transaction
is archived in this repository, with its envelope, its result, its meta and its
diagnostic events, plus the summary that Horizon holds.

One command produces the whole set on testnet and archives it:

```bash
node scripts/run-evidence.mjs
```

The command needs four funded testnet accounts and the contract identifier.
`.env.example` names every value, and `.env` holds them.

The command produces ten rows:

- the redemption whose recipient the submitter selects after the signature;
- the refused replay of that same entry;
- the refused entry whose signature expired;
- the void;
- the refused redemption after the void;
- a voucher that a client built with no network call;
- the four lifetimes.

A refused row lands on chain as a failed transaction, so each refusal is a
public hash. The command reads the diagnostic events of every refused row. It
then checks that the network refused the row for the stated reason.

### What a script produces, and what a person produces

A script produces every row above. The payer there holds a key, so the script
signs on its own.

A script cannot produce a row whose payer is a passkey. A WebAuthn signature
needs a person, a device and a gesture, so no command creates one. A person
captures such a row, and the only value that the person supplies is the
transaction hash. The command reads the rest from the chain: the contract that
the transaction called, the payer, and the signature scheme. It refuses a row
that carries no passkey signature.

The archive holds four passkey rows today, and each one names the contract that
held it. A row against an earlier contract stays until a person captures a
fresh one against the current contract. The replacement needs the new hash and
nothing else.

A second command refreshes the archive of the current set. It produces no
transaction:

```bash
node scripts/archive-evidence.mjs
```

Both commands read `scripts/out/evidence/manifest.json`, which names each
transaction and states what the transaction shows. They write one file for each
row into `scripts/out/evidence/`.

A row that the RPC server no longer holds keeps its Horizon summary, but it
carries no meta. The command names such a row. The command then returns a
non-zero exit code.
