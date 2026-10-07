import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { catalog, loadCatalog, inputValidators, outputValidators } from '../../src/catalog.js';
import { ToolFailure } from '../../src/errors.js';
import { fixtureError, fixtureMeta } from '../helpers/fixtures.js';

const source = new URL('../../docs/tool-catalog.json', import.meta.url);

describe('catalog foundation', () => {
  it('loads the unchanged catalog and compiles all 70 self-contained schemas', () => {
    expect(catalog).toEqual(JSON.parse(readFileSync(source, 'utf8')).tools);
    expect(catalog).toHaveLength(35);
    expect(new Set(catalog.map(t => t.name)).size).toBe(35);
    expect(catalog.filter(t => t.profile === 'core')).toHaveLength(25);
    expect(catalog.filter(t => t.profile === 'extended')).toHaveLength(10);
    expect(inputValidators.size).toBe(35);
    expect(outputValidators.size).toBe(35);
    expect(Object.isFrozen(catalog)).toBe(true);
    expect(Object.isFrozen(catalog[0].inputSchema)).toBe(true);
  });

  it('validates every error envelope, including failure outcomes', () => {
    for (const validate of outputValidators.values()) {
      for (const outcome of ['not_applied', 'applied', 'unknown']) {
        expect(validate({ status: 'error', error: { ...fixtureError, outcome }, meta: fixtureMeta })).toBe(true);
      }
      expect(validate({ status: 'error', error: { ...fixtureError, code: 'invented' }, meta: fixtureMeta })).toBe(false);
      expect(validate({ status: 'error', error: fixtureError, meta: { ...fixtureMeta, fetched_at: 'bad' } })).toBe(false);
    }
  });

  it('validates success and preview envelopes', () => {
    const user = outputValidators.get('ynab_get_user')!;
    expect(user({ status: 'ok', data: { user: { id: '00000000-0000-4000-8000-000000000001' } }, meta: fixtureMeta })).toBe(true);
    expect(user({ status: 'ok', data: {}, meta: fixtureMeta })).toBe(false);
    const preview = {
      status: 'preview', meta: fixtureMeta,
      preview: { method: 'POST', path: '/plans/example/transactions', body: null, validated: true,
        before: [], expected_revisions: {}, affected_ids: [], unknown_effects: false, warnings: [] },
    };
    expect(outputValidators.get('ynab_create_transactions')!(preview)).toBe(true);
    expect(user(preview)).toBe(false);
  });

  it('rejects additional properties and formats without modifying arguments', () => {
    const args = { plan_id: 'not-a-uuid', extra: true };
    expect(inputValidators.get('ynab_list_accounts')!(args)).toBe(false);
    expect(args).toEqual({ plan_id: 'not-a-uuid', extra: true });
    const defaults = { transactions: [] };
    inputValidators.get('ynab_create_transactions')!(defaults);
    expect(defaults).toEqual({ transactions: [] });
    expect(inputValidators.get('ynab_get_user')!({})).toBe(true);
    expect(inputValidators.get('ynab_get_user')!({ extra: true })).toBe(false);
    expect(inputValidators.get('ynab_list_transactions')!({ page_size: '5' })).toBe(false);
  });

  it.each(['duplicate', 'remote-ref', 'invalid-schema', 'invalid-metadata'])('fails closed on %s', kind => {
    const document = JSON.parse(readFileSync(source, 'utf8'));
    if (kind === 'duplicate') document.tools[1].name = document.tools[0].name;
    if (kind === 'remote-ref') document.tools[0].inputSchema.$ref = 'https://example.invalid/schema';
    if (kind === 'invalid-schema') document.tools[0].inputSchema.type = 'made-up';
    if (kind === 'invalid-metadata') document.tools[0].permissions.write = 'false';
    const dir = mkdtempSync(join(tmpdir(), 'ynab-catalog-'));
    try {
      const file = join(dir, 'catalog.json');
      writeFileSync(file, JSON.stringify(document));
      expect(() => loadCatalog(pathToFileURL(file))).toThrow();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('ToolFailure frozen boundary', () => {
  it('preserves the structured error and safe message', () => {
    const failure = new ToolFailure(fixtureError);
    expect(failure).toBeInstanceOf(Error);
    expect(failure.name).toBe('ToolFailure');
    expect(failure.message).toBe(fixtureError.message);
    expect(failure.error).toBe(fixtureError);
  });
});
