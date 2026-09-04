import type { IncomingMessage, ServerResponse } from 'node:http';

/**
 * The largest request body the service reads, in bytes.
 *
 * The largest thing a client sends is one authorization entry in base64. A
 * passkey entry measures about 1,100 characters. A limit of 64 KB therefore
 * sits far above any real request, and low enough to bound the memory that a
 * bad request takes.
 */
export const MAX_BODY_BYTES = 64 * 1024;

/** A failure that the service reports to the client, with a code to branch on. */
export class RequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'RequestError';
  }
}

/** A request whose body or query the service cannot use. */
export function badRequest(code: string, message: string): RequestError {
  return new RequestError(400, code, message);
}

/**
 * The client's address.
 *
 * The service binds to the loopback interface. The only thing that reaches it
 * is the web server in front of it, and that server sets `X-Forwarded-For`.
 * The header is trustworthy here in a way that it would not be on a public
 * socket. The first entry names the original client.
 */
export function clientAddress(request: IncomingMessage): string {
  const forwarded = request.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.length > 0) {
    const first = forwarded.split(',', 1)[0];
    if (first !== undefined) return first.trim();
  }
  return request.socket.remoteAddress ?? 'unknown';
}

/** Read a JSON object body, and refuse anything oversized or malformed. */
export async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    total += buffer.length;
    if (total > MAX_BODY_BYTES) {
      throw new RequestError(413, 'BODY_TOO_LARGE', 'the request body is too large');
    }
    chunks.push(buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (text === '') return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw badRequest('MALFORMED_BODY', 'the request body is not JSON');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw badRequest('MALFORMED_BODY', 'the request body must be a JSON object');
  }
  return { ...parsed };
}

/** Read a field that the route cannot work without. */
export function requireString(body: Record<string, unknown>, name: string): string {
  const value = body[name];
  if (typeof value !== 'string' || value === '') {
    throw badRequest('MISSING_FIELD', `${name} is required and it must be a string`);
  }
  return value;
}

/** Read a query parameter that the route cannot work without. */
export function requireParameter(url: URL, name: string): string {
  const value = url.searchParams.get(name);
  if (value === null || value === '') {
    throw badRequest('MISSING_PARAMETER', `${name} is required`);
  }
  return value;
}

/** Write one JSON reply. */
export function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  const text = JSON.stringify(payload);
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(text),
  });
  response.end(text);
}

/** Write one failure reply, in the shape that every failure takes. */
export function sendError(
  response: ServerResponse,
  status: number,
  code: string,
  message: string,
): void {
  sendJson(response, status, { error: { code, message } });
}
