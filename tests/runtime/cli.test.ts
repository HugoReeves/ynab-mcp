import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { readFileSync, statSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { catalog } from '../../src/catalog.js';
import { fakeServices, ok } from '../integration/protocol-fixture.js';
import { buildStdioFixture, root } from '../integration/stdio-build.js';

let build: ReturnType<typeof buildStdioFixture>;
beforeAll(() => { build = buildStdioFixture(); }, 30000);
afterAll(() => build?.cleanup());
const cleanEnv = { PATH: process.env.PATH ?? '', HOME: '/nonexistent', YNAB_LOG_LEVEL: 'warn' };
function launch(entry: string, args: string[] = []) {
  return spawn(process.execPath, [entry, ...args], { env: cleanEnv, stdio: ['pipe', 'pipe', 'pipe'] });
}
async function exited(child: ChildProcess) {
  const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
  try { return await once(child, 'exit'); } finally { clearTimeout(timer); }
}

describe('stdio executable', () => {
  it.each(['--help', '--version'])('%s works without credentials and before handler imports', flag => {
    const child = spawnSync(process.execPath, [build.entry, flag], { env: cleanEnv, encoding: 'utf8', timeout: 5000 });
    expect(child.status).toBe(0); expect(child.stderr).toBe('');
    expect(child.stdout).toContain(flag === '--version' ? '0.1.0' : 'Usage:');
  });
  it('rejects unknown flags without credentials', () => {
    const child = spawnSync(process.execPath, [build.entry, '--unknown'], { env: cleanEnv, encoding: 'utf8', timeout: 5000 });
    expect(child.status).toBe(2); expect(child.stdout).toBe(''); expect(child.stderr).toContain('Usage:');
  });
  it('sanitizes startup configuration errors on stderr, without reading env files', () => {
    const child = spawnSync(process.execPath, [build.entry], { env: { ...cleanEnv, YNAB_ACCESS_TOKEN_FILE: '/PRIVATE_SENTINEL/nonexistent' }, encoding: 'utf8', timeout: 5000 });
    expect(child.status).toBe(1); expect(child.stdout).toBe('');
    expect(child.stderr).toContain('startup failed'); expect(child.stderr).not.toContain('PRIVATE_SENTINEL');
    expect(child.stderr).not.toContain('Error:');
  });
  it.each(['legacy', '2026-07-28'] as const)('official client initializes/discovers/calls over %s subprocess stdio with protocol-only stdout', async version => {
    const transport = new StdioClientTransport({ command: process.execPath, args: [build.fixture], env: cleanEnv, stderr: 'pipe', cwd: '/tmp' });
    let stderr = ''; transport.stderr?.on('data', chunk => { stderr += String(chunk); });
    const client = new Client({ name: 'fixture-client', version: '1' }, { versionNegotiation: { mode: version === 'legacy' ? 'legacy' : { pin: version } } });
    const protocolErrors: Error[] = []; client.onerror = error => { protocolErrors.push(error); };
    try {
      await client.connect(transport);
      expect(client.getServerVersion()).toEqual({ name: 'ynab-mcp', version: '0.1.0' });
      const tools = await client.listTools();
      expect(tools.tools).toEqual(catalog.filter(t => fakeServices().state.available(t)).map(t => ({ name: t.name, description: t.description, inputSchema: t.inputSchema, outputSchema: t.outputSchema, annotations: t.annotations })));
      expect((await client.callTool({ name: 'ynab_get_user', arguments: {} })).structuredContent).toEqual(ok);
      const failure = await client.callTool({ name: 'ynab_get_user', arguments: { extra: 'PRIVATE_SENTINEL' } });
      expect(failure.isError).toBe(true); expect(failure.structuredContent).toMatchObject({ status: 'error', error: { code: 'validation_error' } });
      expect(JSON.stringify(failure)).not.toContain('PRIVATE_SENTINEL'); expect(stderr).toBe('');
      expect(protocolErrors).toEqual([]);
    } finally { await client.close(); }
  });
  it('exits on EOF without initialization', async () => {
    const child = launch(build.fixture); const done = exited(child);
    child.stdin?.end(); expect((await done)[0]).toBe(0);
  });
  it('EOF aborts an in-flight uncooperative handler and clears its deadline timer', async () => {
    const child = launch(build.fixture, ['--pending']); const done = exited(child);
    const initialized = once(child.stdout!, 'data');
    child.stdin?.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'fixture', version: '1' } } }) + '\n');
    await initialized;
    const pending = once(child.stderr!, 'data');
    child.stdin?.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    child.stdin?.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'ynab_get_user', arguments: {} } }) + '\n');
    expect(String((await pending)[0])).toContain('fixture-pending');
    child.stdin?.end(); expect((await done)[0]).toBe(0);
  });
  it.each(['SIGINT', 'SIGTERM'] as const)('closes cleanly on %s', async signal => {
    const child = launch(build.fixture); const done = exited(child);
    // Readiness handshake avoids signalling before JS installs shutdown handlers.
    const line = once(child.stdout!, 'data');
    child.stdin?.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'fixture', version: '1' } } }) + '\n');
    await line; child.kill(signal); expect((await done)[0]).toBe(0);
  });
  it('bounds unterminated input frames and emits sanitized transport diagnostics only to stderr', async () => {
    const child = launch(build.fixture); let stdout = ''; let stderr = '';
    child.stdout?.on('data', c => { stdout += String(c); }); child.stderr?.on('data', c => { stderr += String(c); });
    child.stdin?.on('error', () => {}); const done = exited(child);
    child.stdin?.write('PRIVATE_SENTINEL'.repeat(150000));
    expect((await done)[0]).toBe(1); expect(stdout).toBe('');
    expect(stderr).toContain('transport failed'); expect(stderr).not.toContain('PRIVATE_SENTINEL');
  });
  it('publishes matching local version, executable bin, and a Nix-only explicit-env launcher', () => {
    const pkg = JSON.parse(readFileSync(`${root}/package.json`, 'utf8'));
    const lock = JSON.parse(readFileSync(`${root}/package-lock.json`, 'utf8'));
    expect(pkg.version).toBe('0.1.0'); expect(lock.version).toBe(pkg.version); expect(lock.packages[''].version).toBe(pkg.version);
    expect(pkg.bin).toEqual({ 'ynab-mcp': 'dist/index.js' }); expect(pkg.scripts.start).toBe('node dist/index.js');
    expect(readFileSync(build.entry, 'utf8')).toMatch(/^#!\/usr\/bin\/env node/);
    expect(statSync(`${root}/scripts/run-local.sh`).mode & 0o111).not.toBe(0);
    const script = readFileSync(`${root}/scripts/run-local.sh`, 'utf8');
    expect(script).toContain('nix develop'); expect(script).toContain('--env-file=');
    expect(readFileSync(`${root}/flake.nix`, 'utf8')).toMatch(/pre-commit install\s+>&2/);
  });
});
