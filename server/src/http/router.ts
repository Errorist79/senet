import type { IncomingMessage, RequestListener, ServerResponse } from 'node:http';
import { rpc } from '@stellar/stellar-sdk';
import type { ServerConfig } from '../config.js';
import type { FeePayer } from '../feepayer.js';
import { errorText } from '../outcomes.js';
import { RequestBudget } from './budget.js';
import { balanceRoute, configRoute, ledgerRoute, statusRoute } from './read.js';
import { acceptRedemptionRoute, feedRoute } from './redemptions.js';
import { deployRoute, fundRoute } from './account.js';
import { redeemRoute } from './redeem.js';
import {
  RequestError,
  clientAddress,
  readJsonBody,
  sendError,
  sendJson,
} from './transport.js';

/** The prefix that every route of this service sits under. */
const API_PREFIX = '/api';

/** Everything that a route reads. */
export interface RouteContext {
  readonly config: ServerConfig;
  readonly feePayer: FeePayer;
  readonly server: rpc.Server;
}

/** One route: it reads the context, the body and the query, and it answers. */
type Route = (
  context: RouteContext,
  body: Record<string, unknown>,
  url: URL,
) => Promise<unknown> | unknown;

/**
 * The routes, by method and path.
 *
 * Each concern is its own module. This table is the only place that maps a
 * request to one of them.
 */
const ROUTES: Readonly<Record<string, Route>> = {
  'GET /config': (context) => configRoute(context),
  'GET /ledger': (context) => ledgerRoute(context),
  'GET /balance': (context, _body, url) => balanceRoute(context, url),
  'GET /status': (context) => statusRoute(context),
  'POST /redeem': (context, body) => redeemRoute(context, body),
  'POST /deploy': (context, body) => deployRoute(context, body),
  'POST /fund': (context, body) => fundRoute(context, body),
  'GET /redemption': (context, _body, url) => feedRoute(context, url),
  'POST /redemption': (context, body) => acceptRedemptionRoute(context, body),
};

/**
 * The routes that cost a network fee.
 *
 * These carry the tighter budget, because each one spends from a channel
 * account.
 */
const SPENDING_ROUTES: ReadonlySet<string> = new Set([
  'POST /redeem',
  'POST /deploy',
  'POST /fund',
  // This one spends no fee. It reads the chain once per request, which is a
  // cost that a caller can repeat, so it carries the tighter budget.
  'POST /redemption',
]);

/**
 * Build the request handler.
 *
 * The caller creates the server, so one process can put the built application
 * on the same origin without this module knowing about static files.
 */
export function createApiHandler(context: RouteContext): RequestListener {
  const budget = new RequestBudget();
  return (request: IncomingMessage, response: ServerResponse) => {
    void handle(context, budget, request, response);
  };
}

/** Answer one request, and never let a failure escape as a crash. */
async function handle(
  context: RouteContext,
  budget: RequestBudget,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
  if (!url.pathname.startsWith(`${API_PREFIX}/`)) {
    sendError(response, 404, 'NOT_FOUND', `${url.pathname} is not a route of this service`);
    return;
  }
  const key = `${request.method ?? 'GET'} ${url.pathname.slice(API_PREFIX.length)}`;
  const route = ROUTES[key];
  if (route === undefined) {
    sendError(response, 404, 'NOT_FOUND', `${key} is not a route of this service`);
    return;
  }

  const allowance = budget.take(clientAddress(request), SPENDING_ROUTES.has(key));
  if (!allowance.allowed) {
    const seconds = Math.ceil(allowance.resetMs / 1000);
    response.setHeader('Retry-After', String(seconds));
    sendError(
      response,
      429,
      'TOO_MANY_REQUESTS',
      `this route allows ${allowance.limit} requests per minute. Wait ${seconds} seconds.`,
    );
    return;
  }

  try {
    const body = request.method === 'POST' ? await readJsonBody(request) : {};
    sendJson(response, 200, await route(context, body, url));
  } catch (caught) {
    if (caught instanceof RequestError) {
      sendError(response, caught.status, caught.code, caught.message);
      return;
    }
    // Anything else is a failure of this service, not of the request.
    console.error(`${key} failed: ${errorText(caught)}`);
    sendError(response, 500, 'SERVICE_FAILED', 'the service could not answer this request');
  }
}
