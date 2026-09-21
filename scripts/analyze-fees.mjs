// Read archived transaction fees without a network request.
// Run npm run build first. Use --write to save the analysis or --check to compare it.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const NAME = 'redemption-fees';
const PRODUCER = 'scripts/analyze-fees.mjs';
const INPUTS = [
  { name: 'passkey-redeem-1', expectedScheme: 'secp256r1' },
  { name: 'passkey-redeem-2', expectedScheme: 'secp256r1' },
  { name: 'passkey-redeem-3', expectedScheme: 'secp256r1' },
  { name: '1a-success', expectedScheme: 'ed25519' },
];
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUTPUT_DIR = path.join(ROOT, 'scripts/out/fee-check');
const META_VERSION = 4;
const FEE_META_VERSION = 1;

if (process.argv.includes('--list')) {
  console.log(NAME);
  process.exit(0);
}
assert(process.argv.slice(2).every((arg) => ['--write', '--check'].includes(arg)), 'Unknown argument');
assert(!(process.argv.includes('--write') && process.argv.includes('--check')), 'Choose --write or --check');

const { Address, Networks, Transaction, xdr } = await import('@stellar/stellar-sdk');
const { readArchivedRow } = await import('@senet/evidence');
const { redeemFromEnvelope, signatureScheme } = await import('./evidence-set.mjs');
const { INCLUSION_FEE_STROOPS, MAX_REDEEM_FEE_STROOPS } = await import('../server/dist/src/constants.js');
const inputDir = path.join(ROOT, 'scripts/out/evidence');

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function measure({ name, expectedScheme }) {
  const row = readArchivedRow(inputDir, name);
  assert.equal(row.rpc.status, 'SUCCESS', `${name}: RPC status`);
  assert.equal(row.horizon?.successful, true, `${name}: Horizon status`);
  assert.equal(row.rpc.ledger, row.horizon.ledger, `${name}: ledger mismatch`);
  const envelope = xdr.TransactionEnvelope.fromXDR(row.rpc.envelopeXdr, 'base64');
  assert.equal(envelope.switch().name, 'envelopeTypeTx', `${name}: unsupported envelope`);
  const transaction = new Transaction(envelope, Networks.TESTNET);
  assert.equal(transaction.hash().toString('hex'), row.hash, `${name}: transaction hash mismatch`);
  const tx = envelope.v1().tx();
  assert.equal(tx.operations().length, 1, `${name}: expected one operation`);
  const operation = tx.operations()[0].body();
  assert.equal(operation.switch().name, 'invokeHostFunction', `${name}: expected a contract operation`);
  const { redeem } = redeemFromEnvelope(row.rpc.envelopeXdr);
  assert(redeem !== null, `${name}: expected a redemption`);
  assert.notEqual(redeem.payer, redeem.recipient, `${name}: a void is not a payment`);
  const invocation = operation.invokeHostFunctionOp();
  const contractId = Address.fromScAddress(invocation.hostFunction().invokeContract().contractAddress()).toString();
  assert.equal(contractId, row.contractId, `${name}: contract mismatch`);
  const payerEntries = invocation.auth().filter((entry) => {
    const credentials = entry.credentials();
    return credentials.switch().value === xdr.SorobanCredentialsType.sorobanCredentialsAddressV2().value
      && Address.fromScAddress(credentials.addressV2().address()).toString() === redeem.payer;
  });
  assert.equal(payerEntries.length, 1, `${name}: expected one ADDRESS_V2 authorization for the payer`);
  const payerCredentials = payerEntries[0].credentials().addressV2();
  const scheme = signatureScheme(payerCredentials.signature());
  assert.equal(scheme, expectedScheme, `${name}: unexpected payer signature scheme`);
  const data = tx.ext().sorobanData();
  const resources = data.resources();
  const meta = xdr.TransactionMeta.fromXDR(row.rpc.resultMetaXdr, 'base64');
  assert.equal(meta.switch(), META_VERSION, `${name}: unsupported metadata`);
  const soroban = meta.v4().sorobanMeta();
  assert(soroban !== null, `${name}: no Soroban metadata`);
  assert.equal(soroban.ext().switch(), FEE_META_VERSION, `${name}: no fee breakdown`);
  const fees = soroban.ext().v1();
  const declared = BigInt(tx.fee());
  const resource = BigInt(data.resourceFee().toString());
  const charged = BigInt(row.horizon.fee_charged);
  const result = xdr.TransactionResult.fromXDR(row.rpc.resultXdr, 'base64');
  assert.equal(result.result().switch().name, 'txSuccess', `${name}: failed XDR result`);
  assert.equal(BigInt(result.feeCharged().toString()), charged, `${name}: charged fee mismatch`);
  const nonRefundable = BigInt(fees.totalNonRefundableResourceFeeCharged().toString());
  const refundable = BigInt(fees.totalRefundableResourceFeeCharged().toString());
  const rent = BigInt(fees.rentFeeCharged().toString());
  const resourceCharged = nonRefundable + refundable;
  const inclusionCharged = charged - resourceCharged;
  const inclusionDeclared = declared - resource;
  assert(nonRefundable >= 0n && refundable >= rent && rent >= 0n, `${name}: invalid resource fees`);
  assert(resource >= resourceCharged, `${name}: resource charge exceeds declaration`);
  assert(inclusionCharged > 0n && inclusionDeclared >= inclusionCharged, `${name}: invalid inclusion fees`);
  const policyDeclared = resource + INCLUSION_FEE_STROOPS;
  assert(policyDeclared <= MAX_REDEEM_FEE_STROOPS, `${name}: service fee cap is too low`);
  assert(INCLUSION_FEE_STROOPS >= inclusionCharged, `${name}: service inclusion bid is too low`);
  return {
    name,
    hash: row.hash,
    ledger: row.rpc.ledger,
    createdAt: row.horizon.created_at,
    contractId,
    payer: redeem.payer,
    recipient: redeem.recipient,
    signatureScheme: scheme,
    credentialType: payerEntries[0].credentials().switch().name,
    inputSha256: sha256(readFileSync(path.join(inputDir, `${name}.json`))),
    declaredStroops: {
      total: declared.toString(),
      inclusion: inclusionDeclared.toString(),
      resource: resource.toString(),
    },
    chargedStroops: {
      total: charged.toString(),
      inclusion: inclusionCharged.toString(),
      nonRefundableResource: nonRefundable.toString(),
      refundableResource: refundable.toString(),
      rent: rent.toString(),
      eventsAndReturnValue: (refundable - rent).toString(),
    },
    unusedStroops: {
      resource: (resource - resourceCharged).toString(),
      inclusion: (inclusionDeclared - inclusionCharged).toString(),
    },
    declaredResources: {
      instructions: resources.instructions(),
      diskReadBytes: resources.diskReadBytes(),
      writeBytes: resources.writeBytes(),
      readOnlyEntries: resources.footprint().readOnly().length,
      readWriteEntries: resources.footprint().readWrite().length,
    },
    currentPolicy: {
      totalWithArchivedResourceStroops: policyDeclared.toString(),
      capHeadroomStroops: (MAX_REDEEM_FEE_STROOPS - policyDeclared).toString(),
      inclusionHeadroomStroops: (INCLUSION_FEE_STROOPS - inclusionCharged).toString(),
    },
  };
}

