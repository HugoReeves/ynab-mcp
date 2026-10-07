import { describe, expect, it } from 'vitest';
import { inputValidators, outputValidators } from '../../src/catalog.js';
import type { JsonObject, ToolName, ToolResult } from '../../src/contracts.js';
import { baseCategory, categoryId, fixture, frequencyResponses, groupId, month, newId, otherGroupId, root } from './fixtures.js';

const routes: { name: ToolName; args: JsonObject; method: string; path: string; body: JsonObject; key?: string; bad: JsonObject }[] = [
  { name: 'ynab_create_category_group', args: { name: 'New group' }, method: 'POST', path: `${root}/category_groups`, body: { category_group: { name: 'New group' } }, bad: { name: '' } },
  { name: 'ynab_update_category_group', args: { category_group_id: groupId, name: 'New group' }, method: 'PATCH', path: `${root}/category_groups/${groupId}`, body: { category_group: { name: 'New group' } }, key: `category_group:${groupId}`, bad: { category_group_id: groupId, name: 'x'.repeat(51) } },
  { name: 'ynab_create_category', args: { category: { name: 'New category', category_group_id: groupId, note: null } }, method: 'POST', path: `${root}/categories`, body: { category: { name: 'New category', category_group_id: groupId, note: null } }, bad: { category: { name: '', category_group_id: groupId } } },
  { name: 'ynab_update_category', args: { category_id: categoryId, changes: { name: 'New category', note: null, category_group_id: otherGroupId } }, method: 'PATCH', path: `${root}/categories/${categoryId}`, body: { category: { name: 'New category', note: null, category_group_id: otherGroupId } }, key: `category:${categoryId}`, bad: { category_id: categoryId, changes: { hidden: true } } },
  { name: 'ynab_set_category_assignment', args: { category_id: categoryId, month, budgeted: -1000 }, method: 'PATCH', path: `${root}/months/${month}/categories/${categoryId}`, body: { category: { budgeted: -1000 } }, key: `category:${categoryId}:${month}`, bad: { category_id: categoryId, month: 'current', budgeted: 1 } },
];
async function call(f: ReturnType<typeof fixture>, name: ToolName, args: JsonObject): Promise<ToolResult> {
  const result = (await f.dispatcher.callTool(name, args)).structuredContent;
  expect(outputValidators.get(name)!(result), JSON.stringify(outputValidators.get(name)!.errors)).toBe(true);
  return result;
}
async function execute(f: ReturnType<typeof fixture>, name: ToolName, args: JsonObject): Promise<ToolResult> {
  const preview = await call(f, name, args);
  expect(preview.status).toBe('preview');
  if (preview.status !== 'preview') throw new Error(JSON.stringify(preview));
  const revision = Object.values(preview.preview.expected_revisions)[0];
  return call(f, name, { ...args, dry_run: false, ...(revision ? { expected_revision: revision } : {}) });
}
function error(result: ToolResult, code: string, outcome = 'not_applied') {
  expect(result).toMatchObject({ status: 'error', error: { code, outcome, retryable: false } });
}

