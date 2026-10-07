import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { readHttpOptions } from '../../src/runtime/http.js';
import { buildStdioFixture } from '../integration/stdio-build.js';

let build: ReturnType<typeof buildStdioFixture>;
beforeAll(() => { build = buildStdioFixture(); }, 30000);
afterAll(() => build?.cleanup());
const env = { PATH: process.env.PATH ?? '', HOME: '/nonexistent' };
describe('HTTP configuration and CLI', () => {
  it('uses loopback-only environment defaults without credentials or env-file loading', () => {
    expect(readHttpOptions({})).toEqual({ host: '127.0.0.1', port: 3000 });
    expect(readHttpOptions({ YNAB_HOST: '::1', YNAB_PORT: '65535' })).toEqual({ host: '::1', port: 65535 });
  });
  it.each(['0', '-1', '65536', '1.5', '03000', '', 'NaN', ' 3000'])('rejects CLI port %s without leaking the value', value => {
    expect(() => readHttpOptions({ YNAB_PORT: value })).toThrow('Invalid HTTP configuration.');
  });
  it.each(['0.0.0.0', '::', 'PRIVATE_SENTINEL', 'localhost'])('rejects host %s without leaking it', value => {
    expect(() => readHttpOptions({ YNAB_HOST: value })).toThrow('Invalid HTTP configuration.');
  });
  it.each(['--help', '--version'])('%s needs no authentication and ignores invalid HTTP environment', flag => {
    const c = spawnSync(process.execPath, [build.entry, flag], { env: { ...env, YNAB_HOST: 'PRIVATE_SENTINEL', YNAB_PORT: '0' }, encoding: 'utf8', timeout: 5000 });
    expect(c.status).toBe(0); expect(c.stderr).toBe('');
    if (flag === '--help') expect(c.stdout).toContain('--transport stdio|http');
  });
  it.each([['--transport'], ['--transport', 'unknown'], ['--transport', 'http', 'extra'], ['--transport=http']].map(args => ({ args })))('rejects malformed transport arguments $args before credentials', ({ args }) => {
    const c = spawnSync(process.execPath, [build.entry, ...args], { env, encoding: 'utf8', timeout: 5000 });
    expect(c.status).toBe(2); expect(c.stdout).toBe(''); expect(c.stderr).toContain('Usage:');
  });
  it('explicit stdio preserves the no-auth sanitized startup error', () => {
    const c = spawnSync(process.execPath, [build.entry, '--transport', 'stdio'], { env, encoding: 'utf8', timeout: 5000 });
    expect(c.status).toBe(1); expect(c.stderr).toContain('startup failed'); expect(c.stderr).not.toContain('Usage:');
  });
  it('HTTP fails closed with sanitized configuration diagnostics', () => {
    const c = spawnSync(process.execPath, [build.entry, '--transport', 'http'], { env: { ...env, YNAB_ACCESS_TOKEN: 'PRIVATE_SENTINEL', YNAB_HOST: '0.0.0.0' }, encoding: 'utf8', timeout: 5000 });
    expect(c.status).toBe(1); expect(c.stdout).toBe(''); expect(c.stderr).toContain('startup failed'); expect(c.stderr).not.toContain('PRIVATE_SENTINEL');
  });
  it.each(['SIGINT', 'SIGTERM'] as const)('reports readiness after listening, then shuts down on %s without API calls', async signal => {
    const reservation = createServer(); reservation.listen(0, '127.0.0.1'); await once(reservation, 'listening');
    const port = (reservation.address() as { port: number }).port;
    await new Promise<void>(resolve => reservation.close(() => resolve()));
    const child = spawn(process.execPath, [build.entry, '--transport', 'http'], { env: { ...env, YNAB_ACCESS_TOKEN: 'offline-test-token', YNAB_PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = ''; let stdout = '';
    child.stderr.on('data', b => { stderr += String(b); }); child.stdout.on('data', b => { stdout += String(b); });
    const done = once(child, 'exit'); const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
    try {
      await once(child.stderr, 'data'); expect(stderr).toContain(`http://127.0.0.1:${port}/mcp`);
      expect((await fetch(`http://127.0.0.1:${port}/mcp`)).status).toBe(405);
      child.kill(signal); expect((await done)[0]).toBe(0); expect(stdout).toBe(''); expect(stderr).not.toContain('offline-test-token');
    } finally { clearTimeout(timer); child.kill('SIGKILL'); }
  });
});
