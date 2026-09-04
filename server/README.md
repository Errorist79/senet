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

## Build and test

```
npm run build --workspace @senet/server
npm test --workspace @senet/server
```

## The load check

The load check drives the service against testnet. It mints one voucher per
redemption, runs a sequential batch and then a concurrent batch, and writes
every outcome to a file:

```
ENV_FILE=/path/to/.env npm run load-check --workspace @senet/server -- out.json
```

A run on 2026-09-04 against contract
`CDPEBL7N5F6CZEB7DZ4DRI5I6XPBEZYLNIAYZDVML452E7VW33VBLJPN`, with six channels,
redeemed 20 vouchers in sequence and 5 at the same time. All 25 succeeded and
no attempt needed a retry.

| Batch | Channels used | Median | Declared fee | Fee charged |
|---|---|---|---|---|
| sequential, 20 | 1 | 5,037 ms | 47,746 to 61,803 stroops | 27,368 to 39,592 stroops |
| concurrent, 5 | 5 | 5,073 ms | 47,746 to 61,803 stroops | 27,368 to 39,592 stroops |

The five concurrent redemptions took five different channels, which is the
exclusivity rule at work. They finished inside one median ledger time, which is
the throughput rule at work.