describe('five category routes with real SafetyState', () => {
  it('exports exactly the owned handlers', () => {
    expect(Object.keys(fixture().handlers).sort()).toEqual(routes.map(r => r.name).sort());
  });
  for (const route of routes) {
    it(`${route.name}: schema-valid preview and exact live request`, async () => {
      const f = fixture();
      expect(inputValidators.get(route.name)!(route.args)).toBe(true);
      const preview = await call(f, route.name, route.args);
      expect(preview.status).toBe('preview');
      if (preview.status !== 'preview') throw new Error(JSON.stringify(preview));
      expect(preview.preview).toMatchObject({ method: route.method, path: route.path, body: route.body, validated: true, unknown_effects: false });
      expect(f.mutations()).toEqual([]);
      expect(Object.keys(preview.preview.expected_revisions)).toEqual(route.key ? [route.key] : []);
      const expected = route.key ? preview.preview.expected_revisions[route.key] : undefined;
      const result = await call(f, route.name, { ...route.args, dry_run: false, ...(expected ? { expected_revision: expected } : {}) });
      expect(result.status, JSON.stringify(result)).toBe('ok');
      expect(f.mutations()).toEqual([{ method: route.method, path: route.path, body: route.body }]);
      if (result.status === 'ok') expect(Object.keys(result.meta.revisions!)).toEqual([route.key ?? `${route.name.includes('group') ? 'category_group' : 'category'}:${newId}`]);
      if (route.name === 'ynab_set_category_assignment') {
        expect(preview.preview.before[0]!.budgeted).toBe(7000);
        expect(result.meta.resolved_month).toBe(month);
        expect(f.requests.filter(r => r.method === 'GET').every(r => !r.query)).toBe(true);
        expect(f.category.budgeted).toBe(10000);
      }
    });
    it(`${route.name}: invalid input, denied policy, and acknowledged mismatch`, async () => {
      const f = fixture();
      error(await call(f, route.name, route.bad), 'validation_error');
      expect(f.requests).toEqual([]);
      const denied = fixture({ readOnly: true });
      error(await call(denied, route.name, route.args), 'permission_denied');
      expect(denied.requests).toEqual([]);
      f.controls.mismatch = true;
      error(await execute(f, route.name, route.args), 'verification_failed', 'applied');
      expect(f.mutations()).toHaveLength(1);
    });
    it(`${route.name}: absent save entity uses fresh verification`, async () => {
      const f = fixture(); f.controls.omitEntity = true;
      expect((await execute(f, route.name, route.args)).status).toBe('ok');
      const index = f.requests.findIndex(r => r.method !== 'GET');
      expect(f.requests.slice(index + 1).some(r => r.method === 'GET')).toBe(true);
      expect(f.mutations()).toHaveLength(1);
    });
    if (route.key) {
      it(`${route.name}: missing and stale execution revisions never write`, async () => {
        const f = fixture();
        error(await call(f, route.name, { ...route.args, dry_run: false }), 'validation_error');
        error(await call(f, route.name, { ...route.args, dry_run: false, expected_revision: `sha256:${'0'.repeat(64)}` }), 'conflict');
        expect(f.mutations()).toEqual([]);
      });
    }
  }
});

describe('category and group context', () => {
  it.each(['internal', 'deleted'])('rejects %s groups for rename and create/move', async field => {
    const f = fixture(); f.groups[0]![field] = true;
    for (const [name, args] of [
      ['ynab_update_category_group', { category_group_id: groupId, name: 'Rename' }],
      ['ynab_create_category', { category: { name: 'Create', category_group_id: groupId } }],
      ['ynab_update_category', { category_id: categoryId, changes: { category_group_id: groupId } }],
    ] as [ToolName, JsonObject][]) {
      expect((await call(f, name, args)).status).toBe('error');
    }
    expect(f.mutations()).toEqual([]);
  });
  it('requires an existing destination group', async () => {
    const f = fixture();
    error(await call(f, 'ynab_create_category', { category: { name: 'Create', category_group_id: newId } }), 'validation_error');
    error(await call(f, 'ynab_update_category', { category_id: categoryId, changes: { category_group_id: newId } }), 'validation_error');
    expect(f.mutations()).toEqual([]);
  });
  it.each(['internal', 'deleted'])('rejects %s categories for metadata and assignment', async field => {
    const f = fixture(); f.category[field] = true; f.assignment[field] = true;
    expect((await call(f, 'ynab_update_category', { category_id: categoryId, changes: { note: null } })).status).toBe('error');
    expect((await call(f, 'ynab_set_category_assignment', { category_id: categoryId, month, budgeted: 0 })).status).toBe('error');
    expect(f.mutations()).toEqual([]);
  });
  it('warns about hidden categories and groups, without rejecting assignments', async () => {
    const f = fixture(); f.groups[0]!.hidden = true; f.assignment.hidden = true;
    const result = await call(f, 'ynab_set_category_assignment', { category_id: categoryId, month, budgeted: 0 });
    expect(result.status).toBe('preview');
    if (result.status === 'preview') expect(result.preview.warnings.join(' ')).toMatch(/hidden/i);
  });
  it('allows group names at both bounds and long category names', async () => {
    for (const name of ['x', 'x'.repeat(50)]) expect((await call(fixture(), 'ynab_create_category_group', { name })).status).toBe('preview');
    expect((await call(fixture(), 'ynab_create_category', { category: { name: 'x'.repeat(501), category_group_id: groupId } })).status).toBe('preview');
  });
  it.each([{ changes: {} }, { changes: { goal_type: 'NEED' } }, { changes: { goal_target: 1.5 } }, { changes: { goal_target: -1 } }, { changes: { goal_target: Number.MAX_SAFE_INTEGER + 1 } }] as JsonObject[])('rejects invalid mutable fields: %j', async args => {
    const f = fixture(); error(await call(f, 'ynab_update_category', { category_id: categoryId, ...args }), 'validation_error');
    expect(f.requests).toEqual([]);
  });
  it.each(['2026-02-30', '0000-01-01', '2026-10-02'])('requires an exact valid assignment month %s', async value => {
    const f = fixture(); error(await call(f, 'ynab_set_category_assignment', { category_id: categoryId, month: value, budgeted: 0 }), 'validation_error');
    expect(f.mutations()).toEqual([]);
  });
});

