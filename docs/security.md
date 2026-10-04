# Senet security note

Senet is a testnet application for native XLM. It has no external security audit and no mainnet deployment.
The [protocol note](protocol.md) specifies the voucher and its signed fields.

The payer trusts the application that requests a passkey signature.
The merchant trusts the service to submit the requested recipient and report the result correctly.
The signature does not bind the recipient. A dishonest service can redeem a valid voucher to another address.
The event feed reports the recipient that the contract records. It cannot reverse a redirected payment.

## Threats, controls and tests

The table names executable tests. A test demonstrates its stated case, not protection against every possible attack.
The Rust tests below reside in [the contract suite](../contracts/senet-voucher/src/test.rs).

| Threat | Control and remaining limit | Test |
|---|---|---|
| A person copies a voucher. | The amount cap limits one voucher to 100 XLM. The deadline limits its life. A successful void consumes its nonce. A copier can still redeem first. | `real_signature_redeems_to_a_late_bound_recipient` demonstrates the bearer property. `amount_over_cap_is_rejected` checks the cap. `void_with_a_real_signature_consumes_the_nonce` checks the void. |
| A submitter uses the same signed entry twice. | The host refuses a consumed nonce. The contract stores no individual voucher state. A new signature with a fresh nonce can reuse an identifier. | `same_signed_entry_cannot_be_used_twice`; `the_same_voucher_id_pays_again_under_a_fresh_nonce`. |
| A fee payer alters the transaction. | The signature fixes the payer, amount, identifier, deadline and call tree. It deliberately leaves the recipient free. The merchant must trust the fee payer for the destination. | `signed_amount_cannot_be_changed_by_the_submitter`; `submitter_cannot_change_expire_at`; `submitter_cannot_change_the_voucher_id`; `submitter_cannot_change_the_payer`. `real_signature_redeems_to_a_late_bound_recipient` demonstrates the recipient limit. |
| A person forges a payee-presented code. | The application checks the URI signature against the key from the named domain's HTTPS `stellar.toml`. A valid signature authenticates that domain, not the merchant's honesty. Unsigned or unreachable requests remain unverified. | [SEP-7 tests](../packages/core/test/sep7.test.ts): `a changed request no longer verifies`; `another key no longer verifies`; `verification names each failure separately`. These test the signature logic, not a hostile domain or browser. |
| A wallet reads a testnet request as a public network request. | Every request that the service signs carries `network_passphrase`, and the signature covers it. The library refuses to build a request without a network. The application refuses a request for another network. It reads a request without a network as public, as SEP-7 defines. Senet does not control how another wallet reads the field. A wallet that ignores the field can send real funds on the public network to an address that nobody can spend from. Observation: on 2026-10-04, LOBSTR scanned a request that named the test network. LOBSTR showed the native asset contract of the public network, and then it reported a failed transaction. | [SEP-7 tests](../packages/core/test/sep7.test.ts): `the builder refuses a request that names no network`; `a request with no network is for the public network`; `the signature covers the network`. [Payee route tests](../server/test/payee.test.ts): `the request names the network that the service runs on`. The `no-network` and `public-network` cases of [the scan check](../deploy/scan-check.mjs) feed both faults to the deployed payee screen. No test exercises another wallet. The LOBSTR observation is one manual scan by one person. It is not a test, and it says nothing about other wallets. |
| The payer estimates the wrong ledger. | The contract rejects past deadlines and remaining life above its cap. The merchant requires six remaining ledgers. An estimate can err in either direction. | `expire_at_in_the_past_is_rejected`; `expire_at_one_past_the_cap_is_rejected`; `expire_at_equal_to_current_ledger_is_still_valid`. [Ledger tests](../packages/core/test/ledger.test.ts): `an offline deadline is the estimate plus the lifetime`; `a voucher at the limit passes and a shorter one does not`. These check arithmetic and boundaries, not clock accuracy. |
| A hostile symbol reaches the decoder and XDR reader. | `zxing-wasm` 3.1.3 uses WebAssembly, with its bytes inside the application bundle. The reader checks the prefix, XDR, credential arm, root call and equal deadlines. It does not verify the signature. The payee screen gives the decoded text to the SEP-7 parser only when the text starts with `web+stellar:`. | [Hostile-input tests](../packages/core/test/hostile.test.ts): `the reader refuses correct framing around something else`; `the reader refuses an entry with legacy credentials`; `the reader refuses or reads whole a voucher with mutated bytes`. These start with bytes, not malformed images. They permit structurally valid mutations to decode. |
| A caller sends hostile HTTP input. | The service checks JSON shape, required fields and entry XDR. It runs `readVoucher` before network work. HTTP is a separate input boundary from the camera. | [Route tests](../server/test/routes.test.ts): `the service refuses a body that is a JSON array`; `the service refuses an entry that is not base64 XDR`; `the service names deadlines that disagree DeadlineMismatchError`; `the service names an entry for another contract VoucherFormatError`. |
| A caller drains fee-payer funds through requests. | The service compares the whole assembled fee with a ceiling before it signs. Request budgets limit bursts per client address. These controls do not impose a global spend budget. | [Fee-payer tests](../server/test/feepayer.test.ts): `the redeem ceiling sits above a redeem and below the channel floor`; `a redeem never spends what a deployment costs`. These compare constants. [Route tests](../server/test/routes.test.ts): `the budget on a paying route refuses a burst`. |
| A caller fabricates a payment confirmation. | The service reads the referenced event from RPC and uses the event's fields. It does not accept payment terms from the webhook caller. The RPC and service remain trusted. | [Redemption tests](../server/test/redemptions.test.ts): `the chain decides what a redemption says, and not the caller`; `a pointer to an event that the chain does not hold gives nothing`. |

