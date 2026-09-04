import { API_BASE, REQUEST_TIMEOUT_MS } from './config.js';

/**
 * The client for the service.
 *
 * Every reply arrives as a value of unknown shape, so each reader inspects the
 * fields that it uses. The application never assumes a shape that it did not
 * check.
 */

/** A refusal that the service reported, with the code that names it. */
export class ServiceError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ServiceError';
  }
}

/** The chain identities that the service names. */
export interface ChainConfig {
  readonly network: string;
  readonly networkTag: string;
  readonly contractId: string;
  readonly tokenId: string;
  readonly rpcUrl: string;
  readonly walletWasmHash: string;
}

/** What one account deployment produced. */
export interface DeployReply {
  readonly outcome: string;
  readonly hash: string | null;
  readonly contractId: string;
}

/** What one address holds. */
export interface BalanceReply {
  readonly address: string;
  readonly balanceStroops: string | null;
  readonly source: string;
}

/** The latest ledger that the service saw. */
export interface Ledger {
  readonly sequence: number;
  readonly readAtIso: string;
}

/** What one redeem produced. */
export interface RedeemReply {
  readonly outcome: string;
  readonly stage: string;
  readonly hash: string | null;
  readonly ledger: number | null;
  readonly feeChargedStroops: string | null;
  readonly voucherId: string;
  readonly amountStroops: string;
  readonly payer: string;
  readonly recipient: string;
  readonly detail: string;
}

/** A plain object, whose values stay unknown until a reader checks one. */
function asObject(value: unknown, what: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ServiceError('MALFORMED_REPLY', `the service sent no ${what}`);
  }
  return { ...value };
}

function text(fields: Record<string, unknown>, key: string): string {
  const value = fields[key];
  if (typeof value !== 'string') {
    throw new ServiceError('MALFORMED_REPLY', `the reply carries no ${key}`);
  }
  return value;
}

function textOrNothing(fields: Record<string, unknown>, key: string): string | null {
  const value = fields[key];
  return typeof value === 'string' ? value : null;
}

function count(fields: Record<string, unknown>, key: string): number {
  const value = fields[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ServiceError('MALFORMED_REPLY', `the reply carries no ${key}`);
  }
  return value;
}

function countOrNothing(fields: Record<string, unknown>, key: string): number | null {
  const value = fields[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Turn a failure reply into a typed error. */
function refusal(fields: Record<string, unknown>, status: number): ServiceError {
  const error = fields['error'];
  if (error !== null && typeof error === 'object') {
    const inner: Record<string, unknown> = { ...error };
    const code = inner['code'];
    const message = inner['message'];
    if (typeof code === 'string' && typeof message === 'string') {
      return new ServiceError(code, message);
    }
  }
  return new ServiceError('SERVICE_FAILED', `the service answered ${status}`);
}

/** Call the service, and turn every failure into a `ServiceError`. */
async function call(path: string, body?: unknown): Promise<Record<string, unknown>> {
  const request: RequestInit =
    body === undefined
      ? { method: 'GET', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) }
      : {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        };
  let response: Response;
  try {
    response = await fetch(`${API_BASE}${path}`, request);
  } catch {
    throw new ServiceError('NO_NETWORK', 'the application could not reach the service');
  }
  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    throw new ServiceError('MALFORMED_REPLY', 'the service sent no JSON');
  }
  const fields = asObject(parsed, 'reply');
  if (!response.ok) throw refusal(fields, response.status);
  return fields;
}

/** Read the chain identities. */
export async function fetchConfig(): Promise<ChainConfig> {
  const fields = await call('/config');
  return {
    network: text(fields, 'network'),
    networkTag: text(fields, 'networkTag'),
    contractId: text(fields, 'contractId'),
    tokenId: text(fields, 'tokenId'),
    rpcUrl: text(fields, 'rpcUrl'),
    walletWasmHash: text(fields, 'walletWasmHash'),
  };
}

/** Submit an account deployment that the registration already authorized. */
export async function submitDeploy(request: {
  contractId: string;
  hostFunction: string;
  auth: readonly string[];
}): Promise<DeployReply> {
  const fields = await call('/deploy', request);
  return {
    outcome: text(fields, 'outcome'),
    hash: textOrNothing(fields, 'hash'),
    contractId: text(fields, 'contractId'),
  };
}

/** Ask the test network to fund an address, and wait for the funds. */
export async function fundAddress(address: string): Promise<string | null> {
  const fields = await call('/fund', { address });
  return textOrNothing(fields, 'balanceStroops');
}

/** Read what one address holds. */
export async function fetchBalance(address: string): Promise<BalanceReply> {
  const fields = await call(`/balance?address=${encodeURIComponent(address)}`);
  return {
    address: text(fields, 'address'),
    balanceStroops: textOrNothing(fields, 'balanceStroops'),
    source: text(fields, 'source'),
  };
}

/** Read the latest ledger. */
export async function fetchLedger(): Promise<Ledger> {
  const fields = await call('/ledger');
  return { sequence: count(fields, 'sequence'), readAtIso: text(fields, 'readAtIso') };
}

/** Submit one voucher, and name the recipient. */
export async function submitRedeem(entryXdr: string, recipient: string): Promise<RedeemReply> {
  const fields = await call('/redeem', { entryXdr, recipient });
  return {
    outcome: text(fields, 'outcome'),
    stage: text(fields, 'stage'),
    hash: textOrNothing(fields, 'hash'),
    ledger: countOrNothing(fields, 'ledger'),
    feeChargedStroops: textOrNothing(fields, 'feeChargedStroops'),
    voucherId: text(fields, 'voucherId'),
    amountStroops: text(fields, 'amountStroops'),
    payer: text(fields, 'payer'),
    recipient: text(fields, 'recipient'),
    detail: textOrNothing(fields, 'detail') ?? '',
  };
}
