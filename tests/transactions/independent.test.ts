import { describe, expect, it } from 'vitest';
import { createTransactionTools } from '../../src/tools/transactions.js';
import { createSafetyState } from '../../src/safety/index.js';
import { createDispatcher } from '../../src/runtime/dispatcher.js';
import { createApi, planPath } from '../../src/ynab/client.js';
import { inputValidators, outputValidators } from '../../src/catalog.js';
import { ToolFailure } from '../../src/errors.js';
import type { ApiRequest, Config, JsonObject, Services, ToolName } from '../../src/contracts.js';

const plan = '11111111-1111-4111-8111-111111111111';
const account = '22222222-2222-4222-8222-222222222222';
const category = '33333333-3333-4333-8333-333333333333';
const group = '44444444-4444-4444-8444-444444444444';
const destination = '55555555-5555-4555-8555-555555555555';
const transferPayee = '66666666-6666-4666-8666-666666666666';
const payee = '77777777-7777-4777-8777-777777777777';
const time = '2026-10-07T12:00:00.000Z';
const base = `/plans/${plan}`;
function row(id = 'tx-1', extra: JsonObject = {}): JsonObject {
  return { id, account_id: account, account_name: 'Fixture', date: '2026-10-01', amount: -1000,
    approved: false, cleared: 'uncleared', deleted: false, subtransactions: [], category_id: category,
    payee_id: payee, memo: 'unchanged', flag_color: 'blue', ...extra };
}
function acct(id = account, extra: JsonObject = {}): JsonObject {
  return { id, name: 'Fixture', type: 'checking', on_budget: true, closed: false, deleted: false,
    balance: 0, cleared_balance: 0, uncleared_balance: 0, transfer_payee_id: null, ...extra };
}
function cat(extra: JsonObject = {}): JsonObject {
  return { id: category, name: 'Fixture', category_group_id: group, hidden: false, internal: false,
    deleted: false, activity: 0, balance: 0, budgeted: 0, ...extra };
}
function harness(options: { config?: Partial<Config>; rows?: JsonObject[]; categories?: JsonObject[];
  groupName?: string; accounts?: JsonObject[]; reply?: JsonObject; ignore?: boolean;
  failure?: 'unknown' | 'conflict'; missingRead?: string; readTime?: string; http?: boolean } = {}) {
  const requests: ApiRequest[] = [];
  const rows = new Map((options.rows ?? [row(), row('tx-2')]).map(r => [String(r.id), structuredClone(r)]));
  const config: Config = { defaultPlanId: plan, allowedPlanIds: [plan], readOnly: false, allowDeletes: true,
    allowReconciledChanges: false, allowImports: true, toolProfile: 'extended', timeoutMs: 1000,
    cacheTtlSeconds: 30, logLevel: 'error', ...options.config };
  const api: Services['api'] = { async request(_ctx, request) {
    requests.push(structuredClone(request));
    let data: JsonObject;
    if (request.method === 'GET') {
      if (request.path === `${base}/accounts`) data = { accounts: options.accounts ?? [acct(), acct(destination, { transfer_payee_id: transferPayee })], server_knowledge: 1 };
      else if (request.path === `${base}/categories`) data = { category_groups: [{ id: group, name: options.groupName ?? 'Ordinary', hidden: false, deleted: false, internal: false, categories: options.categories ?? [cat()] }], server_knowledge: 1 };
      else if (request.path === `${base}/payees`) data = { payees: [{ id: payee, name: 'Fixture', deleted: false, transfer_account_id: null }, { id: transferPayee, name: 'Transfer', deleted: false, transfer_account_id: destination }], server_knowledge: 1 };
      else {
        const id = decodeURIComponent(request.path.split('/').at(-1)!);
        if (id === options.missingRead || !rows.has(id)) throw new ToolFailure({ code: 'not_found', message: 'Fixture absent', outcome: 'not_applied', retryable: false, http_status: 404 });
        data = { transaction: rows.get(id)!, server_knowledge: 1 };
      }
    } else {
      if (options.failure) throw new ToolFailure({ code: options.failure === 'unknown' ? 'timeout' : 'conflict', message: 'Fixture failure', outcome: options.failure === 'unknown' ? 'unknown' : 'not_applied', retryable: false });
      if (options.reply) data = structuredClone(options.reply);
      else if (request.path.endsWith('/import')) data = { transaction_ids: [] };
      else if (request.method === 'DELETE') {
        const id = request.path.split('/').at(-1)!; const saved = { ...rows.get(id)!, deleted: true }; rows.set(id, saved);
        data = { transaction: saved, server_knowledge: 2 };
      } else {
        const inputs = (request.body?.transactions ?? [request.body?.transaction]) as JsonObject[];
        const saved = inputs.map((input, i) => {
          const id = String(input.id ?? (request.method === 'PUT' ? request.path.split('/').at(-1)! : `new-${i}`));
          const old = rows.get(id) ?? row(id, { payee_id: null, category_id: null, memo: null, flag_color: null });
          const result = options.ignore ? old : { ...old, ...input, id };
          rows.set(id, result); return result;
        });
        data = request.method === 'PUT' ? { transaction: saved[0]!, server_knowledge: 2 }
          : { transaction_ids: saved.map(r => r.id!), transactions: saved.reverse(), server_knowledge: 2 };
      }
    }
    return { data: structuredClone(data), fetchedAt: request.method === 'GET' ? options.readTime ?? time : time };
  } };
  const clock = { now: () => Date.parse(time) };
  // Reuse fixture entity shapes, but optionally exercise the actual HTTP boundary too.
  const transport = options.http ? createApi(config, 'fake-independent-token', async (url, init) => {
    const request: ApiRequest = { method: init!.method as ApiRequest['method'], path: new URL(String(url)).pathname.replace(/^\/v1/, ''),
      ...(init!.body ? { body: JSON.parse(String(init!.body)) as JsonObject } : {}) };
    const reply = await api.request({} as Parameters<typeof api.request>[0], request);
    return new Response(JSON.stringify({ data: reply.data }), { status: 200 });
  }, clock) : api;
  const state = createSafetyState(config, transport, clock);
  const services = { config, api: transport, state, clock };
  const dispatch = createDispatcher(services, createTransactionTools(services));
  async function call(name: string, args: JsonObject) {
    const result = (await dispatch.callTool(`ynab_${name}`, args)).structuredContent;
    expect(outputValidators.get(`ynab_${name}` as ToolName)!(result)).toBe(true);
    return result;
  }
  async function revision(id = 'tx-1') {
    const result = await call('update_transaction', { transaction_id: id, changes: { memo: 'probe' } });
    if (result.status !== 'preview') throw new Error(JSON.stringify(result));
    return result.preview.expected_revisions[`transaction:${id}`]!;
  }
  return { call, revision, requests, rows, mutations: () => requests.filter(r => r.method !== 'GET') };
}

