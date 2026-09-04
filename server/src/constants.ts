/**
 * Every number that the fee-payer depends on, with the reason for its value.
 *
 * Each figure that names a measurement comes from a run on testnet with an
 * ed25519 payer. A passkey payer costs more, and nobody measured it yet.
 */

/**
 * The inclusion fee that the service bids, in stroops.
 *
 * Simulation adds the resource fee on top of this value, and the sum is the
 * whole bid. A redeem measured 47,743 stroops of total bid, of which 37,743
 * was the resource fee.
 *
 * The bid is not only a price ceiling. The source account must hold the whole
 * bid before the transaction passes validation. Every stroop of the bid is
 * therefore float that one transaction in flight locks. The measured Soroban
 * inclusion fee on testnet was 100 stroops at every percentile up to p99 over
 * 50 ledgers. A bid of 10,000 is a hundredfold margin at a small cost.
 */
export const INCLUSION_FEE_STROOPS = 10_000n;

/**
 * The largest whole fee that the service pays for one redeem, in stroops.
 *
 * The resource fee comes from simulation, and simulation reads the footprint
 * of the call that the caller supplies. A hostile entry with a large footprint
 * would otherwise turn one request into a large charge against a channel. A
 * measured redeem declares about 47,743 stroops, so this ceiling sits about
 * twenty times above it. That leaves room for a passkey payer, which costs
 * more than an ed25519 payer.
 */
export const MAX_REDEEM_FEE_STROOPS = 1_000_000n;

/**
 * The largest whole fee that the service pays for one account deployment.
 *
 * A deployment writes a contract instance and its first signer, so it costs
 * far more than a call against a contract that already exists. One measured
 * deployment declared 1,268,372 stroops and the network charged 1,088,424.
 * This ceiling sits about four times above the measured figure.
 *
 * The two ceilings are separate because the work is separate. One number that
 * covered both would let a hostile voucher spend what a deployment costs.
 */
export const MAX_DEPLOY_FEE_STROOPS = 5_000_000n;

/**
 * The balance below which the service treats a channel account as spent, in
 * stroops.
 *
 * One redeem bids about 47,743 stroops, and an account must also hold its base
 * reserve of 10,000,000 stroops. Five XLM leaves room for roughly a thousand
 * more redeems. A channel that falls under this floor drifted far from where
 * it started. The service says so plainly, rather than letting the network
 * reject a transaction for a reason that the caller cannot read.
 */
export const MIN_CHANNEL_BALANCE_STROOPS = 50_000_000n;

/** How long the service reuses a channel balance reading, in milliseconds. */
export const BALANCE_CACHE_MS = 60_000;

/** How many times the service asks for a transaction result. */
export const POLL_ATTEMPTS = 30;

/** How long the service waits between two of those requests, in milliseconds. */
export const POLL_INTERVAL_MS = 1000;

/**
 * Attempts for one redeem, the first attempt included.
 *
 * Only a bad sequence number, and a timeout before the transaction reaches the
 * network, make the service try again.
 */
export const MAX_ATTEMPTS = 3;

/**
 * How many times a caller asks the network whether funds arrived.
 *
 * The funding service answers as soon as it submits, and the transaction
 * reaches a ledger a few seconds later. A caller that reads the balance at
 * once reads the balance from before the funds arrive.
 *
 * One measured funding of a new smart account landed in 5,631 milliseconds,
 * which is about one ledger. This bound is twenty seconds, about four ledgers,
 * so a slow ledger still succeeds and a broken one still gives up.
 */
export const FUND_CONFIRM_ATTEMPTS = 20;

/** How long a caller waits between two of those questions, in milliseconds. */
export const FUND_CONFIRM_INTERVAL_MS = 1000;

/** Stroops in one XLM. Horizon reports a balance with seven decimal places. */
export const STROOPS_PER_XLM = 10_000_000n;

/**
 * How long the listener waits between two polls, in milliseconds.
 *
 * A ledger closes about every five seconds. Two seconds keeps the delay of a
 * redemption under one ledger. A shorter interval asks the network a question
 * that it cannot answer any faster.
 */
export const EVENT_POLL_INTERVAL_MS = 2_000;

/**
 * How many events one poll asks for.
 *
 * The RPC accepts 1 to 10,000 and defaults to 100. A burst of redemptions is
 * far smaller than this, and a page that a delivery failure blocks should be
 * small enough to retry cheaply.
 */
export const EVENT_PAGE_LIMIT = 100;

/** How long the listener waits before it repeats a failed delivery. */
export const DELIVERY_BACKOFF_MS = 1_000;

/**
 * The longest wait between two attempts at one delivery.
 *
 * The listener never gives up and never skips, so the backoff has a ceiling
 * rather than an attempt count. A receiver that returns after an hour finds
 * the listener still asking.
 */
export const DELIVERY_BACKOFF_CEILING_MS = 30_000;

/**
 * The status that the listener exits with when its cursor aged out.
 *
 * The RPC keeps about seven days of history. A cursor older than that names a
 * ledger the network no longer holds, and every redemption between that ledger
 * and now is unreadable. The listener stops. It does not jump to the present,
 * because a jump drops those redemptions and leaves a service that looks
 * healthy.
 *
 * 78 is `EX_CONFIG` in `sysexits.h`, which is the closest standard meaning: the
 * stored state is no longer usable and a person must decide what to do.
 */
export const EXIT_CURSOR_AGED_OUT = 78;

/**
 * The JSON-RPC code that the network returns for a request that it refuses.
 *
 * The listener sends one shape of request, and the only part of it that can
 * age is the cursor. This code therefore means the cursor named a ledger
 * outside the retained window. The listener classifies on this value and never
 * on the message, because the message is English prose that the network owns.
 */
export const RPC_INVALID_REQUEST = -32600;
