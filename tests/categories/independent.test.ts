import { describe, expect, it } from 'vitest';
import { catalog, inputValidators, outputValidators } from '../../src/catalog.js';
import type { JsonObject, ToolName, ToolResult } from '../../src/contracts.js';
import { categoryId, fixture, groupId, month, newId, otherGroupId, root } from './fixtures.js';

// Independent intent/response assertions; fixture injects fake YnabApi into real SafetyState.
// No network, token, environment-file access, or production edits.
async function call(f: ReturnType<typeof fixture>, name: ToolName, args: JsonObject): Promise<ToolResult> {
  const response = await f.dispatcher.callTool(name, args);
  expect(outputValidators.get(name)!(response.structuredContent)).toBe(true);
  expect(response.isError === true).toBe(response.structuredContent.status === 'error');
  return response.structuredContent;
}
async function execute(f: ReturnType<typeof fixture>, name: ToolName, args: JsonObject) {
  expect(inputValidators.get(name)!(args)).toBe(true);
  const preview = await call(f, name, args);
  expect(preview.status, JSON.stringify(preview)).toBe('preview');
  if (preview.status !== 'preview') throw new Error('Expected preview');
  expect(f.mutations()).toHaveLength(0);
  const revisions = Object.values(preview.preview.expected_revisions);
  const result = await call(f, name, { ...args, dry_run: false, ...(revisions.length ? { expected_revision: revisions[0]! } : {}) });
  expect(f.mutations()).toHaveLength(1);
  return { result, preview };
}
function unverified(result: ToolResult) {
  expect(result).toMatchObject({ status: 'error', error: { code: 'verification_failed', outcome: 'applied', retryable: false } });
}
const update = (changes: JsonObject): JsonObject => ({ category_id: categoryId, changes });
const account = (type: string): JsonObject => ({ id: newId, name: 'Groceries', type, on_budget: false, closed: false, deleted: false, balance: 0, cleared_balance: 0, uncleared_balance: 0, transfer_payee_id: null });

describe('independent categories positive contracts', () => {
  const cases: [ToolName, JsonObject, string, string, JsonObject][] = [
    ['ynab_create_category_group', { name: 'Independent' }, 'POST', `${root}/category_groups`, { category_group: { name: 'Independent' } }],
    ['ynab_update_category_group', { category_group_id: groupId, name: 'Independent' }, 'PATCH', `${root}/category_groups/${groupId}`, { category_group: { name: 'Independent' } }],
    ['ynab_create_category', { category: { name: 'Independent', category_group_id: otherGroupId, goal_target: 0 } }, 'POST', `${root}/categories`, { category: { name: 'Independent', category_group_id: otherGroupId, goal_target: 0 } }],
    ['ynab_update_category', update({ note: null, category_group_id: otherGroupId }), 'PATCH', `${root}/categories/${categoryId}`, { category: { note: null, category_group_id: otherGroupId } }],
    ['ynab_set_category_assignment', { category_id: categoryId, month, budgeted: 0 }, 'PATCH', `${root}/months/${month}/categories/${categoryId}`, { category: { budgeted: 0 } }],
  ];
  for (const [name, args, method, path, body] of cases) it(`${name}: real preview + verified execution`, async () => {
    const f = fixture();
    const { result, preview } = await execute(f, name, args);
    expect(preview.preview).toMatchObject({ method, path, body, validated: true, unknown_effects: false });
    expect(result.status, JSON.stringify(result)).toBe('ok');
    expect(f.mutations()).toEqual([{ method, path, body }]);
  });
  it('inventory audit: 35 unique catalog tools, only five positively exercised by this file', () => {
    // The requested 46-tool coverage claim is incompatible with this frozen catalog.
    expect(catalog).toHaveLength(35);
    expect(new Set(catalog.map(t => t.name)).size).toBe(35);
    expect(Object.keys(fixture().handlers).sort()).toEqual(cases.map(([name]) => name).sort());
  });
  it.each([-4500, 0, 1234])('assignment %i is absolute, isolated to the requested month, and repeatable', async budgeted => {
    const f = fixture();
    const args = { category_id: categoryId, month, budgeted };
    const { result, preview } = await execute(f, 'ynab_set_category_assignment', args);
    expect(result.status).toBe('ok');
    expect(preview.preview.before[0]).toMatchObject({ budgeted: 7000 });
    expect(f.assignment.budgeted).toBe(budgeted);
    expect(f.category.budgeted).toBe(10000);
    expect(result.meta.resolved_month).toBe(month);
    const next = await call(f, 'ynab_set_category_assignment', args);
    if (next.status !== 'preview') throw new Error(JSON.stringify(next));
    expect(next.preview.before[0]).toMatchObject({ budgeted });
    const again = await call(f, 'ynab_set_category_assignment', { ...args, dry_run: false, expected_revision: next.preview.expected_revisions[`category:${categoryId}:${month}`]! });
    expect(again.status).toBe('ok');
    expect(f.assignment.budgeted).toBe(budgeted);
    expect(f.mutations().map(r => r.body)).toEqual([{ category: { budgeted } }, { category: { budgeted } }]);
  });
  it.each([['monthly', 1], ['weekly', 2], ['yearly', 13]] as const)('%s replaces non-NEED target, read-side cadence %i', async (frequency, cadence) => {
    const f = fixture(); f.category.goal_type = 'TB';
    // Independent pinned Appendix 4 expectation, not the builder frequencyResponses table.
    f.controls.transform = row => Object.assign(row, { goal_type: 'NEED', goal_target: 0, goal_cadence: cadence, goal_cadence_frequency: 1 });
    const changes = { goal_target: 0, goal_frequency: frequency, goal_needs_whole_amount: false };
    const { result } = await execute(f, 'ynab_update_category', update(changes));
    expect(result.status).toBe('ok');
    expect(f.mutations()[0]!.body).toEqual({ category: changes });
    expect(f.category).not.toHaveProperty('goal_frequency');
  });
  it('removal accepts absent target fields, not just explicit nulls', async () => {
    const f = fixture(); f.controls.transform = row => { delete row.goal_type; delete row.goal_target; };
    expect((await execute(f, 'ynab_update_category', update({ goal_target: null }))).result.status).toBe('ok');
  });
});

