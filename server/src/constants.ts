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
 * The largest whole fee that the service submits, in stroops.
 *
 * The resource fee comes from simulation, and simulation reads the footprint
 * of the call that the caller supplies. A hostile entry with a large footprint
 * would otherwise turn one request into a large charge against a channel. A
 * measured redeem declares about 47,743 stroops, so this ceiling sits about
 * twenty times above it. That leaves room for a passkey payer, which costs
 * more than an ed25519 payer.
 */
export const MAX_FEE_STROOPS = 1_000_000n;

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

/** Stroops in one XLM. Horizon reports a balance with seven decimal places. */
export const STROOPS_PER_XLM = 10_000_000n;
