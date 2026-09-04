# @senet/server

The fee-payer. It holds the channel keys, verifies and simulates a submitted
authorization entry, pays the network fee, and returns one typed outcome.

The payer signs an entry that names no recipient. This service chooses the
recipient, builds the transaction, simulates it in enforcing mode, signs as the
source account and submits it.

## Channel accounts

Stellar raises the sequence number of the source account by one for each
transaction, so one account serves one transaction per ledger. Each channel
account is one independent sequence pool, and the pool size sets the
throughput.

Two rules hold the pool together:

- One caller holds one channel. `ChannelPool` enforces this inside a process.
  Two processes must never share a channel key. Each process keeps its own copy
  of the sequence number, so the second transaction fails.
- A full pool refuses new work with the outcome `NO_CHANNEL_FREE`. The service
  does not queue. A caller that waits cannot tell a slow network from a full
  pool, and a refusal says which one it is.

Each channel locks 1 XLM of base reserve, plus the fee bid of one transaction
in flight. Concurrency therefore costs about 1.005 XLM per unit of parallel
throughput.

## Outcomes

Every redeem returns exactly one outcome. A caller branches on the value and
never on the text beside it.

| Outcome | What it means |
|---|---|
| `SUCCESS` | the transaction applied |
| `NONCE_CONSUMED` | the voucher was already spent, and nothing repairs it |
| `AUTH_EXPIRED` | the signature passed its deadline, and a new signature repairs it |
| `BAD_SIGNATURE` | the signature does not match the payer |
| `PAYER_INSUFFICIENT_BALANCE` | the token contract refused first, for a short balance |
| `CONTRACT_REJECTED` | another contract refused, and the code comes with the outcome |
| `APPLY_FAILED` | the ledger refused the transaction |
| `BAD_SEQUENCE` | the sequence number was wrong, and the service tries again |
| `FEE_PAYER_UNDERFUNDED` | every channel fell under the floor |
| `NO_CHANNEL_FREE` | every channel is in use |
| `FEE_ABOVE_CEILING` | simulation asked for more than the service pays |
| `TIMEOUT` | the transaction reached no ledger inside the poll window |
| `UNKNOWN` | nothing above matched |

The primary signal is the typed error value that the host puts in a diagnostic
event, and not the English message. Two ordering rules make that reading
correct:

- **The last error names the failure.** The host escalates an error outwards,
  so the outermost entry comes last. A signature from the wrong key raises a
  contract error inside the account contract first, and an authorization error
  outside it. A reader that takes the first entry calls that a contract
  rejection, which is wrong.
- **The first error names the contract that refused.** A contract error code
  means nothing on its own. The number belongs to whichever contract produced
  it, and the voucher contract re-raises the code that the token contract
  produced.

The message text is a fallback for the stages that carry no events, such as a
rejection at submission. A failure that nothing matches becomes `UNKNOWN`, and
never a guess. A protocol release can add a code that the classifier does not
know. A rise in `UNKNOWN` is therefore the signal to read the diagnostic
events.

## The check at start

The service reads the contract's stored limits once, before it serves any
request. It compares the lifetime ceiling with the one that this build offers.
The two numbers must agree.

The library refuses a lifetime above its own ceiling before the payer signs.
That check is worth nothing when the deployed contract holds a different
number, and contract code cannot tell the library which number it holds. One
read at start turns a mismatch that nobody would see into a refusal to start.

The service also refuses to start when the contract does not answer. A contract
that the service cannot read is a contract that it cannot serve.

## The retry rule

The nonce and the sequence number are two separate single-use resources, so a
careless retry could send one voucher twice.

- A bad sequence number means the network took nothing. The service reads the
  sequence number again and tries once more.
- A timeout before the poll stage means the transaction never reached the
  network. The service tries again.
- A timeout at the poll stage is different. The transaction carries a hash and
  it may still apply. The service reports the timeout with that hash and leaves
  the resolution to the caller.
- Every other outcome is final.

## What bounds the fee

- The service bids 10,000 stroops of inclusion fee. Simulation adds the
  resource fee, and the sum is the whole bid.
- The service refuses to submit above 1,000,000 stroops of whole fee. A hostile
  entry with a large footprint would otherwise turn one request into a large
  charge against a channel.
- A channel that falls under 50,000,000 stroops counts as spent. The service
  answers `FEE_PAYER_UNDERFUNDED` when every channel falls under that floor.
  The network would otherwise refuse the transaction for a reason that the
  caller cannot read.
- `lowChannels()` names the channels under the floor, so an operator sees the
  problem before the service cannot pay.

## Configuration

The keys live in a `.env` file on the host, and never in the repository.
`.env.example` at the repository root lists every variable. Set `ENV_FILE` when
the working directory is not the one that holds the file.

## Fresh keys

The service inherits no key from anywhere. One command creates every account
that it needs and funds each one:

```
npm run --silent new-keys --workspace @senet/server > .env
chmod 600 .env
```

The tool creates the channel accounts, a payer and a recipient. It asks
friendbot to fund each account. It then waits until Horizon reports a balance,
so a key that it prints is a key that works. It writes no file, and it can
therefore never lose a key that a `.env` already holds. `CHANNEL_COUNT` sets the number of
channel accounts, and the default is six.

## Routes

The service answers under `/api/`. It listens on the loopback interface, and
the web server in front of it terminates TLS and proxies that prefix.

| Route | What it does |
|---|---|
| `GET /api/config` | the network, the contract and the token |
| `GET /api/ledger` | the latest ledger, and when the service read it |
| `GET /api/balance?address=` | one account's native balance, in stroops |
| `GET /api/status` | the channel balances, the ones under the floor, and the contract limits |
| `POST /api/redeem` | one redeem, with `entryXdr` and `recipient` |

`POST /api/redeem` takes the terms out of the signed entry and never out of the
request. A request that also carried an amount could disagree with the entry,
and the payer signed the entry. The caller supplies only the recipient, which
the entry deliberately omits.

A failure always takes one shape, `{"error":{"code","message"}}`, and a client
branches on the code. A refusal from the library carries the name of its own
error class, such as `CredentialTypeError` or `DeadlineMismatchError`. The
client therefore learns which rule the entry broke.

Every request counts against a budget per client, per minute: 12 on the routes
that pay a network fee, and 120 on the routes that cost nothing on chain. The
service pays a fee for every submission that it accepts. A route with no budget
is therefore a way to spend the channel accounts down.

## Build and test

```
npm run build --workspace @senet/server
npm test --workspace @senet/server
```

## Measured behaviour

A run on 2026-09-04 against contract
`CADGZVNCAFRHJ44P33RODTVXGXCX5EMVCYFHYFMGWNFYVILC556XGWBY`, with six channel
accounts, redeemed 20 vouchers in sequence and 5 at the same time. All 25
succeeded, and no attempt needed a second try. Every redemption declared 47,742
stroops and the network charged 27,364.

| Batch | Channels used | Median wait |
|---|---|---|
| sequential, 20 | 1 | 5,052 ms |
| concurrent, 5 | 5 | 4,186 ms |

Two rules show in these numbers. The five concurrent redemptions took five
different channels, and one ledger carried all five. The 20 sequential
redemptions reused one channel, one per ledger, at the measured mean ledger
close time.

The evidence archive holds the producer that drives these batches, and it keeps
one row per redemption.