describe('independent ignored fields and domain invariants', () => {
  it.each([
    [{ name: 'New' }, { name: 'Groceries' }],
    [{ note: null }, { note: 'Keep this note' }],
    [{ category_group_id: otherGroupId }, { category_group_id: groupId }],
    [{ goal_target: 0 }, { goal_target: 25000 }],
    [{ goal_target_date: null }, { goal_target_date: '2027-01-01' }],
    [{ goal_needs_whole_amount: true }, { goal_needs_whole_amount: false }],
    [{ goal_target: null }, { goal_type: null, goal_target: 25000 }],
    [{ goal_target: 42000, goal_frequency: 'weekly' }, { goal_cadence_frequency: 2 }],
  ] as [JsonObject, JsonObject][])('ignored update %j must not claim success', async (changes, observed) => {
    const f = fixture(); f.controls.transform = row => Object.assign(row, observed);
    unverified((await execute(f, 'ynab_update_category', update(changes))).result);
  });
  it('assignment acknowledgment of balance rather than budgeted cannot verify', async () => {
    const f = fixture(); f.controls.transform = row => Object.assign(row, { budgeted: 7000, balance: -123 });
    unverified((await execute(f, 'ynab_set_category_assignment', { category_id: categoryId, month, budgeted: -123 })).result);
  });
  it.each([{ goal_type: 'MF' }, { goal_type: null }, { goal_target: null }] as JsonObject[])('rollover acknowledgment must still describe an active NEED target: %j', async observed => {
    const f = fixture(); f.controls.transform = row => Object.assign(row, observed);
    unverified((await execute(f, 'ynab_update_category', update({ goal_needs_whole_amount: true }))).result);
  });
  it.each([['ordinary', 'NEED'], ['loan', 'DEBT'], ['payment', 'MF']])('amount-only creation accepts documented default %s/%s', async (kind, goalType) => {
    const f = fixture(); f.category.goal_type = null; f.category.goal_target = null;
    if (kind === 'loan') f.category.goal_type = 'DEBT';
    if (kind === 'payment') { f.groups[0]!.name = 'Credit Card Payments'; f.category.category_group_name = 'Credit Card Payments'; }
    f.controls.transform = row => { row.goal_type = goalType!; };
    expect((await execute(f, 'ynab_update_category', update({ goal_target: 0 }))).result.status).toBe('ok');
  });
  it.each(['ordinary', 'payment'])('amount-only creation enforces documented default target type: %s', async kind => {
    const f = fixture(); f.category.goal_type = null; f.category.goal_target = null;
    if (kind === 'payment') { f.groups[0]!.name = 'Credit Card Payments'; f.category.category_group_name = 'Credit Card Payments'; }
    // SaveCategory says new targets default to NEED / DEBT / MF, respectively.
    f.controls.transform = row => { row.goal_type = kind === 'ordinary' ? 'MF' : 'NEED'; };
    unverified((await execute(f, 'ynab_update_category', update({ goal_target: 0 }))).result);
  });
  it.each(['MF', 'TB', 'TBD', 'DEBT'])('amount-only edits preserve known %s type', async goalType => {
    const f = fixture(); f.category.goal_type = goalType;
    expect((await execute(f, 'ynab_update_category', update({ goal_target: 0 }))).result.status).toBe('ok');
    const bad = fixture(); bad.category.goal_type = goalType;
    bad.controls.transform = row => { row.goal_type = 'NEED'; };
    unverified((await execute(bad, 'ynab_update_category', update({ goal_target: 0 }))).result);
  });
  it.each([false, true])('create fallback retains expected default type (payment=%s)', async payment => {
    const args = { category: { name: 'New target', category_group_id: groupId, goal_target: 0 } };
    for (const correct of [true, false]) {
      const f = fixture(); f.controls.omitEntity = true;
      if (payment) f.groups[0]!.name = 'Credit Card Payments';
      f.controls.transform = row => { row.goal_type = correct ? payment ? 'MF' : 'NEED' : payment ? 'NEED' : 'MF'; };
      const { result } = await execute(f, 'ynab_create_category', args);
      if (correct) expect(result.status).toBe('ok'); else unverified(result);
      expect(f.mutations()).toHaveLength(1);
    }
  });
  it('loan-name-only missing target is blocked before submission, not guessed', async () => {
    const f = fixture(); f.category.goal_type = null; f.category.goal_target = null;
    f.accounts.push(account('mortgage'));
    const result = await call(f, 'ynab_update_category', update({ goal_target: 0 }));
    expect(result).toMatchObject({ status: 'error', error: { code: 'unsupported_operation', outcome: 'not_applied', retryable: false } });
    expect(f.mutations()).toHaveLength(0);
  });
  it('confirmed DEBT missing amount rejects a wrong-type acknowledgment without retry', async () => {
    const f = fixture(); f.category.goal_type = 'DEBT'; f.category.goal_target = null;
    f.controls.transform = row => { row.goal_type = 'NEED'; };
    unverified((await execute(f, 'ynab_update_category', update({ goal_target: 0 }))).result);
    expect(f.mutations()).toHaveLength(1);
  });
  it.each(['mortgage', 'autoLoan', 'studentLoan', 'personalLoan', 'medicalDebt', 'otherDebt', 'creditCard'])('%s account-name context cannot be bypassed by rename', async type => {
    const f = fixture(); f.accounts.push(account(type));
    const result = await call(f, 'ynab_update_category', update({ name: 'Unlinked?', goal_target: 100, goal_frequency: 'weekly' }));
    expect(result).toMatchObject({ status: 'error', error: { code: 'unsupported_operation', outcome: 'not_applied' } });
    expect(f.mutations()).toHaveLength(0);
  });
  it.each(['missing', 'deleted', 'internal'])('destination membership rejects %s group', async condition => {
    const f = fixture();
    if (condition === 'missing') f.groups.splice(1, 1); else f.groups[1]![condition] = true;
    const result = await call(f, 'ynab_update_category', update({ category_group_id: otherGroupId }));
    expect(result.status).toBe('error'); expect(f.mutations()).toHaveLength(0);
  });
  it('fresh destination membership is revalidated after a valid preview', async () => {
    const f = fixture(); const args = update({ category_group_id: otherGroupId });
    const preview = await call(f, 'ynab_update_category', args);
    if (preview.status !== 'preview') throw new Error(JSON.stringify(preview));
    f.groups[1]!.deleted = true;
    const result = await call(f, 'ynab_update_category', { ...args, dry_run: false, expected_revision: preview.preview.expected_revisions[`category:${categoryId}`]! });
    expect(result.status).toBe('error'); expect(f.mutations()).toHaveLength(0);
  });
  it.each([{ changes: { goal_cadence: 1 } }, { changes: { budgeted: 1 } }, { changes: { goal_frequency: 'daily', goal_target: 1 } }, { changes: { note: null }, rogue: true }] as JsonObject[])('rejects schema-shape violation %j before reads', async args => {
    const f = fixture();
    expect(await call(f, 'ynab_update_category', { category_id: categoryId, ...args })).toMatchObject({ status: 'error', error: { code: 'validation_error' } });
    expect(f.requests).toHaveLength(0);
  });
});
