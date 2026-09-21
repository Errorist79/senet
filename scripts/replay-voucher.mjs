// Record an on-chain refusal for the exact signed entry of a redeemed voucher.
// The signature must still be live, so replay it before its expiration ledger.

import fs from 'node:fs';

export const PRODUCED_ROWS = Object.freeze(['voucher-replay']);
if (process.argv.includes('--list')) {
  console.log(PRODUCED_ROWS.join('\n'));
  process.exit(0);
}

const [sourceFile, outputDirectory] = process.argv.slice(2);
if (!sourceFile || !outputDirectory || process.argv.length !== 4) {
  throw new Error('Use: node scripts/replay-voucher.mjs SUCCESSFUL-ARCHIVE.json NEW-OUTPUT-DIRECTORY');
}
if (fs.existsSync(outputDirectory)) throw new Error('Choose a new output directory.');
const { ENDPOINTS, loadEnv, requireEnv, archiveRow, refusalReasons, writeManifest } =
  await import('./evidence-set.mjs');
const { Address, Keypair, Networks, TransactionBuilder, rpc, xdr } = await import('@stellar/stellar-sdk');
const { TX_TIMEOUT_SECONDS, nativeTokenId, readVoucher } = await import('@senet/core');
const { POLL_ATTEMPTS, POLL_INTERVAL_MS } = await import('@senet/server');
loadEnv();
const original = JSON.parse(fs.readFileSync(sourceFile, 'utf8'));
if (original?.horizon?.successful !== true || typeof original.rpc?.envelopeXdr !== 'string') {
  throw new Error('The source must be an archived successful transaction.');
}
const envelope = xdr.TransactionEnvelope.fromXDR(original.rpc.envelopeXdr, 'base64');
if (envelope.switch().name !== 'envelopeTypeTx') throw new Error('The source must contain a V1 transaction envelope.');
const originalHash = TransactionBuilder.fromXDR(envelope, Networks.TESTNET).hash().toString('hex');
if (originalHash !== original.hash) throw new Error('The source hash does not match the archived envelope on testnet.');
const transaction = envelope.v1().tx();
const operations = transaction.operations();
if (operations.length !== 1 || operations[0].body().switch().name !== 'invokeHostFunction') {
  throw new Error('The source must contain one contract invocation operation.');
}
const operation = operations[0];
const invocation = operation.body().invokeHostFunctionOp();
if (invocation.hostFunction().switch().name !== 'hostFunctionTypeInvokeContract') {
  throw new Error('The source must call a contract function.');
}
const call = invocation.hostFunction().invokeContract();
if (call.functionName().toString() !== 'redeem' || invocation.auth().length !== 1) {
  throw new Error('The source must contain one voucher authorization for redeem.');
}
const contractId = Address.fromScAddress(call.contractAddress()).toString();
if (original.contractId !== contractId) throw new Error('The archived contract does not match the transaction.');
const entry = invocation.auth()[0];
const voucher = readVoucher({ network: Networks.TESTNET, contractId, tokenId: nativeTokenId(Networks.TESTNET) }, entry);
if (transaction.ext().switch() !== 1) throw new Error('The source transaction has no Soroban resource data.');
const server = new rpc.Server(ENDPOINTS.rpcUrl);
const latest = await server.getLatestLedger();
if (voucher.expireAt <= latest.sequence) {
  throw new Error('The signed voucher expired. Redeem a new voucher and replay it before expiration.');
}
const live = await fetch(`${ENDPOINTS.horizonUrl}/transactions/${original.hash}`);
if (!live.ok || (await live.json()).successful !== true) throw new Error('Horizon no longer confirms the source transaction.');
const submitter = Keypair.fromSecret(requireEnv('SUBMITTER_SECRET'));
const source = await server.getAccount(submitter.publicKey());
const replay = new TransactionBuilder(source, {
  fee: transaction.fee().toString(), networkPassphrase: Networks.TESTNET,
}).addOperation(operation)
  .setSorobanData(transaction.ext().sorobanData())
  .setTimeout(TX_TIMEOUT_SECONDS).build();
const replayEntry = replay.toEnvelope().v1().tx().operations()[0].body().invokeHostFunctionOp().auth()[0];
if (replayEntry.toXDR('base64') !== entry.toXDR('base64')) throw new Error('The signed entry changed.');
replay.sign(submitter);
const sent = await server.sendTransaction(replay);
if (sent.status === 'ERROR') throw new Error('The replay failed before ledger application.');
const settled = await server.pollTransaction(sent.hash, {
  attempts: POLL_ATTEMPTS, sleepStrategy: () => POLL_INTERVAL_MS,
});
const row = {
  name: PRODUCED_ROWS[0], hash: sent.hash, producer: 'script',
  note: 'A new transaction reuses the exact signed entry from a successful redemption. The network refuses the consumed nonce.',
};
const manifest = {
  network: Networks.TESTNET, contractId, producedBy: 'scripts/replay-voucher.mjs',
  producedAt: new Date().toISOString(), sourceHash: original.hash, rows: [row], complete: false,
};
writeManifest(outputDirectory, manifest);
const archived = await archiveRow(outputDirectory, row, contractId, ENDPOINTS);
if (!archived.rpc.resultMetaXdr || archived.horizon?.successful !== false || settled.status !== 'FAILED') {
  throw new Error('The archived replay does not prove an on-chain refusal.');
}
const reasons = await refusalReasons(sent.hash);
if (!reasons.some((reason) => reason.includes('nonce already exists for address'))) {
  throw new Error('The network did not refuse this replay for a consumed nonce.');
}
manifest.complete = true;
writeManifest(outputDirectory, manifest);
console.log(`Same signed entry: ${original.hash}`);
console.log(`On-chain replay refused: ${sent.hash}`);
console.log(`Archive: ${outputDirectory}`);
