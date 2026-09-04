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
| `scripts/out/load-check/` | The archived record of the cost and throughput run. |
| `.github/workflows/ci.yml` | The build and the test suites. |

## Versions

| Component | Version |
|---|---|
| Stellar network | Testnet, protocol 28 |
| Rust | 1.96.0, target `wasm32v1-none` |
| `soroban-sdk` | 27.0.6 |
| `stellar-cli` | 28.0.0 |
| Node | 22 |

## Reproduce the whole path

This section takes a reader from an empty machine to a redeemed voucher and to
a refusal that the network recorded. It assumes knowledge of Stellar. It
assumes no account, no key and nothing from this project.

Everything below runs against testnet. Testnet holds no value.

### 1. Install the tools

| Tool | Version | How to obtain it |
|---|---|---|
| Rust | 1.96.0 | `rustup`, which reads `rust-toolchain.toml` and installs the version and the `wasm32v1-none` target on the first build. |
| Stellar CLI | 28.0.0 | The prebuilt release binary. |
| Node | 22 | Any 22 release. |

Install the Stellar CLI from the release binary:

```bash
version=28.0.0
curl --fail --location --silent --show-error \
  "https://github.com/stellar/stellar-cli/releases/download/v${version}/stellar-cli-${version}-x86_64-unknown-linux-gnu.tar.gz" \
  --output /tmp/stellar-cli.tar.gz
tar -xzf /tmp/stellar-cli.tar.gz -C /tmp stellar
sudo install -m 0755 /tmp/stellar /usr/local/bin/stellar
stellar --version
```

Do not run `cargo install stellar-cli`. It fails on a bare Ubuntu machine,
because the keyring dependency `libdbus-sys` finds no dbus development headers.

A fresh `rustup` install puts `cargo` on the path of a new shell only. Open a
new shell after that install, or run `. "$HOME/.cargo/env"` in the current
one.

Point the CLI at testnet:

```bash
stellar network use testnet
```

### 2. Create and fund the accounts

The commands need ten testnet accounts. Four carry the roles of the evidence
set. Six are the channel accounts of the fee-payer service.

```bash
for name in a b c d; do
  stellar keys generate --fund --network testnet "senet-$name"
done
for index in 1 2 3 4 5 6; do
  stellar keys generate --fund --network testnet "senet-channel-$index"
done
```

Friendbot funds each account with 10,000 test XLM. It rate limits a burst, so
the loops create one account at a time.

### 3. Write the `.env` file

Copy the example and fill it in. `.env` is ignored, and it never enters the
repository.

```bash
cp .env.example .env
```

| Variable | Meaning | How to produce the value |
|---|---|---|
| `RPC_URL` | The Soroban RPC server. | Keep the default. |
| `HORIZON_URL` | The Horizon server. | Keep the default. |
| `CONTRACT_ID` | The voucher contract that the commands call. | Step 4 prints it. |
| `A_SECRET` | The payer, who signs every voucher. | `stellar keys secret senet-a` |
| `B_SECRET` | The submitter, who pays the network fee and selects the recipient. | `stellar keys secret senet-b` |
| `C_SECRET` | The recipient, who stands for a merchant. | `stellar keys secret senet-c` |
| `D_SECRET` | A second recipient, who receives a refused attempt. | `stellar keys secret senet-d` |
| `FEEPAYER_CHANNELS` | The channel accounts of the fee-payer, as one comma-separated list of secret keys. | The loop below prints the list. |

```bash
for index in 1 2 3 4 5 6; do
  stellar keys secret "senet-channel-$index"
done | paste -s -d , -
```

One channel account serves one transaction per ledger, so the number of
channels sets the throughput. Six channels carry the load check.

### 4. Build the contract and deploy it

```bash
stellar contract build
```

That writes `target/wasm32v1-none/release/senet_voucher.wasm`. Use
`stellar contract build`, and not `cargo build --release`: the two produce
different artifacts, and only the first reproduces a deployed contract byte for
byte.

Upload the file, deploy an instance of it, and initialize it. The commands
below make `senet-a` the admin of the contract as well as the payer, which
keeps the account count down. An admin sets the two caps and nothing else.

```bash
admin=$(stellar keys secret senet-a)
wasm=target/wasm32v1-none/release/senet_voucher.wasm

hash=$(stellar contract upload --wasm "$wasm" --optimize=false \
  --source-account "$admin" --network testnet | tail -1)

contract=$(stellar contract deploy --wasm-hash "$hash" \
  --source-account "$admin" --network testnet | tail -1)

stellar contract invoke --id "$contract" --source-account "$admin" \
  --network testnet -- init \
  --admin "$(stellar keys public-key senet-a)" \
  --max_amount 1000000000 --max_ttl_ledgers 8640

echo "CONTRACT_ID=$contract"
```

The `init` call prints `null`, which is the return value of a call that
succeeded.

`--optimize=false` keeps the uploaded bytes identical to the file that the
build produced, so `$hash` equals the sha256 of that file. Put the printed
`CONTRACT_ID` into `.env`.

`max_amount` is 1,000,000,000 stroops, which is 100 XLM. `max_ttl_ledgers` is
8,640 ledgers, which is about 12 hours. The library carries the same lifetime
cap, and the fee-payer service refuses to start when the two disagree.

Read the values back:

```bash
stellar contract invoke --id "$contract" --source-account "$admin" \
  --network testnet -- limits
```

### 5. Run the tests

```bash
cargo test --workspace     # 30 contract tests
npm install
npm run build              # compile the library and the service
npm test                   # the library and service tests
```

Steps 6 and 7 run the compiled library, so do not skip `npm run build`.

### 6. Redeem a voucher, and record a refusal

```bash
node scripts/run-evidence.mjs
```

The command mints, submits and archives ten transactions. Six succeed and three
fail on purpose. It prints the reason that the network recorded for each
refusal, and it stops when a refusal happened for the wrong reason:

```
1b-double-spend-failed             FAILED   4b8605f6...
  the network recorded ["nonce already exists for address","GAF5..."]
```

A refused transaction lands on the ledger. Its hash therefore opens in any
explorer, and the refusal is a public record rather than a console line.

Every row is archived under `scripts/out/evidence/`, with the envelope, the
result, the meta, the diagnostic events and the Horizon summary.

### 7. Measure the cost and the throughput

```bash
node scripts/run-load-check.mjs
```

### What this path does not cover

The application, the passkey accounts and the payee-presented codes need a
browser and a phone. They are not part of this path.

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

## The load check

The proof rows show that each rule holds. They do not show what a redemption
costs in steady state, and they do not show how many redemptions fit in one
ledger. A separate command answers those two questions:

```bash
node scripts/run-load-check.mjs
```

It drives the fee-payer service. One channel account serves one transaction per
ledger, so the size of the channel pool sets the throughput. The run shows both
sides of that rule:

- twenty redemptions run one after another and reuse one channel, so they
  occupy one ledger each;
- five redemptions run at the same time through five channels, so one ledger
  carries all five.

The command archives all twenty-five transactions into
`scripts/out/load-check/`, in the same format as the proof rows.

A row of the load check holds only what the chain cannot say: the batch, the
attempt number, and how long the client waited. The ledger, the channel and the
fee stay out of the row, because the archived Horizon summary already carries
all three. The channel of a row is the account that submitted it.

The command then derives the figures of its own summary from the archived rows,
and it fails when the two disagree. A figure that a summary states is a label.
The same figure, derived from the archive, is a fact. The check reads the
archive alone, so it still works after a testnet reset.
