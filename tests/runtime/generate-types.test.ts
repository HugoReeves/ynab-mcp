import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

it('generates deterministic types from the pinned local snapshot, independent of cwd', () => {
  const directory = mkdtempSync(join(tmpdir(), 'ynab-types-'));
  const script = fileURLToPath(new URL('../../scripts/generate-types.mjs', import.meta.url));
  try {
    const first = join(directory, 'first.ts');
    const second = join(directory, 'second.ts');
    execFileSync(process.execPath, [script, first], { cwd: directory });
    execFileSync(process.execPath, [script, second], { cwd: directory });
    const output = readFileSync(first, 'utf8');
    expect(output).toBe(readFileSync(second, 'utf8'));
    expect(output).toContain('export interface paths');
    expect(output).toContain('export interface components');
    expect(output).toContain('69411d596ee4b6f79720615038ac9cdfea43875013ca9d0e5d235ba505ebf26f');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
