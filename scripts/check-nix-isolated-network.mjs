import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { networkInterfaces } from 'node:os';

const timeout = 600000;
function run(executable, args, env = process.env) {
  const result = spawnSync(executable, args, { stdio: 'inherit', env, timeout });
  if (result.error) throw result.error;
  assert.equal(result.signal, null, 'Isolated check exceeded its deadline or received a signal.');
  assert.equal(result.status, 0, 'Isolated check failed.');
}
function loopbackOnly() {
  const interfaces = networkInterfaces();
  assert.deepEqual(Object.keys(interfaces), ['lo'], 'Checks require a private loopback-only network namespace.');
  assert.ok(Object.values(interfaces).flat().every(address => address.internal));
}

assert.equal(process.platform, 'linux');
if (process.argv[2] !== '--inside') {
  // Require the ordinary non-root, network-isolated Nix build sandbox first.
  // Never bind reserved ports in this outer namespace or on the host.
  assert.ok(process.getuid() > 0, 'Run checks as a non-root build user.');
  loopbackOnly();
  const [unshare, ip, executable, ...args] = process.argv.slice(2);
  assert.ok(unshare && ip && executable, 'Supply unshare, ip, and the check command.');
  run(unshare, ['--user', '--map-root-user', '--net', process.execPath, process.argv[1], '--inside', ip, executable, ...args]);
} else {
  const [ip, executable, ...args] = process.argv.slice(3);
  // Root only in a new user namespace, mapped to one non-root outer build uid.
  // Reject host root and broad mappings before changing loopback state.
  assert.equal(process.getuid(), 0);
  assert.match(readFileSync('/proc/self/uid_map', 'utf8'), /^\s*0\s+[1-9][0-9]*\s+1\s*$/);
  run(ip, ['link', 'set', 'lo', 'up']);
  loopbackOnly();
  for (const host of ['127.0.0.1', '::1']) {
    await new Promise((resolve, reject) => {
      const server = createServer();
      server.once('error', reject);
      server.listen(80, host, () => server.close(error => error ? reject(error) : resolve()));
    });
  }
  console.log('Private user/network namespace: IPv4 and IPv6 port 80 verified.');
  // Set the opt-in only after namespace and bind checks succeed. No host sysctl,
  // capability, or privilege changes are needed. Fail rather than skip tests.
  run(executable, args, { ...process.env, YNAB_TEST_ISOLATED_NETWORK: '1' });
}