async function execute(h: ReturnType<typeof harness>, name: string, args: JsonObject) {
  expect(inputValidators.get(`ynab_${name}` as ToolName)!(args)).toBe(true);
  const preview = await h.call(name, args);
  expect(preview.status).toBe('preview');
  if (preview.status !== 'preview') throw new Error(JSON.stringify(preview));
  expect(h.mutations()).toEqual([]);
  const live = structuredClone(args); live.dry_run = false;
  if (typeof live.transaction_id === 'string') live.expected_revision = preview.preview.expected_revisions[`transaction:${live.transaction_id}`]!;
  if (name !== 'create_transactions' && Array.isArray(live.transactions)) for (const item of live.transactions as JsonObject[]) item.expected_revision = preview.preview.expected_revisions[`transaction:${item.id}`]!;
  expect(inputValidators.get(`ynab_${name}` as ToolName)!(live)).toBe(true);
  return { result: await h.call(name, live), preview };
}
const newRow = (extra: JsonObject = {}): JsonObject => ({ account_id: account, amount: -1000, date: '2026-10-01', ...extra });
const cases: [string, JsonObject, ApiRequest][] = [
  ['create_transactions', { transactions: [newRow()] }, { method: 'POST', path: `${base}/transactions`, body: { transactions: [newRow({ approved: false, cleared: 'uncleared' })] } }],
  ['update_transaction', { transaction_id: 'tx-1', changes: { memo: null } }, { method: 'PUT', path: `${base}/transactions/tx-1`, body: { transaction: { memo: null } } }],
  ['update_transactions', { transactions: [{ id: 'tx-1', changes: { amount: 123 } }] }, { method: 'PATCH', path: `${base}/transactions`, body: { transactions: [{ id: 'tx-1', amount: 123 }] } }],
  ['set_transaction_approval', { transactions: [{ id: 'tx-1' }], approved: true }, { method: 'PATCH', path: `${base}/transactions`, body: { transactions: [{ id: 'tx-1', approved: true }] } }],
  ['categorize_transactions', { transactions: [{ id: 'tx-1' }], category_id: null }, { method: 'PATCH', path: `${base}/transactions`, body: { transactions: [{ id: 'tx-1', category_id: null }] } }],
  ['delete_transaction', { transaction_id: 'tx-1', confirm_delete: true }, { method: 'DELETE', path: `${base}/transactions/tx-1` }],
  ['import_transactions', {}, { method: 'POST', path: `${base}/transactions/import` }],
];
describe('independent: real safety and fake-fetch HTTP', () => {
  it.each(cases)('%s: schema-valid success, exact preview/route, permission denial', async (name, args, expected) => {
    const h = harness({ http: true }); const { result, preview } = await execute(h, name, args);
    expect(result.status).toBe('ok'); expect(h.mutations()).toEqual([expected]);
    expect(preview.preview).toMatchObject({ method: expected.method, path: expected.path, body: expected.body ?? null });
    const denied = harness({ http: true, config: { readOnly: true } });
    expect(await denied.call(name, { ...args, dry_run: false })).toMatchObject({ status: 'error', error: { code: 'permission_denied' } }); expect(denied.requests).toEqual([]);
    if (name === 'set_transaction_approval') expect(h.rows.get('tx-1')).toEqual(row('tx-1', { approved: true }));
    if (name === 'categorize_transactions') expect(h.rows.get('tx-1')).toEqual(row('tx-1', { category_id: null }));
    if (name === 'update_transaction') expect(h.rows.get('tx-1')).toEqual(row('tx-1', { memo: null }));
  });
  it('approval bypasses unrelated category/account validation without modifying split metadata', async () => {
    const split = row('tx-1', { category_id: null, subtransactions: [{ id: 'c1', transaction_id: 'tx-1', amount: -1000, deleted: false }] });
    const h = harness({ rows: [split], accounts: [], categories: [] });
    expect((await execute(h, 'set_transaction_approval', { transactions: [{ id: 'tx-1' }], approved: true })).result.status).toBe('ok');
    expect(h.rows.get('tx-1')).toEqual({ ...split, approved: true });
    expect(h.requests.every(r => !/\/(accounts|categories|payees)$/.test(r.path))).toBe(true);
  });
  it.each(['memo', 'amount', 'date', 'category_id', 'approved', 'cleared', 'flag_color'])('ignored %s never verifies', async field => {
    const values: JsonObject = { memo: null, amount: 13, date: '2026-09-01', category_id: null, approved: true, cleared: 'cleared', flag_color: 'red' };
    const h = harness({ ignore: true });
    expect((await execute(h, 'update_transaction', { transaction_id: 'tx-1', changes: { [field]: values[field]! } })).result).toMatchObject({ status: 'error', error: { code: 'verification_failed', outcome: 'applied' } }); expect(h.mutations()).toHaveLength(1);
  });
  it('tracking boundary allows category only on the onbudget side and submits just one leg', async () => {
    const accounts = [acct(), acct(destination, { on_budget: false, transfer_payee_id: transferPayee })];
    const good = harness({ accounts });
    expect((await execute(good, 'create_transactions', { transactions: [newRow({ payee_id: transferPayee, category_id: category })] })).result.status).toBe('ok'); expect(good.mutations()).toHaveLength(1);
    const bad = harness({ accounts });
    expect((await bad.call('create_transactions', { transactions: [newRow({ account_id: destination, category_id: category })], dry_run: false })).status).toBe('error'); expect(bad.mutations()).toEqual([]);
  });
  it('mixed-sign split verifies children and rejects forbidden child category before writes', async () => {
    const children: JsonObject[] = [{ amount: -1400, category_id: category }, { amount: 400 }];
    const saved = row('new', { category_id: null, subtransactions: children.map((c, i) => ({ ...c, id: `s${i}`, transaction_id: 'new', deleted: false })) });
    const h = harness({ reply: { transactions: [saved], transaction_ids: ['new'], server_knowledge: 2 } });
    expect((await execute(h, 'create_transactions', { transactions: [newRow({ category_id: null, subtransactions: children })] })).result.status).toBe('ok');
    const bad = harness({ groupName: 'Credit Card Payments' });
    expect((await bad.call('create_transactions', { transactions: [newRow({ category_id: null, subtransactions: children })], dry_run: false })).status).toBe('error'); expect(bad.mutations()).toEqual([]);
  });
  it('same import ID across accounts plus duplicate acknowledgment is ambiguous', async () => {
    const h = harness({ reply: { transaction_ids: ['new'], transactions: [row('new', { import_id: 'same' })], duplicate_import_ids: ['same'], server_knowledge: 2 } });
    expect((await execute(h, 'create_transactions', { transactions: [newRow({ import_id: 'same' }), newRow({ account_id: destination, import_id: 'same' })] })).result).toMatchObject({ status: 'error', error: { code: 'verification_failed', outcome: 'applied' } }); expect(h.mutations()).toHaveLength(1);
  });
  it('delete transfer observes former counterpart without independently deleting it', async () => {
    const h = harness({ rows: [row('tx-1', { transfer_transaction_id: 'tx-2', transfer_account_id: destination }), row('tx-2', { account_id: destination })] });
    const { result, preview } = await execute(h, 'delete_transaction', { transaction_id: 'tx-1', confirm_delete: true });
    expect(result.status).toBe('ok'); expect(preview.preview.affected_ids).toEqual(expect.arrayContaining(['tx-1', 'tx-2']));
    const index = h.requests.findIndex(r => r.method === 'DELETE');
    expect(h.requests.slice(index + 1)).toContainEqual({ method: 'GET', path: `${base}/transactions/tx-2` }); expect(h.mutations()).toHaveLength(1);
  });
  it('contradictory delete with still-existing target fails', async () => {
    const h = harness({ reply: { transaction: row(), server_knowledge: 2 } });
    expect((await execute(h, 'delete_transaction', { transaction_id: 'tx-1', confirm_delete: true })).result).toMatchObject({ status: 'error', error: { code: 'verification_failed', outcome: 'applied' } }); expect(h.mutations()).toHaveLength(1);
  });
});
describe('shared HTTP boundary blocker', () => {
  it('catalog-valid opaque ID must survive actual HTTP preflight', async () => {
    const h = harness({ http: true, rows: [row('bank:fixture')] });
    const args = { transaction_id: 'bank:fixture', changes: { memo: 'safe' } };
    expect(inputValidators.get('ynab_update_transaction')!(args)).toBe(true);
    expect(await h.call('update_transaction', args)).toMatchObject({ status: 'preview' });
  });
  it('planPath must encode a catalog-valid opaque ID as one safe segment', () => {
    expect(planPath(plan, 'transactions', 'bank:fixture')).toBe(`${base}/transactions/bank%3Afixture`);
  });
});

