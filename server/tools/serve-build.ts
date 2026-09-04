import { createReadStream, existsSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';

/**
 * Serve the built application, for a check that drives a browser.
 *
 * The real deployment publishes these files through a web server. This exists
 * so that one process can put the application and the service on one origin.
 * Nothing in the product serves a static file.
 */

/** The kinds of file that the build publishes, and their media types. */
const TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json',
};

/**
 * Answer one request for a file.
 *
 * The path comes from the browser, so the reader refuses anything that leaves
 * the build directory. A path that names no file becomes the shell, which is
 * what the web server in front of the real deployment also does.
 */
export function serveBuiltApplication(
  dist: string,
  request: IncomingMessage,
  response: ServerResponse,
): void {
  const path = new URL(request.url ?? '/', 'http://localhost').pathname;
  const wanted = path === '/' ? '/index.html' : path;
  const file = resolve(join(dist, wanted));
  const safe = file.startsWith(`${dist}/`) && existsSync(file) && statSync(file).isFile();
  const chosen = safe ? file : join(dist, 'index.html');
  const dot = chosen.lastIndexOf('.');
  response.writeHead(200, {
    'Content-Type': TYPES[chosen.slice(dot)] ?? 'application/octet-stream',
    'Cache-Control': 'no-store',
    'Service-Worker-Allowed': '/',
  });
  createReadStream(chosen).pipe(response);
}
