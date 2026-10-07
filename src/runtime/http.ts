import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import { createMcpHandler } from '@modelcontextprotocol/server';
import type { Clock, Connection } from '../contracts.js';
import { createServerFactory } from './server.js';

export const MAX_HTTP_BODY_BYTES = 2 * 1024 * 1024;
export const HTTP_LIMITS = Object.freeze({
  maxConnections: 64, maxExchanges: 32, maxHeaderBytes: 8192, maxHeaders: 64,
  headerTimeoutMs: 5000, bodyTimeoutMs: 10000, socketTimeoutMs: 65000,
});
export interface HttpOptions { host: string; port: number }
export interface HttpServerHandle {
  readonly address: AddressInfo;
  readonly url: URL;
  close(): Promise<void>;
}
function validate(options: HttpOptions, ephemeral: boolean): void {
  if (!['127.0.0.1', '::1'].includes(options.host) || !Number.isInteger(options.port) ||
    options.port < (ephemeral ? 0 : 1) || options.port > 65535) throw new Error('Invalid HTTP configuration.');
}

/** No file loading, hostname resolution, public binds, or credential inspection. */
export function readHttpOptions(env: Readonly<Record<string, string | undefined>>): HttpOptions {
  const text = env.YNAB_PORT ?? '3000';
  if (!/^[1-9][0-9]*$/.test(text)) throw new Error('Invalid HTTP configuration.');
  const options = { host: env.YNAB_HOST ?? '127.0.0.1', port: Number(text) };
  validate(options, false); return options;
}

function reject(req: IncomingMessage, res: ServerResponse, status: number): void {
  // Close rejected exchanges instead of draining arbitrarily large or slow request bodies.
  res.writeHead(status, { 'Content-Type': 'text/plain', 'Connection': 'close' });
  res.end('HTTP request rejected.\n'); req.resume();
}

/** Validate raw headers BEFORE constructing a URL or coalescing headers with Headers. */
function checkHeaders(req: IncomingMessage, authority: string): number | undefined {
  if (req.rawHeaders.length > HTTP_LIMITS.maxHeaders * 2) return 400;
  const seen = new Set<string>();
  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    const name = req.rawHeaders[i]!.toLowerCase();
    if (seen.has(name)) return 400;
    seen.add(name);
  }
  if (req.headers.host !== authority) return 403;
  if (req.headers.origin !== undefined && req.headers.origin !== `http://${authority}`) return 403;
  return undefined;
}

