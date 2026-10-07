import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { root } from '../integration/stdio-build.js';

it('launches from another cwd with no Node in PATH, absolute repo paths, and explicit Node env-file only for serving', () => {
  const directory = mkdtempSync(join(tmpdir(), 'ynab-launcher-'));
  try {
    mkdirSync(join(directory, 'scripts')); mkdirSync(join(directory, 'bin'));
    copyFileSync(join(root, 'scripts/run-local.sh'), join(directory, 'scripts/run-local.sh'));
    // Nix sandboxes have no /usr/bin/env. Keep ordinary development discovery.
    const bash = process.env.NIX_TEST_BASH ?? execFileSync('bash', ['-c', 'command -v bash'], { encoding: 'utf8' }).trim();
    if (process.env.NIX_TEST_BASH) {
      const launcher = join(directory, 'scripts/run-local.sh');
      writeFileSync(launcher, readFileSync(launcher, 'utf8').replace(/^#![^\n]+/, `#!${bash}`));
    }
    for (const name of ['bash', 'dirname']) {
      const executable = name === 'bash' ? bash : execFileSync(bash, ['-c', `command -v ${name}`], { encoding: 'utf8' }).trim();
      symlinkSync(executable, join(directory, 'bin', name));
    }
    // A recording Nix stand-in: no Node/global runtime, token, or env file is read.
    writeFileSync(join(directory, 'bin/nix'), `#!${bash}\nprintf "%s\\n" "$@"\n`, { mode: 0o755 });
    const env = { PATH: join(directory, 'bin'), HOME: directory };
    const serve = spawnSync(join(directory, 'scripts/run-local.sh'), [], { cwd: tmpdir(), env, encoding: 'utf8' });
    expect(serve.status).toBe(0); expect(serve.stderr).toBe('');
    expect(serve.stdout.trim().split('\n')).toEqual(['develop', directory, '-c', 'node', `--env-file=${directory}/.env`, `${directory}/dist/index.js`]);
    for (const flag of ['--help', '--version']) {
      const child = spawnSync(join(directory, 'scripts/run-local.sh'), [flag], { cwd: tmpdir(), env, encoding: 'utf8' });
      expect(child.status).toBe(0); expect(child.stderr).toBe('');
      expect(child.stdout.trim().split('\n')).toEqual(['develop', directory, '-c', 'node', `${directory}/dist/index.js`, flag]);
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