## Decoder scope

The credential check also prevents access to the wrong XDR union arm.
Without that check, a legacy entry can cause an untyped exception at `addressV2()`.
The hostile-input suite checks typed refusals and 400 seeded byte mutations.
Some mutations still decode because the suite does not check signatures.

No test in that suite feeds malformed images into the WebAssembly decoder.
The [application build](../app/build.mjs) embeds the decoder bytes and checks that the bundle contains them.
The [decoder setup](../app/src/qr.ts) supplies those bytes directly.
This removes the decoder's need to fetch its WebAssembly at runtime.

The [WebAssembly security model](https://webassembly.org/docs/security/) describes module isolation.
That isolation is a platform property, not an audit of this decoder.
The project did not audit the imports that its JavaScript support code exposes.
Isolation does not prevent the decoder from returning wrong bytes or consuming excessive resources.
The format checks do not prove that an arbitrary wrong output lacks a valid structure.
Enforcing simulation and execution on chain check the payer's authorization after decode.

## Eight remaining limits

1. A code is a bearer instrument. A copier can redeem a copy taken inside its lifetime. The cap and void limit this risk but do not remove it.
2. Consistency between the two expiration values is the client's responsibility. The contract cannot see the signature expiration ledger.
3. A lifetime above the cap is caught in simulation and leaves no on-chain record through the normal service path.
4. A cap that the admin lowers can strand vouchers already in circulation for up to twelve hours.
5. The SDK preserves authorization entries that the caller supplies. The project verifies this behavior from source, not published documentation, so the project pins the SDK version.
6. The project did not test passkeys synchronized from another device.
7. A payment request names its network, and Senet cannot make another wallet obey that field. LOBSTR did not obey it in one scan on 2026-10-04.
8. Rent depends on the total state size of testnet, which Senet does not control.

The third limit describes the service path. A caller that bypasses simulation can submit a failing transaction and pay its fee.
The fourth limit uses the application's approximate twelve-hour maximum. Actual expiry depends on ledger progress.

A lower amount cap can prevent both redemption and void for the rest of a voucher's life.
A lower lifetime cap can prevent redemption until the remaining life fits that cap.
`a_lower_cap_strands_a_voucher_already_in_circulation` checks both refusals.

The SDK pin is exactly `@stellar/stellar-sdk` `16.3.0`.
In [the pinned assembly source](https://github.com/stellar/js-stellar-sdk/blob/v16.3.0/src/rpc/transaction.ts), a nonempty `existingAuth` replaces the authorization entries from simulation.
The service uses that path after simulation with authorization checks.
The pin is the source-based compatibility control. The version guard alone accepts a wider range within major version 16.

## Fee-payer spend bound

The service bids 10,000 stroops for inclusion and obtains the resource fee from simulation.
The assembled transaction fee is the whole declared fee. It is not a fixed 47,743-stroop bid.
The service refuses a request above the ceiling of its kind before it signs or submits:

| Request | Ceiling in stroops | Ceiling in XLM |
|---|---:|---:|
| A redemption or a SEP-7 payment that a key authorizes | 1,300,000 | 0.13 |
| A redemption, a void or a SEP-7 payment that a passkey account authorizes | 18,000,000 | 1.8 |
| An account deployment | 14,000,000 | 1.4 |

These are per-transaction ceilings, not an aggregate guarantee.

Each ceiling starts from the most that a legitimate request of its kind cost on 4 October 2026.
It scales that cost to the highest rent rate below the target state size, and it adds 10 percent.
The rent rate grows with the live state size of testnet.
On 4 October 2026 it was 5,403 stroops per KB. The network setting `rentFee1KbSorobanStateSizeHigh` is 10,000.
On that day a deployment cost 6,644,266 stroops, above the ceiling of 5,000,000 that applied then, so the service refused every new passkey account.

The passkey ceiling covers a wallet that sat idle for as long as the network keeps it.
Such a wallet extends its own instance and signer to the maximum TTL in its next request.
A lower ceiling would refuse that request. The extension would then stay undone, and every later request of that wallet would fail the same way.
The ceiling covers one account's own instance and signer. It never covers the shared wallet code.

No ceiling covers an extension of shared contract code. Each such extension costs more than 100 million stroops.
A timer extends the voucher contract and the shared wallet code before a user request has to.
`deploy/verify.mjs` fails when the timer falls behind.
It also fails when a simulated deployment or ed25519 redemption passes 75 percent of its ceiling.

The service allows 12 requests per client address in each 60-second window on routes that can spend fees.
The process holds these counters in memory. A restart clears them, and callers with multiple addresses can obtain separate budgets.
This service has no user authentication or global daily spend cap.

The operator supplies funded testnet channel keys through the service configuration.
The deployment keeps these testnet secrets in an environment file on the host.
This key custody model is not a mainnet secret management system.

An enforcing simulation failure costs no network fee and has no transaction hash.
A transaction that reaches the ledger can still fail and charge the submitter.
The service does not retry a timeout during the result poll because the transaction may still apply.
`a timeout at the poll stage is never tried again` checks that policy in the fee-payer suite.

The [fee-payer implementation](../server/src/feepayer.ts) enforces the fee comparison.
The [constants](../server/src/constants.ts) and [request budget](../server/src/http/budget.ts) define the limits.

## Measured redemption fees

The [fee analysis](../scripts/out/fee-check/redemption-fees.json) records three passkey redemptions and one ed25519 reference from the archive.
All values below are stroops. The declared fee includes both the inclusion bid and the resource fee.

| Transaction archive | UTC date | Declared fee | Charged fee | Rent within charged fee |
|---|---|---:|---:|---:|
| [Passkey 1](../scripts/out/evidence/passkey-redeem-1.json) | 2026-09-01 | 160,781 | 126,033 | 98,438 |
| [Passkey 2](../scripts/out/evidence/passkey-redeem-2.json) | 2026-09-01 | 50,543 | 30,176 | 2,563 |
| [Passkey 3](../scripts/out/evidence/passkey-redeem-3.json) | 2026-09-01 | 50,543 | 30,176 | 2,563 |
| [Ed25519 reference](../scripts/out/evidence/1a-success.json) | 2026-09-04 | 237,742 | 27,364 | 2,564 |

The first passkey charge exceeds the second by 95,857 stroops.
Its rent component is 95,875 stroops higher, and its nonrefundable resource component is 18 stroops lower.
The metadata identifies total rent. It does not identify which storage entry caused that rent.
These transactions use different state, and the ed25519 reference uses a different voucher deployment.
They do not establish a universal passkey fee or a cost ratio between signature schemes.

The ed25519 reference bids 200,000 stroops for inclusion. Each passkey sample bids 10,000 stroops.
Each transaction pays 100 stroops for inclusion.
With the service's 10,000-stroop inclusion bid, the archived resource fees yield these whole declared fees:

- Passkey 1: 160,781 stroops.
- Passkey 2 and passkey 3: 50,543 stroops each.
- Ed25519 reference: 47,742 stroops.

Each of the four fits the current ceiling of its payer kind.
All four leave 9,900 stroops between the service inclusion bid and the recorded inclusion charge.
The remaining space below the whole fee ceiling differs between samples.
The comparison uses archived resource fees. It does not predict a current simulation or require a fee constant change.

Run `node scripts/analyze-fees.mjs --check` on the remote host to verify the recorded analysis against the archived XDR.

The figures above come from September 2026, before the rent rate reached the level of October.
The requests below ran on 4 October 2026, at 5,403 stroops per KB:

| Request | Transaction | Declared fee | Charged fee |
|---|---|---:|---:|
| Ed25519 redemption, lifetime 12 hours | `eda0746a2d3d8d750a8102ab457fac0103f4a732d10c3499037cbf69765e6d1b` | 49,334 | 28,746 |
| Passkey redemption to a merchant | `6b0aa630867be399ab0c0593972f2480cc7b5abc7d4b4b7011d8363336f752e0` | 52,035 | 31,650 |
| Passkey void | `229d80dd475cd09d9e9d0ac5bcd18f3859b69518f1b48c7ffa1c31a548b7bf35` | 47,546 | 27,166 |
| SEP-7 payment from a passkey account | `296372a17f604d3d1d579632007cea0005db7be9a9ddff5006f68f2c97a4f3cf` | 45,411 | 25,363 |
| Passkey account deployment | `31cfc855d19c813f4f63650863aae2233eb3bfe83e6f6988248b492f13b6238f` | 6,640,610 | 5,759,935 |

The ed25519 row ran through the evidence script, which bids 200,000 stroops for inclusion. Its declared fee here is its resource fee plus the service bid of 10,000, as in the table above.
The other rows ran through a copy of the service with raised ceilings, against the live network.
The passkey requests ran in Chrome with a virtual authenticator, which signs a smaller assertion than a phone.

## Evidence limits

Contract tests exercise real ed25519 signatures for the signature and nonce cases named above.
They do not establish passkey behavior on every device or browser.
The signature tests for SEP-7 do not prove that a person recognizes a deceptive domain.

The ledger tests do not establish a bound on estimator error.
The divisor `5.007` does not imply that the estimate can only run ahead.
Its error depends on clock behavior, elapsed time and actual ledger progress.

The [evidence guide](../README.md#the-evidence-archive) describes the archived transactions and their reproduction.
Testnet can reset, so a public transaction link is not a permanent record.