const measurements = INPUTS.map(measure);
const [first, second, third, reference] = measurements;
assert(first && second && third && reference, 'The analysis needs all four transactions');
assert.equal(second.chargedStroops.total, third.chargedStroops.total, 'Passkey reference fees differ');
const difference = (left, right) => (BigInt(left) - BigInt(right)).toString();
const analysis = {
  name: NAME,
  network: Networks.TESTNET,
  producedBy: PRODUCER,
  feeUnit: 'stroop',
  measurements,
  comparison: {
    passkeyReference: [second.name, third.name],
    ed25519Reference: reference.name,
    passkeyExtraChargedStroops: difference(second.chargedStroops.total, reference.chargedStroops.total),
    firstPasskeyExtraChargedStroops: difference(first.chargedStroops.total, second.chargedStroops.total),
    firstPasskeyExtraRentStroops: difference(first.chargedStroops.rent, second.chargedStroops.rent),
    firstPasskeyExtraNonRefundableStroops: difference(first.chargedStroops.nonRefundableResource, second.chargedStroops.nonRefundableResource),
    firstPasskeyExtraEventsStroops: difference(first.chargedStroops.eventsAndReturnValue, second.chargedStroops.eventsAndReturnValue),
  },
  servicePolicy: {
    inclusionBidStroops: INCLUSION_FEE_STROOPS.toString(),
    redeemCapStroops: MAX_REDEEM_FEE_STROOPS.toString(),
    note: 'The service adds the simulated resource fee to the inclusion bid. The cap limits the total declaration.',
  },
  limits: [
    'These archived transactions use different contract instances and ledger states. Their fees do not isolate the cost of the signature.',
    'The metadata records total rent. It does not assign that rent to a specific account entry.',
    'The policy comparison uses archived resource declarations. It does not simulate these transactions against current ledger state.',
  ],
};
const manifest = {
  network: Networks.TESTNET,
  producedBy: PRODUCER,
  rows: [{ name: NAME, producer: 'script', note: 'Declared and charged fees from four archived redemptions.' }],
};
for (const [file, value] of [[`${NAME}.json`, analysis], ['manifest.json', manifest]]) {
  const output = `${JSON.stringify(value, null, 2)}\n`;
  const destination = path.join(OUTPUT_DIR, file);
  if (process.argv.includes('--check')) {
    assert.equal(readFileSync(destination, 'utf8'), output, `${file}: recorded analysis differs`);
  } else if (process.argv.includes('--write')) {
    mkdirSync(OUTPUT_DIR, { recursive: true });
    writeFileSync(destination, output);
  } else if (file !== 'manifest.json') {
    console.log(output.trimEnd());
  }
}
if (process.argv.includes('--check') || process.argv.includes('--write')) console.log(`Fee analysis: ${OUTPUT_DIR}`);
