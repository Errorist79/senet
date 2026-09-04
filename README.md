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
| `scripts/out/device-check/` | The archived record of a run that a person made on a phone. |
| `.github/workflows/ci.yml` | The build and the test suites. |
| `deploy/` | The web server configuration, the service unit and the deployment. |

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

### 2. Install the dependencies

```bash
npm install
npm run build
```

The build compiles the library and the service. The account tool in the next
step is part of the service, so this step comes before it.

### 3. Create the accounts and write the `.env` file

One tool creates every account, funds it through friendbot, waits until Horizon
reports a balance, and prints the whole `.env` file:

```bash
npm run --silent new-keys --workspace @senet/server > .env
chmod 600 .env
```

Git ignores `.env`, and it never enters the repository.

The tool creates ten accounts. Four carry a role of the evidence set, and six
are the channel accounts of the fee-payer service. `CHANNEL_COUNT` sets the
number of channels, and the default is six.

| Variable | Role |
|---|---|
| `PAYER_SECRET` | Signs every voucher. |
| `SUBMITTER_SECRET` | Submits the evidence transactions and pays their fee. |
| `MERCHANT_ADDRESS` | Receives a redemption. |
| `SECOND_MERCHANT_ADDRESS` | Receives a refused attempt. |
| `FEEPAYER_CHANNELS` | The channel accounts, as secret keys separated by commas. |
| `CONTRACT_ID` | The voucher contract. Step 4 prints it. |
| `RPC_URL`, `HORIZON_URL` | The servers. Keep the values that the tool writes. |

A merchant receives an amount and signs nothing, so the file keeps an address
for each one and no secret. The address of the payer derives from its secret,
so the file carries the secret alone.

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
below make the payer the admin of the contract as well, which keeps the account
count down. An admin sets the two caps and nothing else.

```bash
admin=$(grep '^PAYER_SECRET=' .env | cut -d= -f2)
wasm=target/wasm32v1-none/release/senet_voucher.wasm

hash=$(stellar contract upload --wasm "$wasm" --optimize=false \
  --source-account "$admin" --network testnet | tail -1)

contract=$(stellar contract deploy --wasm-hash "$hash" \
  --source-account "$admin" --network testnet | tail -1)

stellar contract invoke --id "$contract" --source-account "$admin" \
  --network testnet -- init \
  --admin "$(stellar keys public-key "$admin")" \
  --max_amount 1000000000 --max_ttl_ledgers 8640

sed -i "s|^CONTRACT_ID=.*|CONTRACT_ID=$contract|" .env
echo "CONTRACT_ID=$contract"
```

The `init` call prints `null`, which is the return value of a call that
succeeded.

`--optimize=false` keeps the uploaded bytes identical to the file that the
build produced, so `$hash` equals the sha256 of that file.

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
npm test                   # the library and service tests
```

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

The command archives every row under `scripts/out/evidence/`. Each file holds
the envelope, the result, the meta, the diagnostic events and the Horizon
summary.

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

## The public deployment

`https://senet.hoodrun.io` serves the application and the service. A passkey
binds to the origin that created it. An account made on a phone therefore stays
valid only while that same name serves the application.

### What runs

| Piece | Where |
|---|---|
| A release | `/opt/senet/releases/<stamp>`, one complete build |
| The service | `senet-api.service`, from `/opt/senet/service`, on `127.0.0.1:8791` |
| The application | `/opt/senet/live`, which nginx serves |
| The web server | nginx, from `/etc/nginx/sites-available/senet` |
| The common headers | `/etc/nginx/snippets/senet-common-headers.conf` |
| The keys | `/opt/senet/.env`, which git never carries |
| The certificate | Certbot, for `senet.hoodrun.io` |

`service` and `live` are links. A deployment renames each one in a single step,
so no request sees a directory that sits halfway between two releases.

The service listens on the loopback interface only. nginx terminates TLS and
proxies `/api/` to it, so the service never faces the public network itself.

### Redeploy

```bash
git archive --format=tar HEAD | ssh root@HOST \
  'rm -rf /opt/senet-src && mkdir -p /opt/senet-src && tar -x -C /opt/senet-src'
ssh root@HOST 'bash /opt/senet-src/deploy/deploy.sh /opt/senet-src'
```

`git archive HEAD` carries what the repository holds and nothing else. A copy of
an uncommitted tree would carry a file that nobody committed. The deployment
would then serve code that no reader of the repository can see.

The script builds the release before it changes anything that a reader can
reach. It then moves the service link, waits for the service to answer, and only
then moves the application link.

**That order matters.** The application reads its chain settings from
`/api/config` when it starts. An application that arrives before its service
meets a service that answers without some of those settings. The page then loads
and looks healthy, while account creation refuses. A person meets that as a
broken feature rather than as a site that is down, which is harder to diagnose.

The script never writes `/opt/senet/.env`, so a redeploy cannot lose the channel
keys. It keeps the three newest releases.

### Check the deployment

```bash
CHROME_PATH=/path/to/chrome node deploy/verify.mjs
```

Every check reaches the name over the public network, so it proves what a phone
sees rather than what the host believes. The command checks that:

- each path answers, and every response carries the three common headers;
- the web server never caches the worker, and the worker may control the whole
  origin;
- `stellar.toml` answers as text and allows another origin;
- the service names the contract and holds its channel accounts;
- the application names no relying party other than the host.

With a browser it also loads the page, registers the worker, and reads the
manifest.

Without `CHROME_PATH` the command runs every other check and says that it
skipped one.

## The evidence archive

Testnet resets, and the RPC server keeps about seven days of history. A
transaction hash is therefore not a durable citation. This repository archives
every cited transaction. Each file holds the envelope, the result, the meta and
the diagnostic events, plus the summary that Horizon holds.

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

### A row that a person produces on a phone

A script cannot produce a redemption that a passkey signed, so a person makes
one on a phone and carries back the hash and what the screen said. One command
turns that into a row:

```bash
node scripts/archive-device-row.mjs <hash> --screen merchant \
  --title "Paid" --advice "the sentence under the title"
```

It reads the rest from the network: the contract, the payer, the recipient, the
amount, the voucher identifier, the ledger and the fee. It names the row after
the voucher identifier that it read, so nobody types one.

The command writes nothing until a caller adds `--write`. It first prints the
row that it would write, so a person checks the signature scheme and the
recipient before anything reaches the archive. It refuses a hash that the
network does not hold, and it refuses a figure that disagrees with the chain.

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
