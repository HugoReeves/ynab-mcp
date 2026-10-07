import { describe, expect, it } from 'vitest';
import { catalog, inputValidators, outputValidators } from '../../src/catalog.js';
import type { Config, JsonObject, OkResult, ToolName } from '../../src/contracts.js';
import { createApi } from '../../src/ynab/client.js';
import { createSafetyState } from '../../src/safety/index.js';
import { createReadTools } from '../../src/tools/read.js';
import { createDispatcher } from '../../src/runtime/dispatcher.js';

// Independent transport-backed fixtures: no production route builders or mocked safety.
const plan = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const denied = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const prefix = `/plans/${plan}`;
const stamp = '2024-02-29T23:59:30.000Z';
const account = { id, name: 'Cash', type: 'cash', on_budget: true, closed: false, deleted: false, balance: 123, cleared_balance: 100, uncleared_balance: 23, transfer_payee_id: denied };
const category = { id, category_group_id: denied, name: 'Hidden', hidden: true, internal: false, deleted: false, budgeted: -123, activity: 23, balance: -100, goal_target: 2000 };
const group = { id: denied, name: 'Group', hidden: true, internal: false, deleted: false, categories: [category] };
const payee = { id, name: 'Payee', transfer_account_id: null, deleted: false };
const txn = { id: 'parent', date: '2024-02-29', amount: -123, cleared: 'reconciled', approved: false, account_id: id, account_name: 'Cash', deleted: false, memo: 'Keep exactly', flag_color: null, subtransactions: [] };
const schedule = { id, date_first: '2024-02-29', date_next: '2024-03-01', frequency: 'monthly', amount: -123, account_id: id, account_name: 'Cash', deleted: false, subtransactions: [] };
const month = { month: '2024-02-01', income: 123, budgeted: -123, activity: 23, to_be_budgeted: 246, deleted: false };
const settings = { date_format: { format: 'YYYY-MM-DD' }, currency_format: { iso_code: 'JPY', example_format: '123', decimal_digits: 0, decimal_separator: '.', symbol_first: true, group_separator: ',', currency_symbol: '¥', display_symbol: true } };
interface Case { name: ToolName; args: JsonObject; path: string; data: JsonObject }
const cases: Case[] = [
  { name: 'ynab_get_user', args: {}, path: '/user', data: { user: { id } } },
  { name: 'ynab_list_plans', args: { include_accounts: true }, path: '/plans?include_accounts=true', data: { plans: [{ id: plan, name: 'Allowed', accounts: [account] }], default_plan: null } },
  { name: 'ynab_get_plan_settings', args: {}, path: `${prefix}/settings`, data: { settings } },
  { name: 'ynab_list_accounts', args: {}, path: `${prefix}/accounts`, data: { accounts: [account], server_knowledge: 9 } },
  { name: 'ynab_get_account', args: { account_id: id }, path: `${prefix}/accounts/${id}`, data: { account } },
  { name: 'ynab_list_categories', args: {}, path: `${prefix}/categories`, data: { category_groups: [group], server_knowledge: 9 } },
  { name: 'ynab_get_category', args: { category_id: id }, path: `${prefix}/categories/${id}`, data: { category } },
  { name: 'ynab_list_months', args: {}, path: `${prefix}/months`, data: { months: [month], server_knowledge: 9 } },
  { name: 'ynab_get_month', args: { month: 'current' }, path: `${prefix}/months/2024-02-01`, data: { month: { ...month, categories: [category] } } },
  { name: 'ynab_list_payees', args: {}, path: `${prefix}/payees`, data: { payees: [payee], server_knowledge: 9 } },
  { name: 'ynab_get_payee', args: { payee_id: id }, path: `${prefix}/payees/${id}`, data: { payee } },
  { name: 'ynab_list_transactions', args: {}, path: `${prefix}/transactions?since_date=2023-02-28`, data: { transactions: [txn], server_knowledge: 9 } },
  { name: 'ynab_get_transaction', args: { transaction_id: 'parent' }, path: `${prefix}/transactions/parent`, data: { transaction: txn, server_knowledge: 9 } },
  { name: 'ynab_list_scheduled_transactions', args: {}, path: `${prefix}/scheduled_transactions`, data: { scheduled_transactions: [schedule], server_knowledge: 9 } },
  { name: 'ynab_get_scheduled_transaction', args: { scheduled_transaction_id: id }, path: `${prefix}/scheduled_transactions/${id}`, data: { scheduled_transaction: schedule } },
  { name: 'ynab_list_money_movements', args: {}, path: `${prefix}/money_movements`, data: { money_movements: [{ id, amount: -123, amount_currency: -0.123 }], server_knowledge: 9 } },
  { name: 'ynab_list_money_movement_groups', args: {}, path: `${prefix}/money_movement_groups`, data: { money_movement_groups: [{ id, month: '2024-02-01', group_created_at: stamp }], server_knowledge: 9 } },
];
function harness(data: JsonObject | ((path: string) => JsonObject), patch: Partial<Config> = {}) {
  let now = Date.parse(stamp);
  const config: Config = { defaultPlanId: plan, allowedPlanIds: [plan], readOnly: true, allowDeletes: false, allowImports: false, allowReconciledChanges: false, toolProfile: 'extended', timeoutMs: 20000, cacheTtlSeconds: 0, logLevel: 'error', ...patch };
  const clock = { now: () => now };
  const calls: string[] = [];
  const api = createApi(config, `independent-fixture-${crypto.randomUUID()}`, async (url, init) => {
    expect(init?.method).toBe('GET');
    expect(init?.redirect).toBe('error');
    const u = new URL(String(url));
    expect(u.origin).toBe('https://api.ynab.com');
    const path = u.pathname.slice(3) + u.search;
    calls.push(path);
    return new Response(JSON.stringify({ data: typeof data === 'function' ? data(path) : data }), { status: 200 });
  }, clock);
  const state = createSafetyState(config, api, clock);
  const services = { config, api, clock, state };
  const dispatcher = createDispatcher(services, createReadTools(services));
  return { calls, dispatcher, advance: (ms: number) => { now += ms; }, call: async (name: ToolName, args: JsonObject = {}) => (await dispatcher.callTool(name, args)).structuredContent };
}
function ok(result: Awaited<ReturnType<ReturnType<typeof harness>['call']>>): OkResult {
  expect(result.status, JSON.stringify(result)).toBe('ok');
  if (result.status !== 'ok') throw Error('Expected success');
  return result;
}
function revision(result: OkResult): string {
  const values = Object.values(result.meta.revisions ?? {});
  expect(values).toHaveLength(1);
  expect(values[0]).toMatch(/^sha256:[a-f0-9]{64}$/);
  return values[0]!;
}
describe('independent read contract through real HTTP/safety/dispatcher', () => {
  it('covers every claimed read handler', () => {
    expect(cases.map(c => c.name).sort()).toEqual(catalog.filter(t => t.annotations.readOnlyHint).map(t => t.name).sort());
  });
  for (const c of cases) it(`${c.name}: schema-valid positive, exact GET route and untouched fields`, async () => {
    const h = harness(c.data);
    expect(inputValidators.get(c.name)!(c.args)).toBe(true);
    const r = ok(await h.call(c.name, c.args));
    expect(outputValidators.get(c.name)!(r)).toBe(true);
    expect(r.data).toEqual(c.data);
    expect(h.calls).toEqual([c.path]);
  });
  it('filters denied default_plan and nested account data before snapshot, including continuation', async () => {
    const h = harness({ plans: [{ id: denied, name: 'SECRET', accounts: [account] }, { id: plan, name: 'A' }, { id, name: 'B' }], default_plan: { id: denied, name: 'SECRET', accounts: [account] } }, { allowedPlanIds: [plan, id] });
    const a = ok(await h.call('ynab_list_plans', { page_size: 1 }));
    const b = ok(await h.call('ynab_list_plans', { page_size: 1, cursor: a.meta.next_cursor! }));
    expect(JSON.stringify([a, b])).not.toContain('SECRET');
    expect(a.data.default_plan).toBeNull(); expect(b.data.default_plan).toBeNull();
    expect(a.meta.total_count).toBe(2); expect(b.data.plans).toEqual([{ id, name: 'B' }]);
    expect(b.meta.complete).toBe(true); expect(h.calls).toHaveLength(1);
  });
  it('read-only/profile/direct-call permissions fail before network', async () => {
    const h = harness({}, { toolProfile: 'core' });
    expect(h.dispatcher.listTools().every(t => t.annotations.readOnlyHint && t.profile === 'core')).toBe(true);
    for (const [name, args] of [['ynab_list_accounts', { plan_id: denied }], ['ynab_list_money_movements', {}], ['ynab_update_transaction', { transaction_id: 'parent', changes: { approved: true }, dry_run: true }]] as [ToolName, JsonObject][]) {
      expect(await h.call(name, args)).toMatchObject({ status: 'error', error: { code: 'permission_denied', outcome: 'not_applied' } });
    }
    expect(h.calls).toEqual([]);
  });
  for (const kind of ['account', 'category', 'payee', 'month'] as const) it(`routes ${kind} scope; hybrid rows have no fabricated children or revisions`, async () => {
    const hybrid = { ...txn, type: 'subtransaction', parent_transaction_id: 'real-parent' } as JsonObject;
    delete hybrid.subtransactions;
    const isHybrid = kind === 'category' || kind === 'payee';
    const row = isHybrid ? hybrid : txn;
    const h = harness({ transactions: [row], server_knowledge: 99 });
    const scope = kind === 'month' ? { kind, month: 'current' } : { kind, [`${kind}_id`]: id };
    const r = ok(await h.call('ynab_list_transactions', { scope, since_date: '2024-02-01', until_date: '2024-02-29', last_knowledge_of_server: 8 }));
    const segment = kind === 'category' ? 'categories' : `${kind}s`;
    expect(h.calls).toEqual([`${prefix}/${segment}/${kind === 'month' ? '2024-02-01' : id}/transactions?since_date=2024-02-01&until_date=2024-02-29&last_knowledge_of_server=8`]);
    expect(r.data.transactions).toEqual([row]); expect(r.meta.revisions).toBeUndefined(); expect(r.meta.mode).toBe('delta');
  });
  it('frozen leap-day window survives midnight; mismatched and expired cursors do not fetch', async () => {
    const h = harness({ transactions: [txn, { ...txn, id: 'second', deleted: true }], server_knowledge: 10 });
    const args = { page_size: 1, last_knowledge_of_server: 0 };
    const a = ok(await h.call('ynab_list_transactions', args));
    h.advance(60000);
    const b = ok(await h.call('ynab_list_transactions', { ...args, cursor: a.meta.next_cursor! }));
    expect(b.meta.resolved_since_date).toBe('2023-02-28'); expect(b.meta.fetched_at).toBe(a.meta.fetched_at);
    expect(b.data.transactions).toEqual([{ ...txn, id: 'second', deleted: true }]);
    expect(await h.call('ynab_list_transactions', { ...args, page_size: 2, cursor: a.meta.next_cursor! })).toMatchObject({ error: { code: 'cursor_invalid' } });
    h.advance(300000);
    expect(await h.call('ynab_list_transactions', { ...args, cursor: a.meta.next_cursor! })).toMatchObject({ error: { code: 'cursor_invalid' } });
    expect(h.calls).toHaveLength(1);
  });
  it('invalid calendar dates/month intersections and undocumented money delta fail before GET', async () => {
    const h = harness({});
    for (const args of [{ since_date: '2023-02-29' }, { until_date: '2024-02-30' }, { since_date: '2024-03-01', until_date: '2024-02-29' }, { scope: { kind: 'month', month: '2024-02-01' }, since_date: '2024-03-01' }] as JsonObject[]) {
      expect(await h.call('ynab_list_transactions', args)).toMatchObject({ error: { code: 'validation_error' } });
    }
    expect(await h.call('ynab_list_money_movements', { last_knowledge_of_server: 0 })).toMatchObject({ error: { code: 'validation_error' } });
    expect(h.calls).toEqual([]);
  });
  it('transaction revision binds counterpart financial state and bypasses cached detail', async () => {
    let amount = 123;
    const h = harness(path => ({ server_knowledge: 9, transaction: path.endsWith('/other') ? { ...txn, id: 'other', amount, transfer_transaction_id: 'parent' } : { ...txn, transfer_transaction_id: 'other' } }), { cacheTtlSeconds: 300 });
    const a = ok(await h.call('ynab_get_transaction', { transaction_id: 'parent' }));
    amount++;
    const b = ok(await h.call('ynab_get_transaction', { transaction_id: 'parent' }));
    expect(revision(a)).not.toBe(revision(b));
    expect(h.calls).toEqual([`${prefix}/transactions/parent`, `${prefix}/transactions/other`, `${prefix}/transactions/parent`, `${prefix}/transactions/other`]);
    expect(a.data).toEqual(b.data);
  });
  it('category revisions separate metadata/month context and exclude derived goal progress', async () => {
    let progress = 1;
    const h = harness(() => ({ category: { ...category, goal_percentage_complete: progress } }));
    const a = ok(await h.call('ynab_get_category', { category_id: id }));
    progress++;
    const b = ok(await h.call('ynab_get_category', { category_id: id }));
    const feb = ok(await h.call('ynab_get_category', { category_id: id, month: 'current' }));
    const mar = ok(await h.call('ynab_get_category', { category_id: id, month: '2024-03-01' }));
    expect(revision(a)).toBe(revision(b)); expect(revision(a)).not.toBe(revision(feb)); expect(revision(feb)).not.toBe(revision(mar));
    expect(Object.keys(feb.meta.revisions!)).toEqual([`category:${id}:2024-02-01`]);
  });
  it('group revisions are page-local, nested children remain whole, and deltas issue none', async () => {
    const data = { category_groups: [group, { ...group, id }], server_knowledge: 10 };
    const h = harness(data);
    const a = ok(await h.call('ynab_list_categories', { page_size: 1 }));
    const b = ok(await h.call('ynab_list_categories', { page_size: 1, cursor: a.meta.next_cursor! }));
    expect(a.data.category_groups).toEqual([group]); expect(Object.keys(a.meta.revisions!)).toEqual([`category_group:${denied}`]);
    expect(Object.keys(b.meta.revisions!)).toEqual([`category_group:${id}`]);
    expect(ok(await h.call('ynab_list_categories', { last_knowledge_of_server: 1 })).meta.revisions).toBeUndefined();
  });
  it('SHARED HTTP BLOCKER: catalog-valid opaque ID reaches canonical encoded GET', async () => {
    const opaque = 'opaque:txn.1';
    const h = harness({ transaction: { ...txn, id: opaque }, server_knowledge: 9 });
    const args = { transaction_id: opaque };
    expect(inputValidators.get('ynab_get_transaction')!(args)).toBe(true);
    ok(await h.call('ynab_get_transaction', args));
    expect(h.calls).toEqual([`${prefix}/transactions/opaque%3Atxn.1`]);
  });
});
