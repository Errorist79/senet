/**
 * Every number that the fee-payer depends on, with the reason for its value.
 *
 * Fee measurements come from archived testnet transactions with ed25519 and
 * passkey payers. The fee depends on the resources and the ledger state.
 */

/**
 * The inclusion fee that the service bids, in stroops.
 *
 * Simulation adds the resource fee on top of this value, and the sum is the
 * whole bid. Three archived passkey redemptions each paid 100 stroops for
 * inclusion. The ed25519 reference paid the same inclusion fee.
 *
 * The bid is not only a price ceiling. The source account must hold the whole
 * bid before the transaction passes validation. Every stroop of the bid is
 * therefore float that one transaction in flight locks. The measured Soroban
 * inclusion fee on testnet was 100 stroops at every percentile up to p99 over
 * 50 ledgers. A bid of 10,000 is a hundredfold margin at a small cost.
 */
export const INCLUSION_FEE_STROOPS = 10_000n;

/*
 * How the three fee ceilings below follow from measurements.
 *
 * The resource fee comes from simulation, and simulation reads the footprint
 * of the call that the caller supplies. Without a ceiling, a hostile request
 * with a large footprint would turn into a large charge against a channel.
 *
 * Rent is most of every fee that the service pays. The network computes the
 * rent rate from the live Soroban state size, so the rate grows as testnet
 * grows, and no vote changes it. On 4 October 2026 the rate was 5,403 stroops
 * per KB.
 *
 * Each ceiling takes the most that a legitimate request of its kind cost at
 * that rate. It scales that sum to 10,000 stroops per KB, which is the network
 * setting `rentFee1KbSorobanStateSizeHigh`: the highest rate below the target
 * state size. The scale applies to the whole fee, so the part that is not rent
 * gets more room than it needs. A margin of 10 percent then covers the spread
 * between requests of one kind, which measured at most 3.15 percent.
 *
 * No ceiling covers an extension of shared contract code. The voucher contract
 * extends its code during a redemption, and every passkey wallet extends the
 * shared wallet code during an authentication. Each extension costs more than
 * 100 million stroops. A timer extends that code before a request has to, and
 * `deploy/verify.mjs` fails when the timer falls behind.
 */

/**
 * The largest whole fee that the service pays for one redemption or SEP-7
 * payment that a key authorizes, in stroops. A contract other than the passkey
 * wallet gets this ceiling too, because it runs code that its owner chose.
 *
 * Measured on 4 October 2026: such a redemption declared at most 49,334
 * stroops. A redemption can also extend the TTL of the native asset balance
 * that it touches by up to 30 days. That measured 1.134 stroops per ledger, or
 * 587,890 for 30 days. The derivation above turns the sum into 1,287,970.
 */
export const MAX_REDEEM_FEE_STROOPS = 1_300_000n;

/**
 * The largest whole fee that the service pays for one request that a passkey
 * wallet authorizes, in stroops: a redemption, a void, or a SEP-7 payment. The
 * service reads the payer's code from the network and checks that it is the
 * wallet code that it knows.
 *
 * Measured on 4 October 2026: a passkey redemption declared 52,035 stroops, a
 * passkey void 47,546, and a SEP-7 payment 45,411. A request can also carry
 * extensions that the network charges once:
 *
 * - The wallet extends its own instance and signer to the maximum TTL once they
 *   sit more than one week below it. That measured 2.204 stroops per ledger, or
 *   6,855,319 for all 3,110,399 ledgers.
 * - The request can extend up to three native asset balances, each by up to 30
 *   days, at 587,890 each.
 *
 * The derivation above turns the redemption into 17,644,031 and the payment
 * into 16,433,656.
 *
 * The ceiling covers a wallet that sat idle for as long as the network keeps
 * it. A lower ceiling would refuse the next request of such a wallet. The
 * refusal leaves the extension undone. Every later request of that wallet would
 * then fail the same way, and the wallet would stay stuck for ever.
 *
 * It covers one account's own instance and signer. It never covers the shared
 * wallet code, which the timer keeps out of every request.
 */
export const MAX_PASSKEY_REQUEST_FEE_STROOPS = 18_000_000n;

/**
 * The largest whole fee that the service pays for one account deployment.
 *
 * A deployment writes a wallet instance and its first signer, and it pays rent
 * for both up to the maximum TTL. Four deployment simulations on 4 October 2026
 * declared at most 6,644,266 stroops. The derivation above turns that into
 * 13,517,742.
 *
 * The deploy route has this ceiling to itself. A payment and a redemption go
 * through routes with their own ceilings, which follow from their own costs.
 */
export const MAX_DEPLOY_FEE_STROOPS = 14_000_000n;

/**
 * The balance below which the service treats a channel account as spent, in
 * stroops.
 *
 * An account must hold its base reserve and the whole declared fee before
 * validation. This floor exceeds the redemption fee ceiling. The service
 * reports each channel below this floor. It rejects submission when every
 * channel has a known balance below the floor.
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
 * The listener uses this status only when the ledger range that the RPC
 * reports proves the age. The code of a refusal proves nothing, because the
 * RPC gives one code to several faults, and some of them clear on their own.
 *
 * 78 is `EX_CONFIG` in `sysexits.h`, which is the closest standard meaning: the
 * stored state is no longer usable and a person must decide what to do.
 */
export const EXIT_CURSOR_AGED_OUT = 78;

/**
 * How many times a run that must end repeats a refused delivery.
 *
 * A listener that runs for ever never gives up, because a receiver that
 * returns after an hour should find its message waiting. A run that a person
 * started needs to end and to say why, so it stops after this many refusals
 * and moves nothing. The event that it could not deliver is still the next one.
 */
export const DELIVERY_ATTEMPTS_WHEN_QUIET = 5;
