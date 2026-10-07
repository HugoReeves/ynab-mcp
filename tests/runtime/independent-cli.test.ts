import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import ts from 'typescript';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { root } from '../integration/stdio-build.js';

// Independent executable emission: missing maintenance modules must not prevent
// transport tests, but this is deliberately NOT a production build assertion.
let directory: string;
let fixture: string;
const env = { PATH: process.env.PATH ?? '', HOME: '/nonexistent' };
beforeAll(() => {
  mkdirSync(join(root, '.cache'), { recursive: true });
  directory = mkdtempSync(join(root, '.cache/independent-cli-'));
  function emit(source: string, target: string) {
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, ts.transpileModule(readFileSync(source, 'utf8'), {
      compilerOptions: { target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.ESNext },
    }).outputText.replaceAll('../../src/', '../../dist/'));
  }
  function walk(relative: string) {
    for (const entry of readdirSync(join(root, relative), { withFileTypes: true })) {
      const path = join(relative, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (path.endsWith('.ts')) emit(join(root, path), join(directory, path.replace(/^src\//, 'dist/').replace(/\.ts$/, '.js')));
    }
  }
  walk('src');
  mkdirSync(join(directory, 'docs'));
  cpSync(join(root, 'docs/tool-catalog.json'), join(directory, 'docs/tool-catalog.json'));
  emit(join(root, 'tests/integration/protocol-fixture.ts'), join(directory, 'tests/integration/protocol-fixture.js'));
  fixture = join(directory, 'fixture.mjs');
  writeFileSync(fixture, `
import { startStdio } from './dist/index.js';
import { createDispatcher } from './dist/runtime/dispatcher.js';
import { createProtocolServer } from './dist/runtime/protocol.js';
import { fakeServices, ok } from './tests/integration/protocol-fixture.js';
const services = fakeServices();
services.state.available = () => true;
startStdio(() => createProtocolServer(createDispatcher(services, {
  ynab_get_user: async (_, ctx) => {
    if (!process.argv.includes('--pending')) return ok;
    ctx.signal.addEventListener('abort', () => process.stderr.write('aborted\\n'), { once: true });
    process.stderr.write('pending\\n');
    return new Promise(() => {});
  },
})));
`);
});
afterAll(() => { if (directory) rmSync(directory, { recursive: true, force: true }); });

function launch() {
  const child = spawn(process.execPath, [fixture], { env, cwd: '/tmp', stdio: 'pipe' });
  child.stdin.on('error', () => {});
  return child;
}
async function exit(child: ChildProcess) {
  const timer = setTimeout(() => child.kill('SIGKILL'), 4000);
  try { return await once(child, 'exit'); } finally { clearTimeout(timer); }
}

it.each(['legacy', '2026-07-28'] as const)('%s: discovers all 35 and delivers cancellation to pending handler', async version => {
  const transport = new StdioClientTransport({ command: process.execPath, args: [fixture, '--pending'], env, cwd: '/tmp', stderr: 'pipe' });
  const client = new Client({ name: 'independent', version: '1' }, { versionNegotiation: { mode: version === 'legacy' ? 'legacy' : { pin: version } } });
  let diagnostics = '';
  transport.stderr!.on('data', data => { diagnostics += String(data); });
  try {
    await client.connect(transport);
    expect((await client.listTools()).tools).toHaveLength(35);
    const controller = new AbortController();
    const request = client.callTool({ name: 'ynab_get_user', arguments: {} }, { signal: controller.signal }).catch(error => error);
    await expect.poll(() => diagnostics).toContain('pending\n');
    controller.abort();
    await request;
    await expect.poll(() => diagnostics).toContain('aborted\n');
    expect((await client.listTools()).tools).toHaveLength(35);
    expect(diagnostics).toBe('pending\naborted\n');
  } finally { await client.close(); }
});

it.each(['legacy', '2026-07-28'] as const)('%s: pending handler aborts on EOF and signals without hanging', async version => {
  for (const action of ['EOF', 'SIGINT', 'SIGTERM'] as const) {
    const transport = new StdioClientTransport({ command: process.execPath, args: [fixture, '--pending'], env, cwd: '/tmp', stderr: 'pipe' });
    const client = new Client({ name: 'independent', version: '1' }, { versionNegotiation: { mode: version === 'legacy' ? 'legacy' : { pin: version } } });
    let diagnostics = '';
    transport.stderr!.on('data', data => { diagnostics += String(data); });
    try {
      await client.connect(transport);
      const request = client.callTool({ name: 'ynab_get_user', arguments: {} }).catch(error => error);
      await expect.poll(() => diagnostics).toContain('pending\n');
      // Pinned SDK process access avoids close()'s SIGTERM/SIGKILL fallback
      // masking broken EOF handling or unsuccessful signal shutdown.
      const child = (transport as unknown as { _process: ChildProcess })._process;
      const done = exit(child);
      if (action === 'EOF') child.stdin!.end();
      else child.kill(action);
      expect(await done).toEqual([0, null]);
      await request;
      await expect.poll(() => diagnostics).toContain('aborted\n');
    } finally { await client.close(); }
  }
}, 15000);

it.each([false, true])('caps UTF-8 bytes, not characters (newline=%s), with private diagnostics', async newline => {
  const child = launch();
  let stdout = ''; let stderr = '';
  child.stdout.on('data', data => { stdout += String(data); });
  child.stderr.on('data', data => { stderr += String(data); });
  const done = exit(child);
  child.stdin.write('"PRIVATE_SENTINEL' + '🙂'.repeat(530000) + '"' + (newline ? '\n' : ''));
  expect((await done)[0]).toBe(1);
  expect(stdout).toBe('');
  expect(stderr).toBe('YNAB MCP transport failed.\n');
});

it('package bin symlinks invoke the entrypoint from a foreign cwd', () => {
  const bin = join(directory, 'ynab-mcp');
  symlinkSync(join(directory, 'dist/index.js'), bin);
  const result = spawnSync(process.execPath, [bin, '--version'], { cwd: '/tmp', env, encoding: 'utf8', timeout: 4000 });
  expect(result.status).toBe(0);
  expect(result.stdout).toBe('0.1.0\n');
  expect(result.stderr).toBe('');
});

it('entrypoint sanitizes private environment failures from a foreign cwd', () => {
  const result = spawnSync(process.execPath, [join(directory, 'dist/index.js')], {
    cwd: '/tmp', env: { ...env, YNAB_ACCESS_TOKEN: 'PRIVATE_SENTINEL', YNAB_READ_ONLY: 'PRIVATE_SENTINEL' },
    encoding: 'utf8', timeout: 4000,
  });
  expect(result.status).toBe(1);
  expect(result.stdout).toBe('');
  expect(result.stderr).toBe('YNAB MCP startup failed. Check configuration and installation.\n');
});
