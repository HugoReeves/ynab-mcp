import { expect, it, describe } from 'vitest';
import { createReadTools } from '../../src/tools/read.js';
import { createSafetyState } from '../../src/safety/index.js';
import { createDispatcher } from '../../src/runtime/dispatcher.js';
import { catalog, outputValidators } from '../../src/catalog.js';
import { ToolFailure } from '../../src/errors.js';
import type { ApiRequest, Config, JsonObject, ToolName } from '../../src/contracts.js';
const p = '11111111-1111-4111-8111-111111111111';
const id = '22222222-2222-4222-8222-222222222222';
const base = `/plans/${p}`;
const stamp = '2024-02-29T23:59:00.000Z';
const account = { id, name: 'Fixture account', type: 'checking', on_budget: true, closed: false, deleted: false, balance: 10, cleared_balance: 10, uncleared_balance: 0, transfer_payee_id: id };
const category = { id, category_group_id: p, name: 'Fixture category', hidden: false, internal: false, deleted: false, budgeted: 10, activity: -5, balance: 5 };
const group = { id: p, name: 'Fixture group', hidden: false, internal: false, deleted: false, categories: [category] };
const month = { month: '2024-02-01', income: 10, budgeted: 10, activity: -5, to_be_budgeted: 0, deleted: false };
const payee = { id, name: 'Fixture payee', deleted: false, transfer_account_id: null };
const transaction = { id: 'txn-1', account_id: id, account_name: 'Fixture account', date: '2024-02-29', amount: -5, approved: false, cleared: 'uncleared', deleted: false, subtransactions: [] };
const scheduled = { id, account_id: id, account_name: 'Fixture account', date_first: '2024-02-01', date_next: '2024-03-01', amount: -5, frequency: 'monthly', deleted: false, subtransactions: [] };
const settings = { date_format: { format: 'YYYY-MM-DD' }, currency_format: { iso_code: 'USD', example_format: '123,456.78', decimal_digits: 2, decimal_separator: '.', symbol_first: true, group_separator: ',', currency_symbol: '$', display_symbol: true } };
interface Fixture { name: ToolName; args: JsonObject; request: ApiRequest; data: JsonObject }
// Literal route/query expectations derived from the pinned endpoint tables, not production builders.
const fixtures: Fixture[] = [
  { name: 'ynab_get_user', args: {}, request: { method: 'GET', path: '/user' }, data: { user: { id } } },
  { name: 'ynab_list_plans', args: {}, request: { method: 'GET', path: '/plans', query: { include_accounts: false } }, data: { plans: [{ id: p, name: 'Fixture plan' }], default_plan: null } },
  { name: 'ynab_get_plan_settings', args: {}, request: { method: 'GET', path: `${base}/settings` }, data: { settings } },
  { name: 'ynab_list_accounts', args: {}, request: { method: 'GET', path: `${base}/accounts` }, data: { accounts: [account], server_knowledge: 5 } },
  { name: 'ynab_get_account', args: { account_id: id }, request: { method: 'GET', path: `${base}/accounts/${id}` }, data: { account } },
  { name: 'ynab_list_categories', args: {}, request: { method: 'GET', path: `${base}/categories` }, data: { category_groups: [group], server_knowledge: 5 } },
  { name: 'ynab_get_category', args: { category_id: id }, request: { method: 'GET', path: `${base}/categories/${id}` }, data: { category } },
  { name: 'ynab_list_months', args: {}, request: { method: 'GET', path: `${base}/months` }, data: { months: [month], server_knowledge: 5 } },
  { name: 'ynab_get_month', args: { month: 'current' }, request: { method: 'GET', path: `${base}/months/2024-02-01` }, data: { month: { ...month, categories: [category] } } },
  { name: 'ynab_list_payees', args: {}, request: { method: 'GET', path: `${base}/payees` }, data: { payees: [payee], server_knowledge: 5 } },
  { name: 'ynab_get_payee', args: { payee_id: id }, request: { method: 'GET', path: `${base}/payees/${id}` }, data: { payee } },
  { name: 'ynab_list_transactions', args: {}, request: { method: 'GET', path: `${base}/transactions`, query: { since_date: '2023-02-28' } }, data: { transactions: [transaction], server_knowledge: 5 } },
  { name: 'ynab_get_transaction', args: { transaction_id: 'txn-1' }, request: { method: 'GET', path: `${base}/transactions/txn-1` }, data: { transaction, server_knowledge: 5 } },
  { name: 'ynab_list_scheduled_transactions', args: {}, request: { method: 'GET', path: `${base}/scheduled_transactions` }, data: { scheduled_transactions: [scheduled], server_knowledge: 5 } },
  { name: 'ynab_get_scheduled_transaction', args: { scheduled_transaction_id: id }, request: { method: 'GET', path: `${base}/scheduled_transactions/${id}` }, data: { scheduled_transaction: scheduled } },
  { name: 'ynab_list_money_movements', args: {}, request: { method: 'GET', path: `${base}/money_movements` }, data: { money_movements: [{ id, amount: 10 }], server_knowledge: 5 } },
  { name: 'ynab_list_money_movement_groups', args: {}, request: { method: 'GET', path: `${base}/money_movement_groups` }, data: { money_movement_groups: [{ id, month: '2024-02-01', group_created_at: stamp }], server_knowledge: 5 } },
];
function setup(data: JsonObject, patch: Partial<Config> = {}) {
  let now = Date.parse(stamp); let error: ToolFailure | undefined;
  const requests: ApiRequest[] = [];
  const config: Config = { defaultPlanId: p, allowedPlanIds: [p], readOnly: true, allowDeletes: false, allowImports: false, allowReconciledChanges: false, toolProfile: 'extended', timeoutMs: 60000, cacheTtlSeconds: 30, logLevel: 'error', ...patch };
  const clock = { now: () => now };
  const api = { async request(_ctx: unknown, req: ApiRequest) { requests.push(req); if (error) throw error; return { data: structuredClone(data), fetchedAt: stamp, rateLimit: { used: 1, limit: 200 } }; } };
  const state = createSafetyState(config, api, clock);
  const handlers = createReadTools({ config, api, clock, state });
  const dispatcher = createDispatcher({ config, api, clock, state }, handlers);
  return { handlers, requests, state, call: async (name: ToolName, args: JsonObject = {}) => (await dispatcher.callTool(name, args)).structuredContent, advance: (ms: number) => { now += ms; }, fail: () => { error = new ToolFailure({ code: 'not_found', message: 'Fixture absent', outcome: 'not_applied', retryable: false }); } };
}
describe('17 read fixtures through real dispatcher and safety', () => {
  it('exports exactly the read-only catalog tools', () => expect(Object.keys(setup({}).handlers).sort()).toEqual(catalog.filter(t => t.annotations.readOnlyHint).map(t => t.name).sort()));
  for (const f of fixtures) {
    it(`${f.name}: positive wrapper/schema and exact request`, async () => {
      const s = setup(f.data); const result = await s.call(f.name, f.args);
      expect(result.status).toBe('ok'); expect(outputValidators.get(f.name)!(result)).toBe(true);
      if (result.status === 'ok') { expect(result.data).toEqual(f.data); expect(result.meta.fetched_at).toBe(stamp); expect(result.meta.rate_limit).toEqual({ used: 1, limit: 200 }); }
      expect(s.requests).toEqual([f.request]);
    });
    it(`${f.name}: upstream failure is structured and never mutates`, async () => {
      const s = setup(f.data); s.fail(); const r = await s.call(f.name, f.args);
      expect(r.status).toBe('error'); if (r.status === 'error') expect(r.error.code).toBe('not_found');
      expect(outputValidators.get(f.name)!(r)).toBe(true); expect(s.requests).toEqual([f.request]);
    });
  }
});
describe('selectors, deltas, snapshots and revisions', () => {
  for (const [scope, route] of [
    [{ kind: 'plan' }, '/transactions'], [{ kind: 'account', account_id: id }, `/accounts/${id}/transactions`],
    [{ kind: 'category', category_id: id }, `/categories/${id}/transactions`], [{ kind: 'payee', payee_id: id }, `/payees/${id}/transactions`],
    [{ kind: 'month', month: 'current' }, '/months/2024-02-01/transactions'],
  ] as const) it(`transaction ${scope.kind} forwards supported queries`, async () => {
    const row = ['category', 'payee'].includes(scope.kind) ? { ...transaction, type: 'subtransaction', parent_transaction_id: 'parent' } : transaction;
    const s = setup({ transactions: [row], server_knowledge: 5 });
    const r = await s.call('ynab_list_transactions', { scope, since_date: '2024-02-02', until_date: '2024-02-29', type: 'unapproved' });
    expect(r.status).toBe('ok'); expect(s.requests).toEqual([{ method: 'GET', path: base + route, query: { since_date: '2024-02-02', until_date: '2024-02-29', type: 'unapproved' } }]);
    if (r.status === 'ok') { expect(r.meta.revisions).toBeUndefined(); expect(r.meta.resolved_scope).toEqual(scope.kind === 'month' ? { kind: 'month', month: '2024-02-01' } : scope); expect(r.meta.warnings.join(' ')).toMatch(/pending/i); }
  });
  it('month scope has no default since date; date conflicts fail before GET', async () => {
    const s = setup({ transactions: [], server_knowledge: 5 });
    const r = await s.call('ynab_list_transactions', { scope: { kind: 'month', month: 'current' } });
    expect(r.status).toBe('ok'); expect(s.requests).toEqual([{ method: 'GET', path: `${base}/months/2024-02-01/transactions` }]);
    for (const args of [ { since_date: '2024-03-01', until_date: '2024-02-01' }, { scope: { kind: 'month', month: 'current' }, since_date: '2024-03-01' }, { scope: { kind: 'month', month: 'current' }, until_date: '2024-01-31' } ] as JsonObject[]) {
      const x = setup({}); const bad = await x.call('ynab_list_transactions', args); expect(bad.status).toBe('error'); expect(x.requests).toEqual([]);
    }
  });
  for (const type of ['unapproved', 'uncategorized']) it(`${type} delta forwards the filter and warns about exiting rows`, async () => {
    const s = setup({ transactions: [], server_knowledge: 5 });
    const r = await s.call('ynab_list_transactions', { type, last_knowledge_of_server: 0 });
    expect(r.status).toBe('ok');
    expect(s.requests).toEqual([{ method: 'GET', path: `${base}/transactions`, query: { since_date: '2023-02-28', type, last_knowledge_of_server: 0 } }]);
    if (r.status === 'ok') {
      expect(r.meta.mode).toBe('delta');
      expect(r.meta.warnings.join(' ')).toMatch(/rows.*(?:exit|stop).*filter.*omitted/i);
      expect(r.meta.warnings.join(' ')).toMatch(/full refresh.*required/i);
    }
  });
  for (const f of fixtures.filter(f => ['ynab_list_accounts', 'ynab_list_categories', 'ynab_list_months', 'ynab_list_payees', 'ynab_list_transactions', 'ynab_list_scheduled_transactions'].includes(f.name))) it(`${f.name} delta keeps tombstones without revisions`, async () => {
    const collection = catalog.find(t => t.name === f.name)!.pageCollection!;
    const rows = f.data[collection] as JsonObject[];
    const s = setup({ ...f.data, [collection]: rows.map(row => ({ ...row, deleted: true })) });
    const r = await s.call(f.name, { last_knowledge_of_server: 0 }); expect(r.status).toBe('ok');
    expect(s.requests[0]?.query).toEqual({ ...(f.request.query ?? {}), last_knowledge_of_server: 0 });
    if (r.status === 'ok') { expect(r.meta.mode).toBe('delta'); expect(r.meta.revisions).toBeUndefined(); expect(r.meta.warnings.join(' ')).toMatch(/not.*snapshot|not.*complete/i); expect((r.data[collection] as JsonObject[])[0]?.deleted).toBe(true); }
  });
  it('filters both plans and default_plan before paging, including empty allowlist', async () => {
    const data = { plans: [{ id, name: 'Denied' }, { id: p, name: 'Allowed' }], default_plan: { id, name: 'Denied' } };
    const s = setup(data); const r = await s.call('ynab_list_plans', { include_accounts: true, page_size: 1 });
    expect(s.requests).toEqual([{ method: 'GET', path: '/plans', query: { include_accounts: true } }]);
    if (r.status !== 'ok') throw Error('not ok'); expect(r.data).toEqual({ plans: [{ id: p, name: 'Allowed' }], default_plan: null }); expect(r.meta.total_count).toBe(1); expect(r.meta.complete).toBe(true);
    const empty = await setup(data, { allowedPlanIds: [] }).call('ynab_list_plans'); if (empty.status !== 'ok') throw Error('not ok'); expect(empty.data.plans).toEqual([]); expect(empty.data.default_plan).toBeNull(); expect(empty.meta.returned_count).toBe(0);
  });
  for (const name of ['ynab_list_transactions', 'ynab_list_money_movements', 'ynab_list_money_movement_groups'] as const) it(`${name} continuation freezes current/default date and source without refetch`, async () => {
    const f = fixtures.find(f => f.name === name)!; const collection = catalog.find(t => t.name === name)!.pageCollection!;
    const s = setup({ ...f.data, [collection]: [...f.data[collection] as JsonObject[], ...f.data[collection] as JsonObject[]] });
    const args: JsonObject = name === 'ynab_list_transactions' ? { page_size: 1 } : { page_size: 1, month: 'current' };
    const first = await s.call(name, args); if (first.status !== 'ok') throw Error('not ok'); s.advance(120000);
    const second = await s.call(name, { ...args, cursor: first.meta.next_cursor! }); if (second.status !== 'ok') throw Error('not ok');
    expect(s.requests).toHaveLength(1); expect(second.meta.fetched_at).toBe(stamp); expect(second.meta.resolved_month).toBe(first.meta.resolved_month); expect(second.meta.resolved_since_date).toBe(first.meta.resolved_since_date); expect(second.meta.request_id).not.toBe(first.meta.request_id); expect(second.meta.complete).toBe(true);
  });
  it('opaque transaction detail IDs are routed by inspection, not a UUID-only builder', async () => {
    const s = setup({ transaction: { ...transaction, id: 'opaque:txn.1' }, server_knowledge: 5 });
    const r = await s.call('ynab_get_transaction', { transaction_id: 'opaque:txn.1' });
    expect(r.status).toBe('ok'); expect(s.requests).toEqual([{ method: 'GET', path: `${base}/transactions/opaque%3Atxn.1` }]);
  });
  it('details use inspection and context-specific category assignment revision', async () => {
    const s = setup({ category }); const r = await s.call('ynab_get_category', { category_id: id, month: 'current' });
    if (r.status !== 'ok') throw Error('not ok'); expect(s.requests).toEqual([{ method: 'GET', path: `${base}/months/2024-02-01/categories/${id}` }]); expect(r.meta.resolved_month).toBe('2024-02-01'); expect(r.meta.revisions?.[`category:${id}:2024-02-01`]).toMatch(/^sha256:/);
    for (const f of fixtures.filter(f => ['ynab_get_payee', 'ynab_get_category', 'ynab_get_transaction', 'ynab_get_scheduled_transaction'].includes(f.name))) { const x = setup(f.data); const a = await x.call(f.name, f.args); const b = await x.call(f.name, f.args); expect(x.requests).toHaveLength(2); if (a.status !== 'ok' || b.status !== 'ok') throw Error('not ok'); expect(a.meta.revisions).toEqual(b.meta.revisions); expect(Object.keys(a.meta.revisions!)).toHaveLength(1); }
  });
  it('full categories issue group revisions only and preserve whole children', async () => {
    const s = setup({ category_groups: [group, { ...group, id }], server_knowledge: 5 });
    const r = await s.call('ynab_list_categories', { page_size: 1 }); if (r.status !== 'ok') throw Error('not ok'); expect(r.data.category_groups).toEqual([group]); expect(Object.keys(r.meta.revisions!)).toEqual([`category_group:${p}`]);
  });
  for (const f of fixtures.filter(f => catalog.find(t => t.name === f.name)!.pageCollection)) it(`${f.name} zero result counts/schema`, async () => {
    const c = catalog.find(t => t.name === f.name)!.pageCollection!; const r = await setup({ ...f.data, [c]: [] }).call(f.name, f.args); expect(r.status).toBe('ok'); expect(outputValidators.get(f.name)!(r)).toBe(true); if (r.status === 'ok') expect(r.meta).toMatchObject({ total_count: 0, returned_count: 0, complete: true });
  });
});