it('existing split rejects changes to amount/date/category/children before mutation', async () => {
  for (const changes of [{ amount: -1200 }, { date: '2026-09-01' }, { category_id: category }, { subtransactions: [{ amount: -500 }, { amount: -500 }] }] as JsonObject[]) {
    const h = harness({ rows: [row('tx-1', { category_id: null, subtransactions: [{ id: 's1', transaction_id: 'tx-1', amount: -1000, deleted: false }] })] });
    expect((await h.call('update_transaction', { transaction_id: 'tx-1', changes })).status).toBe('error'); expect(h.mutations()).toEqual([]);
  }
});
it('import, deletion and reconciled policies block previews and writes', async () => {
  for (const dry_run of [true, false]) {
    const imports = harness({ config: { allowImports: false } });
    expect((await imports.call('import_transactions', { dry_run })).status).toBe('error'); expect(imports.mutations()).toEqual([]);
    const deletion = harness({ config: { allowDeletes: false } });
    expect((await deletion.call('delete_transaction', { transaction_id: 'tx-1', confirm_delete: true, dry_run })).status).toBe('error'); expect(deletion.mutations()).toEqual([]);
    const reconciled = harness({ rows: [row('tx-1', { cleared: 'reconciled' })] });
    expect((await reconciled.call('set_transaction_approval', { transactions: [{ id: 'tx-1' }], approved: true, dry_run })).status).toBe('error'); expect(reconciled.mutations()).toEqual([]);
  }
});
