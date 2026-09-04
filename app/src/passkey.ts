import { xdr } from '@stellar/stellar-sdk';
import { PasskeyKit, PasskeyClient } from 'passkey-kit';
import type { SignEntry } from '@senet/core';
import { APP_NAME } from './config.js';
import { submitDeploy } from './api.js';
import { getAccount, setAccount } from './store.js';
import type { StoredAccount, StoredChain } from './store.js';

/**
 * The passkey smart account.
 *
 * A passkey never leaves the authenticator, so no seed phrase exists anywhere
 * in this application. The account is a contract, and the passkey is the
 * signer that the contract accepts.
 */

let kit: PasskeyKit | null = null;

/**
 * Build the kit, once.
 *
 * The application names no relying party, so the browser takes the one that
 * served the page. A name that the application carried could differ from the
 * name in the address bar. A browser refuses a registration outright when the
 * two disagree, and a derived name cannot disagree with itself.
 *
 * A passkey still binds to the name that created it, so a deployment that
 * moves to another name leaves those accounts behind. The deployment is what
 * holds the name steady, and the application is not.
 */
export function getKit(chain: StoredChain): PasskeyKit {
  if (kit === null) {
    kit = new PasskeyKit({
      rpcUrl: chain.rpcUrl,
      networkPassphrase: chain.network,
      walletWasmHash: chain.walletWasmHash,
    });
  }
  return kit;
}

/**
 * Attach the stored account to the kit, with no network call.
 *
 * `connectWallet` checks ownership on chain, which is right when a passkey
 * arrives from an unknown source, and impossible with no network. A signature
 * needs only the account's contract interface, and the client carries that
 * interface already, so this function rebuilds the client from the stored
 * address. The network refuses an entry that another account's passkey signed,
 * so this shortcut moves nobody's funds.
 */
export function restoreAccount(chain: StoredChain): StoredAccount | null {
  const account = getAccount();
  if (account === null) return null;
  const built = getKit(chain);
  built.keyId = account.keyId;
  built.wallet = new PasskeyClient({
    contractId: account.contractId,
    networkPassphrase: chain.network,
    rpcUrl: chain.rpcUrl,
  });
  return account;
}

/**
 * Register a passkey, deploy its smart account, and remember the pair.
 *
 * The deployment needs the network. The registration produces a carrier
 * transaction with no usable source account. The service therefore takes the
 * host function and the authorization out of it, and it supplies a channel
 * account of its own. The service pays the fee, and it signs no authorization.
 */
export async function createAccount(
  chain: StoredChain,
  userName: string,
): Promise<StoredAccount> {
  const created = await getKit(chain).createWallet(APP_NAME, userName);
  const carrier = xdr.TransactionEnvelope.fromXDR(created.signedTx, 'base64');
  const operation = carrier.v1().tx().operations()[0]?.body().invokeHostFunctionOp();
  if (operation === undefined) {
    throw new Error('the registration produced no deployment to submit');
  }
  const submitted = await submitDeploy({
    contractId: created.contractId,
    hostFunction: operation.hostFunction().toXDR('base64'),
    auth: operation.auth().map((entry) => entry.toXDR('base64')),
  });
  if (submitted.outcome !== 'SUCCESS') {
    throw new Error(`the account deployment answered ${submitted.outcome}`);
  }
  const account: StoredAccount = {
    keyId: created.keyIdBase64,
    contractId: created.contractId,
    deployHash: submitted.hash,
  };
  setAccount(account);
  restoreAccount(chain);
  return account;
}

/**
 * The signer that the library asks for.
 *
 * The library never assumes how a payer signs. This is the passkey side of
 * that seam, and the deadline reaches the authenticator from the one value
 * that the library computed.
 */
export function passkeySigner(chain: StoredChain): SignEntry {
  return async (entry, validUntilLedgerSeq) => {
    const built = getKit(chain);
    if (built.wallet === undefined) restoreAccount(chain);
    return built.signAuthEntry(entry, undefined, { expiration: validUntilLedgerSeq });
  };
}
