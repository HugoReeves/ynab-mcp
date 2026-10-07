import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const executable = process.argv[2];
assert.ok(executable, 'Supply the installed executable.');
const cwd = mkdtempSync(join(tmpdir(), 'ynab-nix-startup-'));
// Do not inherit credentials, NODE_PATH, npm configuration, or global tools.
const env = { HOME: cwd, PATH: '/nonexistent' };
try {
  for (const [flag, expected] of [['--help', /Usage: ynab-mcp/], ['--version', /^0\.1\.0\n$/]]) {
    const result = spawnSync(executable, [flag], { cwd, env, encoding: 'utf8', timeout: 15000 });
    assert.equal(result.status, 0, `${flag}: ${result.stderr}`);
    assert.equal(result.stderr, '');
    assert.match(result.stdout, expected);
  }
  const missing = spawnSync(executable, [], { cwd, env, encoding: 'utf8', timeout: 15000 });
  assert.equal(missing.status, 1);
  assert.equal(missing.stdout, '');
  assert.match(missing.stderr, /YNAB MCP startup failed/);

  // A fake token permits local startup only. Initialization and tool discovery
  // cannot contact YNAB; the Nix build sandbox also forbids outbound networking.
  const child = spawn(executable, [], { cwd, env: { ...env, YNAB_ACCESS_TOKEN: 'offline-fixture-not-a-credential' } });
  await new Promise((resolve, reject) => {
    let buffer = '';
    let stderr = '';
    let discovered = false;
    const timer = setTimeout(() => {
      child.kill('SIGKILL'); reject(new Error('Packaged stdio startup timed out.'));
    }, 15000);
    const fail = error => { clearTimeout(timer); child.kill('SIGKILL'); reject(error); };
    const send = message => child.stdin.write(`${JSON.stringify(message)}\n`);
    child.on('error', fail);
    child.stdin.on('error', fail);
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        try {
          const response = JSON.parse(line);
          assert.equal(response.jsonrpc, '2.0');
          assert.equal(response.error, undefined);
          if (response.id === 1) {
            assert.ok(response.result.serverInfo);
            send({ jsonrpc: '2.0', method: 'notifications/initialized' });
            send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
          } else if (response.id === 2) {
            const names = response.result.tools.map(tool => tool.name);
            assert.equal(names.length, 15);
            assert.ok(names.includes('ynab_get_user'));
            assert.ok(!names.includes('ynab_create_transaction'));
            discovered = true;
            child.stdin.end();
          }
        } catch (error) { fail(error); }
      }
    });
    child.on('close', code => {
      clearTimeout(timer);
      try {
        assert.equal(code, 0);
        assert.equal(stderr, '');
        assert.equal(buffer, '');
        assert.ok(discovered, 'No tool discovery response.');
        resolve();
      } catch (error) { reject(error); }
    });
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
      protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'nix-offline-startup', version: '1' },
    } });
  });
} finally { rmSync(cwd, { recursive: true, force: true }); }
