import { afterEach, expect, it } from 'vitest';
import { connect } from 'node:net';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { startHttp, type HttpServerHandle } from '../../src/runtime/http.js';
import { client, fixture, id } from './fixtures.js';

const handles: HttpServerHandle[] = [];
afterEach(async () => { await Promise.all(handles.splice(0).map(h => h.close())); });
async function listen(connection = fixture().connection) {
  const h = await startHttp(connection, { host: '127.0.0.1', port: 0 }); handles.push(h); return h;
}
async function wire(h: HttpServerHandle, target: string, extra = '', body = '{}', host = h.url.host) {
  return new Promise<string>((resolve, reject) => {
    let response = '';
    const socket = connect(h.address.port, h.address.address, () => socket.write(
      `POST ${target} HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\nContent-Type: application/json\r\nAccept: application/json, text/event-stream\r\nContent-Length: ${Buffer.byteLength(body)}\r\n${extra}\r\n${body}`));
    socket.setTimeout(2000, () => socket.destroy(new Error('Test socket timed out')));
    socket.on('data', bytes => { response += String(bytes); });
    socket.on('error', reject); socket.on('close', () => resolve(response));
  });
}

it.each(['/mcp#fragment', '/%6dcp', '/x/../mcp', '/mcp%3f', 'http://127.0.0.1/mcp'])('rejects nonliteral path %s before API access', async target => {
  const f = fixture(); const h = await listen(f.connection);
  expect(await wire(h, target)).toMatch(/^HTTP\/1\.1 404 /);
  expect(f.requests).toHaveLength(0);
});
it.each(['null', 'http://127.0.0.1:80', 'http://127.0.0.1@evil.test', 'http://127.0.0.1\t http://evil.test'])('rejects adversarial Origin %s', async origin => {
  const f = fixture(); const h = await listen(f.connection);
  expect(await wire(h, '/mcp', `Origin: ${origin}\r\n`)).toMatch(/^HTTP\/1\.1 403 /);
  expect(f.requests).toHaveLength(0);
});
it('rejects mixed-case duplicate authority headers', async () => {
  const f = fixture(); const h = await listen(f.connection);
  expect(await wire(h, '/mcp', `hOsT: evil.test\r\n`)).toMatch(/^HTTP\/1\.1 400 /);
  expect(f.requests).toHaveLength(0);
});
it('does not echo malformed JSON payloads in parser errors', async () => {
  const f = fixture(); const h = await listen(f.connection);
  const secret = 'PRIVATE_financial_payload';
  const response = await wire(h, '/mcp', '', secret);
  expect(response).toMatch(/^HTTP\/1\.1 400 /);
  expect(response).not.toContain(secret);
  expect(f.requests).toHaveLength(0);
});
it.each(['modern', 'legacy'] as const)('redacts fake upstream exceptions in %s exchanges', async era => {
  const secret = 'INDEPENDENT_SECRET_financial_payload';
  const h = await listen(fixture(async () => { throw new Error(secret); }).connection);
  const c = await client(h.url, era);
  try {
    const result = await c.callTool({ name: 'ynab_get_user', arguments: {} });
    expect(result.structuredContent).toMatchObject({ status: 'error', error: { code: 'upstream_error' } });
    expect(JSON.stringify(result)).not.toContain(secret);
  } finally { await c.close(); }
});
it('incoming Authorization cannot replace the injected process connection or partition its cache', async () => {
  const f = fixture(); const h = await listen(f.connection);
  for (const token of ['client-A', 'client-B']) {
    const c = new Client({ name: 'independent', version: '1' });
    await c.connect(new StreamableHTTPClientTransport(h.url, { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
    try {
      expect((await c.callTool({ name: 'ynab_get_user', arguments: {} })).structuredContent).toMatchObject({ status: 'ok', data: { user: { id } } });
    } finally { await c.close(); }
  }
  expect(f.requests).toEqual([{ method: 'GET', path: '/user' }]);
});

// Run in an isolated network namespace to bind port 80 without privileges or
// interfering with host services: unshare -Urn sh -c 'ip link set lo up; ...vitest...'
// Outside that environment, skip rather than touching an existing port-80 listener.
it.for(['canonical Host', 'explicit Host and canonical Origin'])('accepts HTTP default port 80 with %s', async (variant, context) => {
  if (process.env.YNAB_TEST_ISOLATED_NETWORK !== '1') context.skip();
  const h = await startHttp(fixture().connection, { host: '127.0.0.1', port: 80 }); handles.push(h);
  expect(h.url.href).toBe('http://127.0.0.1/mcp');
  if (variant === 'explicit Host and canonical Origin') {
    // Control: explicit :80 reaches JSON-RPC validation without an Origin.
    expect(await wire(h, '/mcp', '', '{}', '127.0.0.1:80')).toMatch(/^HTTP\/1\.1 400 /);
    expect(await wire(h, '/mcp', `Origin: ${h.url.origin}\r\n`, '{}', '127.0.0.1:80')).toMatch(/^HTTP\/1\.1 400 /);
  } else {
    const c = new Client({ name: 'independent-default-port', version: '1' });
    try {
      await c.connect(new StreamableHTTPClientTransport(h.url));
      expect((await c.listTools()).tools.length).toBeGreaterThan(0);
    } finally { await c.close(); }
  }
});

it('accepts IPv6 default-port Host equivalents and canonical Origin', async context => {
  if (process.env.YNAB_TEST_ISOLATED_NETWORK !== '1') context.skip();
  const h = await startHttp(fixture().connection, { host: '::1', port: 80 }); handles.push(h);
  expect(h.url.href).toBe('http://[::1]/mcp');
  for (const host of ['[::1]', '[::1]:80']) {
    expect(await wire(h, '/mcp', `Origin: ${h.url.origin}\r\n`, '{}', host)).toMatch(/^HTTP\/1\.1 400 /);
  }
});

it.for(['127.0.0.1', '::1'])('retains strict default-port header validation on %s', async (host, context) => {
  if (process.env.YNAB_TEST_ISOLATED_NETWORK !== '1') context.skip();
  const f = fixture(); const h = await startHttp(f.connection, { host, port: 80 }); handles.push(h);
  for (const authority of [`${h.url.hostname}:81`, `${h.url.hostname}:080`, 'localhost', 'evil.test']) {
    expect(await wire(h, '/mcp', '', '{}', authority)).toMatch(/^HTTP\/1\.1 403 /);
  }
  for (const origin of [
    `${h.url.origin}:81`, `${h.url.origin}:80`, `${h.url.origin}/`, `${h.url.origin}/mcp`,
    `${h.url.origin}?query`, `${h.url.origin}#fragment`, h.url.origin.replace('http:', 'https:'),
    `http://user@${h.url.host}`, 'http://evil.test', 'null',
  ]) {
    expect(await wire(h, '/mcp', `Origin: ${origin}\r\n`)).toMatch(/^HTTP\/1\.1 403 /);
  }
  expect(await wire(h, '/mcp', `Origin: ${h.url.origin}\r\noRiGiN: ${h.url.origin}\r\n`)).toMatch(/^HTTP\/1\.1 400 /);
  expect(await wire(h, '/mcp/', `Origin: ${h.url.origin}\r\n`)).toMatch(/^HTTP\/1\.1 404 /);
  expect(f.requests).toHaveLength(0);
});
