import { afterEach, describe, expect, it } from 'vitest';
import { request } from 'node:http';
import { connect } from 'node:net';
import { startHttp, MAX_HTTP_BODY_BYTES, HTTP_LIMITS, type HttpServerHandle } from '../../src/runtime/http.js';
import { client, deferred, fixture, id, plan } from './fixtures.js';
import type { JsonObject } from '../../src/contracts.js';

const handles: HttpServerHandle[] = [];
afterEach(async () => { await Promise.all(handles.splice(0).map(h => h.close())); });
async function listen(connection = fixture().connection, host = '127.0.0.1') {
  const handle = await startHttp(connection, { host, port: 0 }); handles.push(handle); return handle;
}
async function raw(url: URL, headers: string[], path = '/mcp', method = 'POST', body = '{}') {
  return new Promise<{ status: number; headers: Record<string, unknown>; text: string }>((resolve, reject) => {
    const req = request({ hostname: url.hostname, port: url.port, path, method, headers }, res => {
      let text = ''; res.on('data', b => { text += String(b); });
      res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, text }));
    }); req.on('error', reject); req.end(body);
  });
}
describe('loopback HTTP transport', () => {
  it.each(['modern', 'legacy'] as const)('official %s client connects, lists, and calls through a real ready listener', async era => {
    const f = fixture(); const handle = await listen(f.connection);
    expect(handle.address.port).toBeGreaterThan(0); expect(handle.address.address).toBe('127.0.0.1');
    expect(handle.url.pathname).toBe('/mcp');
    const c = await client(handle.url, era);
    try {
      expect(c.getServerVersion()).toEqual({ name: 'ynab-mcp', version: '0.1.0' });
      expect((await c.listTools()).tools.map(t => t.name)).toContain('ynab_get_user');
      for (let i = 0; i < 2; i++) expect((await c.callTool({ name: 'ynab_get_user', arguments: {} })).structuredContent).toMatchObject({ status: 'ok', data: { user: { id } } });
      expect(f.requests).toEqual([{ method: 'GET', path: '/user' }]);
    } finally { await c.close(); }
  });
  it('serves IPv6 only on the exact bracketed loopback authority', async () => {
    const h = await listen(fixture().connection, '::1');
    expect(h.address.address).toBe('::1');
    const c = await client(h.url);
    try { expect((await c.callTool({ name: 'ynab_get_user', arguments: {} })).structuredContent).toMatchObject({ status: 'ok' }); }
    finally { await c.close(); }
    expect((await fetch(h.url, { method: 'POST', headers: { Origin: `http://[::1]:${h.address.port + 1}` }, body: '{}' })).status).toBe(403);
  });
  it.each(['0.0.0.0', '::', 'localhost', '127.0.0.2', 'example.com'])('never binds %s', async host => {
    await expect(startHttp(fixture().connection, { host, port: 0 })).rejects.toThrow('Invalid HTTP configuration.');
  });
  it.each([-1, 65536, 1.5, NaN])('rejects invalid port %s', async port => {
    await expect(startHttp(fixture().connection, { host: '127.0.0.1', port })).rejects.toThrow('Invalid HTTP configuration.');
  });
  it.each(['/other', '/mcp/', '/mcp?query=1', '//evil/mcp', 'http://evil/mcp'])('rejects request target %s', async path => {
    const h = await listen(); expect((await raw(h.url, ['Host', h.url.host], path)).status).toBe(404);
  });
  it.each(['GET', 'DELETE', 'PUT', 'OPTIONS', 'HEAD'])('rejects %s without CORS', async method => {
    const h = await listen(); const r = await raw(h.url, ['Host', h.url.host], '/mcp', method, '');
    expect(r.status).toBe(405); expect(r.headers['access-control-allow-origin']).toBeUndefined();
  });
  it.each(['evil.test:3000', '127.0.0.1:1', '127.0.0.1', '127.0.0.1:03000', 'user@127.0.0.1', '127.0.0.1,evil.test'])('rejects foreign/malformed Host %s before URL parsing', async host => {
    const h = await listen(); expect((await raw(h.url, ['Host', host])).status).toBe(403);
  });
  it.each(['https://evil.test', 'null', 'http://127.0.0.1:1', 'http://user@127.0.0.1', 'http://127.0.0.1/path'])('rejects Origin %s', async origin => {
    const h = await listen(); expect((await raw(h.url, ['Host', h.url.host, 'Origin', origin])).status).toBe(403);
  });
  it.each(['Host', 'Origin', 'Content-Type', 'MCP-Protocol-Version'])('rejects duplicate %s headers', async header => {
    const h = await listen(); const value = header === 'Host' ? h.url.host : header === 'Origin' ? h.url.origin : 'application/json';
    const headers = header === 'Host' ? [] : ['Host', h.url.host];
    expect((await raw(h.url, [...headers, header, value, header, value])).status).toBe(400);
  });
  it('accepts only exact authority/origin, ignores forwarding, and does not add CORS', async () => {
    const h = await listen(); const r = await raw(h.url, ['Host', h.url.host, 'Origin', h.url.origin, 'Content-Type', 'application/json', 'Accept', 'application/json, text/event-stream', 'Forwarded', 'host=evil.test', 'X-Forwarded-Host', 'evil.test']);
    expect(r.status).not.toBe(403); expect(r.headers['access-control-allow-origin']).toBeUndefined();
  });
  it('bounds declared and chunked bodies at 2 MiB', async () => {
    const f = fixture(); const h = await listen(f.connection);
    expect(MAX_HTTP_BODY_BYTES).toBe(2 * 1024 * 1024);
    const body = 'x'.repeat(MAX_HTTP_BODY_BYTES + 1);
    for (const extra of [['Content-Length', String(body.length)], ['Transfer-Encoding', 'chunked']]) {
      expect((await raw(h.url, ['Host', h.url.host, 'Content-Type', 'application/json', ...extra], '/mcp', 'POST', body)).status).toBe(413);
    }
    expect(f.requests).toEqual([]);
  });
  it.each(['modern', 'legacy'] as const)('client disconnect aborts an in-flight %s API call', async era => {
    const entered = deferred<void>(); const aborted = deferred<void>();
    const f = fixture(async ctx => { entered.resolve(); ctx.signal.addEventListener('abort', () => aborted.resolve(), { once: true }); return new Promise(() => {}); });
    const h = await listen(f.connection); const c = await client(h.url, era);
    const pending = c.callTool({ name: 'ynab_get_user', arguments: {} }).catch(() => {});
    await entered.promise; await c.close(); await aborted.promise; await pending;
  });
  it.each(['modern', 'legacy'] as const)('shutdown aborts %s exchanges, stops accepting, and is idempotent', async era => {
    const entered = deferred<void>(); const aborted = deferred<void>();
    const f = fixture(async ctx => { entered.resolve(); ctx.signal.addEventListener('abort', () => aborted.resolve(), { once: true }); return new Promise(() => {}); });
    const h = await listen(f.connection); const c = await client(h.url, era);
    const pending = c.callTool({ name: 'ynab_get_user', arguments: {} }).catch(() => {});
    await entered.promise; await h.close(); await aborted.promise; await pending; await h.close(); await c.close();
    await expect(fetch(h.url)).rejects.toThrow();
  });
  it('bounds inbound sockets, including clients that have not sent headers', async () => {
    expect(HTTP_LIMITS.maxConnections).toBe(64);
    const h = await listen();
    const sockets = await Promise.all(Array.from({ length: HTTP_LIMITS.maxConnections }, () => new Promise<ReturnType<typeof connect>>((resolve, reject) => {
      const socket = connect(h.address.port, h.address.address, () => resolve(socket)); socket.on('error', reject);
    })));
    try {
      await new Promise<void>((resolve, reject) => {
        const excess = connect(h.address.port, h.address.address); excess.on('error', () => {});
        const timeout = setTimeout(() => { excess.destroy(); reject(new Error('Connection limit was not enforced.')); }, 1000);
        excess.on('close', () => { clearTimeout(timeout); resolve(); });
      });
    } finally { for (const socket of sockets) socket.destroy(); }
  });
  it('bounds admitted exchanges and rejects excess work before reading its body', async () => {
    expect(HTTP_LIMITS.maxConnections).toBe(64); expect(HTTP_LIMITS.maxExchanges).toBe(32);
    const entered = deferred<void>(); let count = 0;
    const f = fixture(async () => { if (++count === HTTP_LIMITS.maxExchanges) entered.resolve(); return new Promise(() => {}); });
    const h = await listen(f.connection); const c = await client(h.url);
    const calls = Array.from({ length: HTTP_LIMITS.maxExchanges }, () => c.callTool({ name: 'ynab_get_user', arguments: {} }).catch(() => {}));
    try {
      await entered.promise;
      expect((await raw(h.url, ['Host', h.url.host])).status).toBe(503);
      expect(count).toBe(HTTP_LIMITS.maxExchanges);
    } finally { await h.close(); await c.close(); await Promise.all(calls); }
  });
  it('rejects malformed and excessive headers before dispatch', async () => {
    const f = fixture(); const h = await listen(f.connection);
    const malformed = await new Promise<string>((resolve, reject) => {
      let text = '';
      const socket = connect(h.address.port, h.address.address, () => socket.write(`POST /mcp HTTP/1.1\r\nHost: ${h.url.host}\r\nBad Header: value\r\n\r\n`));
      socket.on('data', bytes => { text += String(bytes); }); socket.on('error', reject); socket.on('close', () => resolve(text));
    });
    expect(malformed).toContain('400');
    expect((await raw(h.url, ['Host', h.url.host, ...Array.from({ length: 64 }, (_, i) => [`X-${i}`, 'v']).flat()])).status).toBe(400);
    expect(f.requests).toEqual([]);
  });
  it('rejects headers above the byte limit before creating an exchange', async () => {
    const h = await listen();
    expect((await raw(h.url, ['Host', h.url.host, 'X-Padding', 'x'.repeat(8192)])).status).toBe(400);
  });
  it('ends slow header and body uploads within fixed waiting limits', async () => {
    expect(HTTP_LIMITS.headerTimeoutMs).toBe(5000); expect(HTTP_LIMITS.bodyTimeoutMs).toBe(10000);
    const f = fixture(); const h = await listen(f.connection);
    const stalled = async (bytes: string, limit: number) => {
      const started = Date.now();
      await new Promise<void>((resolve, reject) => {
        const socket = connect(h.address.port, h.address.address, () => socket.write(bytes));
        const watchdog = setTimeout(() => { socket.destroy(); reject(new Error('Upload did not time out.')); }, limit + 2500);
        socket.on('error', () => {}); socket.on('data', () => {});
        socket.on('close', () => { clearTimeout(watchdog); resolve(); });
      });
      expect(Date.now() - started).toBeLessThan(limit + 2000);
    };
    await Promise.all([
      stalled('POST /mcp HTTP/1.1\r\nHost: ', HTTP_LIMITS.headerTimeoutMs),
      stalled(`POST /mcp HTTP/1.1\r\nHost: ${h.url.host}\r\nContent-Length: 100\r\n\r\n{`, HTTP_LIMITS.bodyTimeoutMs),
    ]);
    expect(f.requests).toEqual([]);
  }, 15000);
  it('discards truncated bodies before dispatch and stays available', async () => {
    const f = fixture(); const h = await listen(f.connection);
    await new Promise<void>(resolve => {
      const socket = connect(h.address.port, h.address.address, () => {
        socket.end(`POST /mcp HTTP/1.1\r\nHost: ${h.url.host}\r\nContent-Length: 100\r\n\r\n{`);
      }); socket.on('data', () => {}); socket.on('close', () => resolve());
    });
    expect(f.requests).toEqual([]); const c = await client(h.url); await c.listTools(); await c.close();
  });
  it('shares an opaque cursor snapshot across different clients and exchanges', async () => {
    const f = fixture(async () => ({ plans: [{ id: plan, name: 'A' }, { id, name: 'B' }], default_plan: null }));
    const h = await listen({ ...f.connection, config: { ...f.connection.config, allowedPlanIds: null } });
    const a = await client(h.url); const b = await client(h.url, 'legacy');
    try {
      const first = (await a.callTool({ name: 'ynab_list_plans', arguments: { page_size: 1 } })).structuredContent as { meta: { next_cursor: string } };
      expect(first.meta.next_cursor).toBeTypeOf('string');
      expect((await b.callTool({ name: 'ynab_list_plans', arguments: { page_size: 1, cursor: first.meta.next_cursor } })).structuredContent).toMatchObject({ status: 'ok', data: { plans: [{ id, name: 'B' }] }, meta: { complete: true } });
      expect(f.requests).toHaveLength(1);
    } finally { await a.close(); await b.close(); }
  });
  it('serializes same-plan writes across clients and invalidates their shared read cache', async () => {
    let payees: { id: string; name: string; deleted: boolean; transfer_account_id: null }[] = [];
    const entered = deferred<void>(); const release = deferred<void>(); let writes = 0;
    const f = fixture(async (_ctx, req): Promise<JsonObject> => {
      if (req.method === 'GET') return { payees: structuredClone(payees), server_knowledge: 1 };
      writes++;
      if (writes === 1) { entered.resolve(); await release.promise; }
      const payee = { id: writes === 1 ? id : plan, name: String(req.body?.payee && (req.body.payee as { name: string }).name), deleted: false, transfer_account_id: null };
      payees = [...payees, payee]; return { payee, server_knowledge: writes };
    });
    const h = await listen(f.connection); const a = await client(h.url); const b = await client(h.url, 'legacy');
    try {
      expect((await a.callTool({ name: 'ynab_list_payees', arguments: {} })).structuredContent).toMatchObject({ data: { payees: [] } });
      expect((await b.callTool({ name: 'ynab_list_payees', arguments: {} })).structuredContent).toMatchObject({ meta: { cache_hit: true } });
      const one = a.callTool({ name: 'ynab_create_payee', arguments: { name: 'First', dry_run: false } });
      await entered.promise;
      const two = b.callTool({ name: 'ynab_create_payee', arguments: { name: 'Second', dry_run: false } });
      // A discovery exchange is a barrier while the first write holds the plan lock.
      await b.listTools(); expect(writes).toBe(1); release.resolve();
      const firstWrite = (await one).structuredContent; const secondWrite = (await two).structuredContent;
      expect(firstWrite, JSON.stringify(firstWrite)).toMatchObject({ status: 'ok' });
      expect(secondWrite, JSON.stringify(secondWrite)).toMatchObject({ status: 'ok' });
      expect(writes).toBe(2);
      expect((await a.callTool({ name: 'ynab_list_payees', arguments: {} })).structuredContent).toMatchObject({ status: 'ok', data: { payees: [{ name: 'First' }, { name: 'Second' }] }, meta: { cache_hit: false } });
    } finally { release.resolve(); await a.close(); await b.close(); }
  });
});
