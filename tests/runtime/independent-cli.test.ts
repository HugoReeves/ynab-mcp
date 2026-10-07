import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import { PassThrough, type Readable } from 'node:stream';
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
    if (process.argv.includes('--delayed')) await new Promise(resolve => setTimeout(resolve, 1500));
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

// Subscribe before connect so diagnostics arriving before wait() are retained.
// close/end, unlike exit, guarantee that final stderr data has drained.
function readiness(stderr: Readable, deadline = 10000) {
  let diagnostics = '';
  let failure: string | undefined;
  const changes = new EventEmitter();
  let child: ChildProcess | undefined;
  const fail = (reason: string) => { failure ??= reason; changes.emit('change'); };
  const data = (chunk: Buffer) => { diagnostics += chunk.toString(); changes.emit('change'); };
  const end = () => fail('stderr ended');
  const streamClose = () => fail('stderr closed');
  const error = () => fail('stream/process error');
  const close = (code: number | null, signal: string | null) => fail(`child closed (${code}, ${signal})`);
  stderr.on('data', data).on('end', end).on('close', streamClose).on('error', error);
  return {
    get diagnostics() { return diagnostics; },
    attach(process: ChildProcess) {
      child = process;
      child.on('error', error).on('close', close);
      if (stderr.readableEnded || stderr.destroyed) end();
    },
    wait(marker: string, request?: Promise<unknown>) {
      return new Promise<void>((resolve, reject) => {
        let active = true;
        const cleanup = () => { active = false; clearTimeout(timer); changes.off('change', check); };
        const rejectWith = (reason: string) => {
          cleanup();
          // Never echo arbitrary tool errors or private stderr contents.
          reject(new Error(`Readiness ${JSON.stringify(marker)}: ${reason}; stderr bytes=${Buffer.byteLength(diagnostics)}, pending=${diagnostics.includes('pending\n')}, aborted=${diagnostics.includes('aborted\n')}`));
        };
        const check = () => {
          if (diagnostics.includes(marker)) { cleanup(); resolve(); }
          else if (failure) rejectWith(failure);
        };
        const timer = setTimeout(() => rejectWith(`deadline ${deadline}ms exceeded`), deadline);
        changes.on('change', check);
        if (request) void request.then(
          () => { if (active && !diagnostics.includes(marker)) rejectWith('request settled before marker'); },
          () => { if (active && !diagnostics.includes(marker)) rejectWith('request rejected before marker'); },
        );
        check();
      });
    },
    dispose() {
      stderr.off('data', data).off('end', end).off('close', streamClose).off('error', error);
      child?.off('error', error).off('close', close);
    },
  };
}

it('readiness buffers split/already received markers and drains stderr after child exit', async () => {
  const stderr = new PassThrough();
  const child = new EventEmitter() as ChildProcess;
  const ready = readiness(stderr);
  ready.attach(child);
  try {
    stderr.write('pen'); stderr.write('ding\n');
    await ready.wait('pending\n');
    const aborted = ready.wait('aborted\n');
    child.emit('exit', 0, null);
    stderr.write('abor'); stderr.end('ted\n');
    await aborted;
    child.emit('close', 0, null);
    await ready.wait('aborted\n');
    expect(ready.diagnostics).toBe('pending\naborted\n');
  } finally { ready.dispose(); }
  expect(stderr.listenerCount('data')).toBe(0);
  expect(child.listenerCount('close')).toBe(0);
});

it.each(['end', 'stream-close', 'close', 'error', 'request', 'deadline'] as const)('readiness rejects safely on %s without a marker', async reason => {
  const stderr = new PassThrough();
  const child = new EventEmitter() as ChildProcess;
  const ready = readiness(stderr, 20);
  ready.attach(child);
  try {
    const waiting = ready.wait('pending\n', reason === 'request' ? Promise.reject(new Error('PRIVATE_SENTINEL')) : undefined);
    const rejected = expect(waiting).rejects.toThrow(/Readiness "pending\\n": (stderr ended|stderr closed|child closed \(1, null\)|stream\/process error|request rejected before marker|deadline 20ms exceeded); stderr bytes=0, pending=false, aborted=false/);
    if (reason === 'end') stderr.end();
    if (reason === 'stream-close') stderr.destroy();
    if (reason === 'close') child.emit('close', 1, null);
    if (reason === 'error') child.emit('error', new Error('PRIVATE_SENTINEL'));
    await rejected;
  } finally { ready.dispose(); }
  expect(stderr.listenerCount('data')).toBe(0);
  expect(child.listenerCount('close')).toBe(0);
});

it.each([
  ['legacy', false], ['2026-07-28', false],
  ['legacy', true], ['2026-07-28', true],
] as const)('%s: discovers all 35 and delivers cancellation to pending handler (delayed=%s)', async (version, delayed) => {
  const transport = new StdioClientTransport({ command: process.execPath, args: [fixture, '--pending', ...(delayed ? ['--delayed'] : [])], env, cwd: '/tmp', stderr: 'pipe' });
  const client = new Client({ name: 'independent', version: '1' }, { versionNegotiation: { mode: version === 'legacy' ? 'legacy' : { pin: version } } });
  const ready = readiness(transport.stderr! as Readable);
  try {
    await client.connect(transport);
    ready.attach((transport as unknown as { _process: ChildProcess })._process);
    expect((await client.listTools()).tools).toHaveLength(35);
    const controller = new AbortController();
    const started = Date.now();
    const request = client.callTool({ name: 'ynab_get_user', arguments: {} }, { signal: controller.signal });
    void request.catch(() => {});
    await ready.wait('pending\n', request);
    if (delayed) expect(Date.now() - started).toBeGreaterThan(1000);
    controller.abort();
    await request.catch(() => {});
    await ready.wait('aborted\n');
    expect((await client.listTools()).tools).toHaveLength(35);
    expect(ready.diagnostics).toBe('pending\naborted\n');
  } finally { ready.dispose(); await client.close(); }
}, 20000);

it.each(['legacy', '2026-07-28'] as const)('%s: pending handler aborts on EOF and signals without hanging', async version => {
  for (const action of ['EOF', 'SIGINT', 'SIGTERM'] as const) {
    const transport = new StdioClientTransport({ command: process.execPath, args: [fixture, '--pending'], env, cwd: '/tmp', stderr: 'pipe' });
    const client = new Client({ name: 'independent', version: '1' }, { versionNegotiation: { mode: version === 'legacy' ? 'legacy' : { pin: version } } });
    const ready = readiness(transport.stderr! as Readable);
    try {
      await client.connect(transport);
      ready.attach((transport as unknown as { _process: ChildProcess })._process);
      const request = client.callTool({ name: 'ynab_get_user', arguments: {} });
      void request.catch(() => {});
      await ready.wait('pending\n', request);
      // Pinned SDK process access avoids close()'s SIGTERM/SIGKILL fallback
      // masking broken EOF handling or unsuccessful signal shutdown.
      const child = (transport as unknown as { _process: ChildProcess })._process;
      const done = exit(child);
      if (action === 'EOF') child.stdin!.end();
      else child.kill(action);
      expect(await done).toEqual([0, null]);
      await request.catch(() => {});
      await ready.wait('aborted\n');
      expect(ready.diagnostics).toBe('pending\naborted\n');
    } finally { ready.dispose(); await client.close(); }
  }
}, 60000);

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
