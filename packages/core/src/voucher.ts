import {
  Address,
  authorizeEntry,
  Keypair,
  nativeToScVal,
  scValToNative,
  xdr,
} from '@stellar/stellar-sdk';
import type { VoucherConfig } from './config.js';
import { VoucherFormatError } from './errors.js';
import { assertAddressV2, assertDeadlinesAligned } from './invariants.js';

/** The contract function that a voucher authorizes. */
const REDEEM_FUNCTION = 'redeem';

/** The token function that moves the funds inside a redeem. */
const TRANSFER_FUNCTION = 'transfer';

/** The signed arguments of `redeem`, which exclude the recipient. */
const SIGNED_REDEEM_ARG_COUNT = 3;

/**
 * The terms that a payer signs.
 *
 * The recipient is absent on purpose. The payer authorizes an amount, an
 * identifier and a deadline, and the party that scans the code chooses who
 * receives the funds.
 */
export interface Voucher {
  /** The account that holds the funds and signs the entry. */
  readonly payer: string;
  /** Stroops of the configured token. */
  readonly amount: bigint;
  /** The identifier that a merchant reads back from the redeem event. */
  readonly voucherId: bigint;
  /** The ledger after which the contract refuses the redeem. */
  readonly expireAt: number;
}

/** A voucher read back out of an authorization entry. */
export interface DecodedVoucher extends Voucher {
  /** The voucher contract that the entry authorizes. */
  readonly contractId: string;
  /** The host nonce that makes the voucher single use. */
  readonly nonce: bigint;
  /** The host deadline, which always equals `expireAt`. */
  readonly signatureExpirationLedger: number;
  /** The entry that the terms came from. */
  readonly entry: xdr.SorobanAuthorizationEntry;
}

/**
 * Sign one authorization entry.
 *
 * The library never assumes how a payer signs. An ed25519 account and a
 * passkey smart account produce the same entry through different paths. The
 * signer is therefore a function that the caller supplies.
 */
export type SignEntry = (
  entry: xdr.SorobanAuthorizationEntry,
  validUntilLedgerSeq: number,
) => Promise<xdr.SorobanAuthorizationEntry>;

/** The arguments of a `redeem` call, in declaration order. */
export function redeemArgs(voucher: Voucher, recipient: string): xdr.ScVal[] {
  return [
    new Address(voucher.payer).toScVal(),
    nativeToScVal(voucher.amount, { type: 'i128' }),
    nativeToScVal(voucher.voucherId, { type: 'u64' }),
    nativeToScVal(voucher.expireAt, { type: 'u32' }),
    new Address(recipient).toScVal(),
  ];
}

/** One authorized contract call. */
function contractFn(
  contractId: string,
  name: string,
  args: xdr.ScVal[],
): xdr.SorobanAuthorizedFunction {
  return xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
    new xdr.InvokeContractArgs({
      contractAddress: new Address(contractId).toScAddress(),
      functionName: name,
      args,
    }),
  );
}

/**
 * The invocation tree that `redeem` demands.
 *
 * The root call carries the amount, the identifier and the deadline. Its one
 * sub-invocation is the token transfer from the payer to the contract. The
 * recipient appears in neither, which is what lets the submitter choose it.
 */
export function redeemInvocation(
  config: VoucherConfig,
  voucher: Voucher,
): xdr.SorobanAuthorizedInvocation {
  return new xdr.SorobanAuthorizedInvocation({
    function: contractFn(config.contractId, REDEEM_FUNCTION, [
      nativeToScVal(voucher.amount, { type: 'i128' }),
      nativeToScVal(voucher.voucherId, { type: 'u64' }),
      nativeToScVal(voucher.expireAt, { type: 'u32' }),
    ]),
    subInvocations: [
      new xdr.SorobanAuthorizedInvocation({
        function: contractFn(config.tokenId, TRANSFER_FUNCTION, [
          new Address(voucher.payer).toScVal(),
          new Address(config.contractId).toScVal(),
          nativeToScVal(voucher.amount, { type: 'i128' }),
        ]),
        subInvocations: [],
      }),
    ],
  });
}

/**
 * Build an unsigned authorization entry for one voucher.
 *
 * The call makes no network request. Simulation in recording mode leaves the
 * signature slot as `SCV_VOID`. This function uses the same placeholder, so
 * its bytes stay identical to the bytes that simulation produces.
 *
 * `voucher.expireAt` fills both the contract argument and the host field
 * `signature_expiration_ledger`, because the two must always hold one value.
 */
export function buildVoucherEntry(
  config: VoucherConfig,
  voucher: Voucher,
  nonce: bigint,
): xdr.SorobanAuthorizationEntry {
  return new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsAddressV2(
      new xdr.SorobanAddressCredentials({
        address: new Address(voucher.payer).toScAddress(),
        nonce: new xdr.Int64(nonce),
        signatureExpirationLedger: voucher.expireAt,
        signature: xdr.ScVal.scvVoid(),
      }),
    ),
    rootInvocation: redeemInvocation(config, voucher),
  });
}

