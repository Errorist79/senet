import { API_BASE, RELEASE_PATH, REQUEST_TIMEOUT_MS } from './config.js';

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

/**
 * Which build this application is, as the deployment named it.
 *
 * The answer comes from the origin and not from the service. It describes the
 * files that a person runs, and not the chain that they run against. A
 * deployment that publishes no identity gives nothing, and the screen says so
 * rather than inventing a name.
 */
export async function fetchRelease(): Promise<string | null> {
  try {
    const response = await fetch(RELEASE_PATH);
    if (!response.ok) return null;
    const parsed: unknown = await response.json();
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const fields: Record<string, unknown> = { ...parsed };
    const commit = fields['commit'];
    return typeof commit === 'string' && commit !== '' ? commit : null;
  } catch {
    return null;
  }
}

/** What the chain published about one redemption, as the feed holds it. */
export interface Redemption {
  readonly voucher_id: string;
  readonly payer: string;
  readonly recipient: string;
  readonly amount: string;
  readonly tx_hash: string;
  readonly ledger: number;
  readonly ledger_closed_at: string;
  readonly event_id: string;
}

/**
 * Ask the feed what the chain published for one voucher.
 *
 * The answer comes from the contract's own event, and not from the reply that
 * the submission returned. A submission says that the network accepted a
 * transaction. Only the event says that the contract paid.
 */
export async function fetchRedemption(voucherId: string): Promise<Redemption | null> {
  const reply = await call(`/redemption?voucherId=${encodeURIComponent(voucherId)}`);
  const found = reply['redemption'];
  if (found === null || typeof found !== 'object' || Array.isArray(found)) return null;
  const fields: Record<string, unknown> = { ...found };
  const text = (key: string): string | null => {
    const value = fields[key];
    return typeof value === 'string' ? value : null;
  };
  const ledger = fields['ledger'];
  const voucher = text('voucher_id');
  const payer = text('payer');
  const recipient = text('recipient');
  const amount = text('amount');
  const txHash = text('tx_hash');
  const closedAt = text('ledger_closed_at');
  const eventId = text('event_id');
  if (
    voucher === null ||
    payer === null ||
    recipient === null ||
    amount === null ||
    txHash === null ||
    closedAt === null ||
    eventId === null ||
    typeof ledger !== 'number'
  ) {
    return null;
  }
  return {
    voucher_id: voucher,
    payer,
    recipient,
    amount,
    tx_hash: txHash,
    ledger,
    ledger_closed_at: closedAt,
    event_id: eventId,
  };
}

/** One signed payee-presented request, and the domain that vouches for it. */
export interface PayeeRequest {
  readonly uri: string;
  readonly originDomain: string;
}

/** Ask the service to sign a request for a payment to this account. */
export async function requestPayment(
  destination: string,
  amount: string,
  msg: string,
): Promise<PayeeRequest> {
  const body = msg === '' ? { destination, amount } : { destination, amount, msg };
  const fields = await call('/payee-request', body);
  return { uri: text(fields, 'uri'), originDomain: text(fields, 'originDomain') };
}