describe('pinned target comparisons', () => {
  it.each(Object.entries(frequencyResponses))('validates representative %s read fixture and transformed write', async (frequency, expected) => {
    const f = fixture();
    expect(outputValidators.get('ynab_update_category')!({ status: 'ok', data: { category: { ...baseCategory, ...expected }, server_knowledge: 1 }, meta: { request_id: 'fixture', fetched_at: '2026-10-07T00:00:00.000Z', warnings: [] } })).toBe(true);
    expect(expected).not.toHaveProperty('goal_frequency');
    const changes = { goal_target: 42000, goal_frequency: frequency, goal_needs_whole_amount: true };
    const result = await execute(f, 'ynab_update_category', { category_id: categoryId, changes });
    expect(result.status, JSON.stringify(result)).toBe('ok');
    expect(f.mutations()).toEqual([{ method: 'PATCH', path: `${root}/categories/${categoryId}`, body: { category: changes } }]);
    expect(f.category).toMatchObject({ ...expected, goal_needs_whole_amount: true, note: 'Keep this note' });
  });
  it.each(['goal_type', 'goal_target', 'goal_cadence', 'goal_cadence_frequency'])('rejects acknowledged recurring target mismatch in %s', async field => {
    const f = fixture(); f.controls.transform = row => { row[field] = field === 'goal_type' ? 'MF' : 99; };
    error(await execute(f, 'ynab_update_category', { category_id: categoryId, changes: { goal_target: 42000, goal_frequency: 'weekly' } }), 'verification_failed', 'applied');
  });
  it.each([
    { goal_frequency: 'weekly' }, { goal_target: null, goal_frequency: 'monthly' },
    { goal_target: 1, goal_frequency: 'yearly', goal_target_date: null },
    { goal_target: null, goal_needs_whole_amount: true }, { goal_needs_whole_amount: null },
    { goal_target_date: '2026-02-30' },
  ] as JsonObject[])('rejects unsupported or invalid target combination %j', async changes => {
    const f = fixture(); expect((await call(f, 'ynab_update_category', { category_id: categoryId, changes })).status).toBe('error');
    expect(f.mutations()).toEqual([]);
  });
  it('compares removal to absent target, not just an echoed null amount', async () => {
    const f = fixture(); expect((await execute(f, 'ynab_update_category', { category_id: categoryId, changes: { goal_target: null } })).status).toBe('ok');
    expect(f.mutations()[0]!.body).toEqual({ category: { goal_target: null } });
    const bad = fixture(); bad.controls.transform = row => { row.goal_type = 'NEED'; };
    error(await execute(bad, 'ynab_update_category', { category_id: categoryId, changes: { goal_target: null } }), 'verification_failed', 'applied');
  });
  it.each([{ goal_target: 8000 }, { goal_target_date: '2027-01-01' }, { goal_target_date: null }, { goal_needs_whole_amount: false }] as JsonObject[])('verifies supported direct target form %j', async changes => {
    const f = fixture(); expect((await execute(f, 'ynab_update_category', { category_id: categoryId, changes })).status).toBe('ok');
    expect(f.mutations()[0]!.body).toEqual({ category: changes });
    expect(f.category.goal_cadence).toBe(1);
  });
  it('creates a recurring target with only documented write fields', async () => {
    const f = fixture();
    const category = { name: 'New target', category_group_id: groupId, goal_target: 42000, goal_frequency: 'yearly' };
    expect((await execute(f, 'ynab_create_category', { category })).status).toBe('ok');
    expect(f.mutations()[0]!.body).toEqual({ category });
  });
  it.each(['DEBT', 'creditCard', 'loanAccount'])('restricts special category %s target forms', async kind => {
    const f = fixture();
    if (kind === 'DEBT') f.category.goal_type = 'DEBT';
    else if (kind === 'creditCard') f.groups[0]!.name = 'Credit Card Payments';
    else f.accounts.push({ id: newId, name: 'Groceries', type: 'mortgage', on_budget: false, closed: false, deleted: false, balance: 0, cleared_balance: 0, uncleared_balance: 0, transfer_payee_id: null });
    for (const changes of [{ goal_target: 1, goal_frequency: 'monthly' }, { goal_needs_whole_amount: true }] as JsonObject[]) {
      error(await call(f, 'ynab_update_category', { category_id: categoryId, changes }), 'unsupported_operation');
    }
    if (kind !== 'creditCard') error(await call(f, 'ynab_update_category', { category_id: categoryId, changes: { goal_target_date: null } }), 'unsupported_operation');
    expect(f.mutations()).toEqual([]);
  });
  it('preserves loan DEBT target type for amount-only edits', async () => {
    const f = fixture(); f.category.goal_type = 'DEBT';
    expect((await execute(f, 'ynab_update_category', { category_id: categoryId, changes: { goal_target: 9000 } })).status).toBe('ok');
    expect(f.mutations()[0]!.body).toEqual({ category: { goal_target: 9000 } });
    expect(f.category.goal_type).toBe('DEBT');
    const bad = fixture(); bad.category.goal_type = 'DEBT'; bad.controls.transform = row => { row.goal_type = 'NEED'; };
    error(await execute(bad, 'ynab_update_category', { category_id: categoryId, changes: { goal_target: 9000 } }), 'verification_failed', 'applied');
  });
  it('does not allow rollover on existing non-NEED goals, unless frequency replaces them', async () => {
    const f = fixture(); f.category.goal_type = 'MF';
    error(await call(f, 'ynab_update_category', { category_id: categoryId, changes: { goal_needs_whole_amount: true } }), 'unsupported_operation');
    expect((await execute(f, 'ynab_update_category', { category_id: categoryId, changes: { goal_target: 42000, goal_frequency: 'monthly', goal_needs_whole_amount: false } })).status).toBe('ok');
  });
  it('does not confirm an amount when the returned target remains inactive', async () => {
    const f = fixture(); f.controls.transform = row => { row.goal_type = null; };
    error(await execute(f, 'ynab_update_category', { category_id: categoryId, changes: { goal_target: 42000 } }), 'verification_failed', 'applied');
  });
  it('cannot bypass loan restrictions by renaming the category in the same patch', async () => {
    const f = fixture();
    f.accounts.push({ id: newId, name: 'Groceries', type: 'mortgage', on_budget: false, closed: false, deleted: false, balance: 0, cleared_balance: 0, uncleared_balance: 0, transfer_payee_id: null });
    error(await call(f, 'ynab_update_category', { category_id: categoryId, changes: { name: 'Renamed', goal_target: 42000, goal_frequency: 'weekly' } }), 'unsupported_operation');
    expect(f.mutations()).toEqual([]);
  });
  it('cannot bypass Credit Card Payment restrictions by moving to another group', async () => {
    const f = fixture(); f.groups[0]!.name = 'Credit Card Payments';
    error(await call(f, 'ynab_update_category', { category_id: categoryId, changes: { category_group_id: otherGroupId, goal_target: 42000, goal_frequency: 'monthly' } }), 'unsupported_operation');
    expect(f.mutations()).toEqual([]);
  });
  it.each([{ goal_target_date: '2027-01-01' }, { goal_needs_whole_amount: true }] as JsonObject[])('does not confirm ignored direct target fields %j', async changes => {
    const f = fixture(); f.controls.transform = row => { Object.assign(row, { goal_target_date: null, goal_needs_whole_amount: false }); };
    error(await execute(f, 'ynab_update_category', { category_id: categoryId, changes }), 'verification_failed', 'applied');
  });
  it('reports absent create entity with no unique fresh match as applied/unverified', async () => {
    const f = fixture(); f.controls.omitEntity = true; f.controls.missingCreated = true;
    error(await execute(f, 'ynab_create_category', { category: { name: 'Missing', category_group_id: groupId } }), 'verification_failed', 'applied');
    expect(f.mutations()).toHaveLength(1);
  });
});