/**
 * Build one voucher and sign it.
 *
 * This is the path that an application takes. The deadline reaches the signer
 * from `voucher.expireAt` and from nowhere else. A caller therefore cannot
 * sign an entry to a ledger that the contract does not enforce.
 */
export async function signVoucher(
  config: VoucherConfig,
  voucher: Voucher,
  nonce: bigint,
  signEntry: SignEntry,
): Promise<xdr.SorobanAuthorizationEntry> {
  const signed = await signEntry(buildVoucherEntry(config, voucher, nonce), voucher.expireAt);
  assertAddressV2(config, signed);
  assertDeadlinesAligned(signed, voucher.expireAt);
  return signed;
}

/**
 * A signer that holds an ed25519 secret key.
 *
 * This is the one implementation that the library ships. It serves the fee-payer
 * tests and the command line drivers. An application that uses a passkey
 * account supplies its own signer of the same type.
 */
export function ed25519Signer(config: VoucherConfig, secret: string): SignEntry {
  const keypair = Keypair.fromSecret(secret);
  return (entry, validUntilLedgerSeq) =>
    authorizeEntry(entry, keypair, validUntilLedgerSeq, config.network);
}

/** Read a whole number out of a decoded `ScVal`. */
function toBigInt(value: unknown, field: string): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isSafeInteger(value)) return BigInt(value);
  throw new VoucherFormatError(`the entry carries no whole number for ${field}`);
}

/** Read a ledger sequence out of a decoded `ScVal`. */
function toLedger(value: unknown, field: string): number {
  const found = toBigInt(value, field);
  if (found < 0n || found > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new VoucherFormatError(`${field} is ${found}, which is not a ledger sequence`);
  }
  return Number(found);
}

/**
 * Read the voucher terms back out of an authorization entry.
 *
 * The payload carries the entry and nothing else. The entry already holds
 * every field that a merchant needs, and the signature covers each of those
 * fields. A second copy beside the entry adds only bytes and a way to
 * disagree.
 *
 * The two invariants run here, so that no caller can read an entry and skip
 * them: the credentials must be CAP-71 address bound, and the two deadlines
 * must hold one value.
 */
export function readVoucher(
  config: VoucherConfig,
  entry: xdr.SorobanAuthorizationEntry,
): DecodedVoucher {
  assertAddressV2(config, entry);
  const credentials = entry.credentials().addressV2();

  const invoked = entry.rootInvocation().function();
  if (invoked.switch().name !== 'sorobanAuthorizedFunctionTypeContractFn') {
    throw new VoucherFormatError('the entry does not authorize a contract call');
  }
  const call = invoked.contractFn();
  const name = call.functionName().toString();
  if (name !== REDEEM_FUNCTION) {
    throw new VoucherFormatError(
      `the entry authorizes ${name}, and a voucher authorizes ${REDEEM_FUNCTION}`,
    );
  }
  const contractId = Address.fromScAddress(call.contractAddress()).toString();
  if (contractId !== config.contractId) {
    throw new VoucherFormatError(
      `the entry authorizes contract ${contractId}, and this reader is ` +
        `configured for ${config.contractId}`,
    );
  }

  const args = call.args();
  if (args.length !== SIGNED_REDEEM_ARG_COUNT) {
    throw new VoucherFormatError(
      `${REDEEM_FUNCTION} carries ${SIGNED_REDEEM_ARG_COUNT} signed arguments and ` +
        `the entry carries ${args.length}`,
    );
  }
  const [amountArg, voucherIdArg, expireAtArg] = args;
  if (amountArg === undefined || voucherIdArg === undefined || expireAtArg === undefined) {
    throw new VoucherFormatError(`${REDEEM_FUNCTION} carries an empty argument`);
  }

  const expireAt = toLedger(scValToNative(expireAtArg), 'expire_at');
  const signatureExpirationLedger = assertDeadlinesAligned(entry, expireAt);

  return {
    payer: Address.fromScAddress(credentials.address()).toString(),
    amount: toBigInt(scValToNative(amountArg), 'amount'),
    voucherId: toBigInt(scValToNative(voucherIdArg), 'voucher_id'),
    expireAt,
    contractId,
    nonce: BigInt(credentials.nonce().toString()),
    signatureExpirationLedger,
    entry,
  };
}

/**
 * A random 64-bit nonce for one authorization entry.
 *
 * The host stores the nonce as a temporary ledger entry keyed by the address
 * and the nonce, and it refuses a second use. That is what makes a voucher
 * single use. The value only has to be unique, so it comes from the platform
 * random number generator.
 */
export function randomNonce(): bigint {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  let hex = '';
  for (const byte of bytes) hex += byte.toString(16).padStart(2, '0');
  return BigInt.asIntN(64, BigInt(`0x${hex}`));
}

/**
 * A random voucher identifier.
 *
 * The contract indexes its `Redeemed` event by `voucher_id`, so it is the one
 * reconciliation handle that a payer and a merchant share. It is a `u64`, and
 * it must not collide across the vouchers that one payer holds at once.
 */
export function randomVoucherId(): bigint {
  return BigInt.asUintN(64, randomNonce());
}