/** Resolves only after the listener is ready. Port zero is reserved for injected offline tests. */
export async function startHttp(connection: Connection, options: HttpOptions = readHttpOptions(process.env), clock?: Clock): Promise<HttpServerHandle> {
  validate(options, true);
  const handler = createMcpHandler(createServerFactory(connection, clock), {
    legacy: 'stateless', maxRequestBodySize: MAX_HTTP_BODY_BYTES,
    // Never report SDK exceptions, request arguments, credentials, or financial data.
    onerror: () => {},
  });
  const exchanges = new Set<AbortController>();
  const sockets = new Set<Socket>();
  let closing = false;
  let authority = '';
  const serve = async (req: IncomingMessage, res: ServerResponse) => {
    if (closing || exchanges.size >= HTTP_LIMITS.maxExchanges) { reject(req, res, 503); return; }
    const status = checkHeaders(req, authority);
    if (status) { reject(req, res, status); return; }
    // Only the literal origin-form route is supported; no absolute URLs or normalized aliases.
    if (req.url !== '/mcp') { reject(req, res, 404); return; }
    if (req.method !== 'POST') { reject(req, res, 405); return; }
    const size = req.headers['content-length'];
    if (size !== undefined && (!/^[0-9]+$/.test(size) || Number(size) > MAX_HTTP_BODY_BYTES)) {
      reject(req, res, 413); return;
    }
    const controller = new AbortController(); exchanges.add(controller);
    const abort = () => controller.abort();
    const disconnected = () => { if (!res.writableFinished) abort(); };
    req.once('aborted', abort); res.once('close', disconnected);
    // Fixed upload deadline, not an activity-reset timer. A trickle cannot hold a slot forever.
    const uploadTimer = setTimeout(() => { controller.abort(); req.destroy(); }, HTTP_LIMITS.bodyTimeoutMs);
    try {
      // Buffer raw bytes under a hard limit. Never pass an unbounded parsedBody to the SDK.
      // destroyOnReturn:false lets us send a 413 before Node closes an oversized request socket.
      // A fixed buffer also bounds allocation count for clients that send many tiny chunks.
      const body = Buffer.alloc(size === undefined ? MAX_HTTP_BODY_BYTES : Number(size));
      let length = 0;
      for await (const chunk of req.iterator({ destroyOnReturn: false })) {
        length += chunk.length;
        if (length > MAX_HTTP_BODY_BYTES) { reject(req, res, 413); return; }
        if (controller.signal.aborted) return;
        chunk.copy(body, length - chunk.length);
      }
      clearTimeout(uploadTimer);
      if (!req.complete || controller.signal.aborted) return;
      const headers = new Headers();
      for (let i = 0; i < req.rawHeaders.length; i += 2) headers.set(req.rawHeaders[i]!, req.rawHeaders[i + 1]!);
      // Authority is locally constructed and headers already passed exact checks. Forwarding is ignored.
      const request = new Request(`http://${authority}/mcp`, {
        method: 'POST', headers, body: body.subarray(0, length), signal: controller.signal,
      });
      const response = await handler.fetch(request);
      if (controller.signal.aborted || res.destroyed) { await response.body?.cancel(); return; }
      res.writeHead(response.status, Object.fromEntries(response.headers));
      if (!response.body) res.end();
      // Node and DOM declarations differ, but this is the same native Web stream.
      else await pipeline(Readable.fromWeb(response.body as unknown as NodeReadableStream<Uint8Array>), res, { signal: controller.signal });
    } catch {
      if (!res.destroyed && !res.headersSent) reject(req, res, 400);
      else if (!res.writableFinished) res.destroy();
    } finally {
      clearTimeout(uploadTimer);
      controller.abort(); exchanges.delete(controller);
      req.off('aborted', abort); res.off('close', disconnected);
    }
  };
  const server = createHttpServer({
    maxHeaderSize: HTTP_LIMITS.maxHeaderBytes,
    requestTimeout: HTTP_LIMITS.bodyTimeoutMs + HTTP_LIMITS.headerTimeoutMs,
    headersTimeout: HTTP_LIMITS.headerTimeoutMs, connectionsCheckingInterval: 500,
    keepAliveTimeout: 5000,
  }, (req, res) => { void serve(req, res); });
  server.maxConnections = HTTP_LIMITS.maxConnections;
  server.maxRequestsPerSocket = 100;
  // Do not silently truncate headers: inspect every bounded raw header for duplicates.
  server.maxHeadersCount = 0;
  // Also bounds stalled response readers; active tool requests retain their 60-second deadline.
  server.setTimeout(HTTP_LIMITS.socketTimeoutMs, socket => socket.destroy());
  server.on('connection', socket => {
    sockets.add(socket); socket.once('close', () => sockets.delete(socket));
  });
  // Node rejects malformed framing/header syntax before our request callback. Do not expose parser errors.
  server.on('clientError', (_error, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n', () => socket.destroy());
    else socket.destroy();
  });
  let closePromise: Promise<void> | undefined;
  const close = (): Promise<void> => closePromise ??= (async () => {
    closing = true;
    // Stop accepting first. Then cancel both modern and legacy exchanges, including partial uploads.
    const stopped = new Promise<void>(resolve => server.close(() => resolve()));
    for (const controller of exchanges) controller.abort();
    for (const socket of sockets) socket.destroy();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.allSettled([handler.close(), stopped]),
        new Promise<void>(resolve => { timer = setTimeout(resolve, 1000); }),
      ]);
    } finally { if (timer) clearTimeout(timer); }
  })();
  try {
    await new Promise<void>((resolve, rejectListen) => {
      const error = () => { server.off('listening', ready); rejectListen(new Error('Unable to start HTTP transport.')); };
      const ready = () => { server.off('error', error); resolve(); };
      server.once('error', error); server.once('listening', ready);
      server.listen({ host: options.host, port: options.port, ipv6Only: true });
    });
  } catch { await close(); throw new Error('Unable to start HTTP transport.'); }
  const address = server.address() as AddressInfo;
  authority = `${options.host === '::1' ? '[::1]' : options.host}:${address.port}`;
  return { address, url: new URL(`http://${authority}/mcp`), close };
}
