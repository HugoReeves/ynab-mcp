import { describe, expect, it } from 'vitest';
import { createTransactionTools } from '../../src/tools/transactions.js';
import { createSafetyState } from '../../src/safety/index.js';
import { createDispatcher } from '../../src/runtime/dispatcher.js';
import { outputValidators } from '../../src/catalog.js';
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
  failure?: 'unknown' | 'conflict'; missingRead?: string; readTime?: string } = {}) {
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
  const state = createSafetyState(config, api, clock);
  const services = { config, api, state, clock };
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
const routes: [string, JsonObject, ApiRequest][] = [
  ['create_transactions', { transactions: [{ account_id: account, date: '2026-10-01', amount: -1000 }] }, { method: 'POST', path: `${base}/transactions`, body: { transactions: [{ account_id: account, date: '2026-10-01', amount: -1000, approved: false, cleared: 'uncleared' }] } }],
  ['update_transaction', { transaction_id: 'tx-1', changes: { memo: null } }, { method: 'PUT', path: `${base}/transactions/tx-1`, body: { transaction: { memo: null } } }],
  ['update_transactions', { transactions: [{ id: 'tx-1', changes: { memo: 'new' } }] }, { method: 'PATCH', path: `${base}/transactions`, body: { transactions: [{ id: 'tx-1', memo: 'new' }] } }],
  ['set_transaction_approval', { transactions: [{ id: 'tx-1' }], approved: true }, { method: 'PATCH', path: `${base}/transactions`, body: { transactions: [{ id: 'tx-1', approved: true }] } }],
  ['categorize_transactions', { transactions: [{ id: 'tx-1' }], category_id: null }, { method: 'PATCH', path: `${base}/transactions`, body: { transactions: [{ id: 'tx-1', category_id: null }] } }],
  ['delete_transaction', { transaction_id: 'tx-1', confirm_delete: true }, { method: 'DELETE', path: `${base}/transactions/tx-1` }],
  ['import_transactions', {}, { method: 'POST', path: `${base}/transactions/import` }],
];
describe('seven catalog routes through real dispatcher and safety', () => {
  for (const [name, args, expected] of routes) {
    it(`${name}: preview, exact execution, schema, denied fixture`, async () => {
      const h = harness(); const preview = await h.call(name, args);
      expect(preview.status).toBe('preview'); expect(h.mutations()).toEqual([]);
      if (preview.status !== 'preview') return;
      expect({ method: preview.preview.method, path: preview.preview.path, ...(preview.preview.body === null ? {} : { body: preview.preview.body }) }).toEqual(expected);
      const live = structuredClone(args); live.dry_run = false;
      if (typeof live.transaction_id === 'string') live.expected_revision = preview.preview.expected_revisions[`transaction:${live.transaction_id}`]!;
      else if (name !== 'create_transactions' && Array.isArray(live.transactions)) for (const item of live.transactions as JsonObject[]) item.expected_revision = preview.preview.expected_revisions[`transaction:${item.id}`]!;
      expect((await h.call(name, live)).status).toBe('ok'); expect(h.mutations()).toEqual([expected]);
      if (name === 'set_transaction_approval') expect(h.rows.get('tx-1')).toEqual(row('tx-1', { approved: true }));
      if (name === 'categorize_transactions') expect(h.rows.get('tx-1')).toEqual(row('tx-1', { category_id: null }));
      const denied = harness({ config: { readOnly: true } });
      expect(await denied.call(name, live)).toMatchObject({ status: 'error', error: { code: 'permission_denied', outcome: 'not_applied' } }); expect(denied.requests).toEqual([]);
    });
  }
});
describe('transaction semantic preflight', () => {
  const create = (extra: JsonObject) => ({ transactions: [{ account_id: account, date: '2026-10-01', amount: -1000, ...extra }] });
  it.each([
    ['payee ambiguity', { payee_id: payee, payee_name: 'Name' }, {}],
    ['future date', { date: '2026-10-08' }, {}],
    ['unknown account', { account_id: destination }, { accounts: [acct()] }],
    ['deleted category', { category_id: category }, { categories: [cat({ deleted: true })] }],
    ['payment category', { category_id: category }, { groupName: 'Credit Card Payments' }],
    ['same account transfer', { payee_id: transferPayee }, { accounts: [acct(account, { transfer_payee_id: transferPayee })] }],
    ['onbudget transfer category', { payee_id: transferPayee, category_id: category }, {}],
    ['split missing explicit null', { subtransactions: [{ amount: -400 }, { amount: -600 }] }, {}],
    ['split wrong sum', { category_id: null, subtransactions: [{ amount: -400 }, { amount: -700 }] }, {}],
    ['tracking split', { category_id: null, subtransactions: [{ amount: -400 }, { amount: -600 }] }, { accounts: [acct(account, { on_budget: false })] }],
    ['onbudget transfer split', { payee_id: transferPayee, category_id: null, subtransactions: [{ amount: -400 }, { amount: -600 }] }, {}],
  ] as [string, JsonObject, Parameters<typeof harness>[0]][])('%s rejects before mutation', async (_label, extra, options) => {
    const h = harness(options); expect((await h.call('create_transactions', { ...create(extra), dry_run: false })).status).toBe('error'); expect(h.mutations()).toEqual([]);
  });
  it('all batch semantics validated before submission', async () => {
    const h = harness(); const r = await h.call('create_transactions', { transactions: [create({}).transactions[0]!, create({ payee_id: payee, payee_name: 'ambiguous' }).transactions[0]!], dry_run: false });
    expect(r.status).toBe('error'); expect(h.mutations()).toEqual([]);
  });
  it('duplicate update IDs rejected', async () => {
    const h = harness(); expect((await h.call('set_transaction_approval', { transactions: [{ id: 'tx-1' }, { id: 'tx-1' }], approved: true })).status).toBe('error'); expect(h.mutations()).toEqual([]);
  });
  it('live updates require revisions; stale revisions reject', async () => {
    const h = harness();
    expect(await h.call('update_transaction', { transaction_id: 'tx-1', changes: { memo: 'x' }, dry_run: false })).toMatchObject({ status: 'error', error: { code: 'validation_error' } });
    expect(await h.call('update_transaction', { transaction_id: 'tx-1', changes: { memo: 'x' }, dry_run: false, expected_revision: `sha256:${'0'.repeat(64)}` })).toMatchObject({ status: 'error', error: { code: 'conflict' } });
    expect(h.mutations()).toEqual([]);
  });
  it.each<JsonObject>([{ payee_name: 'New' }, { payee_name: null }, { payee_id: null }, { payee_id: payee, payee_name: null }])('payee null/omitted coupling %j', async changes => {
    const h = harness(); const r = await h.call('update_transaction', { transaction_id: 'tx-1', changes });
    expect(r.status).toBe('preview'); if (r.status !== 'preview') return;
    const expected = changes.payee_id ? { payee_id: payee } : changes.payee_name ? { payee_name: 'New', payee_id: null } : { payee_id: null, payee_name: null };
    expect(r.preview.body).toEqual({ transaction: expected });
  });
  it('hidden category warns; Ready to Assign inflow permitted', async () => {
    const h = harness({ categories: [cat({ hidden: true, internal: true, name: 'Inflow: Ready to Assign' })], groupName: 'Internal Master Category' });
    const r = await h.call('create_transactions', create({ amount: 1000, category_id: category }));
    expect(r.status).toBe('preview'); if (r.status === 'preview') expect(r.preview.warnings.join(' ')).toMatch(/hidden/i);
  });
  it('mixed sign split exact sum and overflow reject', async () => {
    const h = harness(); expect((await h.call('create_transactions', create({ category_id: null, subtransactions: [{ amount: -2000 }, { amount: 1000 }] }))).status).toBe('preview');
    expect((await h.call('create_transactions', create({ amount: 1, category_id: null, subtransactions: [{ amount: Number.MAX_SAFE_INTEGER }, { amount: 1 }, { amount: -Number.MAX_SAFE_INTEGER }] }))).status).toBe('error');
  });
  it.each(['amount', 'date', 'category_id', 'subtransactions'])('existing split rejects %s changes', async field => {
    const h = harness({ rows: [row('tx-1', { category_id: null, subtransactions: [{ id: 'child-1', transaction_id: 'tx-1', amount: -400, deleted: false }, { id: 'child-2', transaction_id: 'tx-1', amount: -600, deleted: false }] })] });
    const values: JsonObject = { amount: -2000, date: '2026-09-01', category_id: category, subtransactions: [{ amount: -400 }, { amount: -600 }] };
    expect((await h.call('update_transaction', { transaction_id: 'tx-1', changes: { [field]: values[field]! } })).status).toBe('error'); expect(h.mutations()).toEqual([]);
  });
  it('existing split metadata allowed; categorization rejected even null', async () => {
    const h = harness({ rows: [row('tx-1', { category_id: null, subtransactions: [{ id: 'c', transaction_id: 'tx-1', amount: -1000, deleted: false }] })] });
    expect((await h.call('update_transaction', { transaction_id: 'tx-1', changes: { memo: 'metadata' } })).status).toBe('preview');
    expect((await h.call('categorize_transactions', { transactions: [{ id: 'tx-1' }], category_id: null })).status).toBe('error');
  });
});
describe('acknowledgment and recovery', () => {
  it('ignored submitted field becomes verification_failed/applied', async () => {
    const h = harness({ ignore: true }); const expected_revision = await h.revision();
    expect(await h.call('update_transaction', { transaction_id: 'tx-1', changes: { memo: 'new' }, dry_run: false, expected_revision })).toMatchObject({ status: 'error', error: { code: 'verification_failed', outcome: 'applied' } }); expect(h.mutations()).toHaveLength(1);
  });
  it.each(['unknown', 'conflict'] as const)('%s mutation never retried', async failure => {
    const h = harness({ failure }); const expected_revision = await h.revision();
    expect(await h.call('update_transaction', { transaction_id: 'tx-1', changes: { memo: 'new' }, dry_run: false, expected_revision })).toMatchObject({ status: 'error', error: { code: failure === 'unknown' ? 'outcome_unknown' : 'conflict', outcome: failure === 'unknown' ? 'unknown' : 'not_applied' } }); expect(h.mutations()).toHaveLength(1);
  });
  it('bulk updates map shuffled entities by IDs', async () => {
    const h = harness(); const a = await h.revision(); const b = await h.revision('tx-2');
    expect((await h.call('update_transactions', { dry_run: false, transactions: [{ id: 'tx-1', expected_revision: a, changes: { memo: 'one' } }, { id: 'tx-2', expected_revision: b, changes: { memo: 'two' } }] })).status).toBe('ok');
  });
  it('partial ID acknowledgment cannot claim all targets updated', async () => {
    const h = harness({ reply: { transaction_ids: ['tx-2'], transactions: [row('tx-2', { approved: true })], server_knowledge: 2 } }); const a = await h.revision(); const b = await h.revision('tx-2');
    expect(await h.call('set_transaction_approval', { dry_run: false, approved: true, transactions: [{ id: 'tx-1', expected_revision: a }, { id: 'tx-2', expected_revision: b }] })).toMatchObject({ status: 'error', error: { code: 'verification_failed', outcome: 'applied' } });
  });
  it('bank import empty IDs is success; import permission gates preview', async () => {
    const h = harness(); expect(await h.call('import_transactions', { dry_run: false })).toMatchObject({ status: 'ok', data: { transaction_ids: [] } });
    const denied = harness({ config: { allowImports: false } }); expect((await denied.call('import_transactions', {})).status).toBe('error');
    expect((await denied.call('create_transactions', { transactions: [{ account_id: account, date: '2026-10-01', amount: 10, import_id: 'fixture-import' }] })).status).toBe('error'); expect(denied.mutations()).toEqual([]);
  });
  it('duplicate import IDs preserved, zero saved is not newly created', async () => {
    const h = harness({ reply: { transaction_ids: [], duplicate_import_ids: ['fixture-import'], server_knowledge: 2 } });
    expect(await h.call('create_transactions', { dry_run: false, transactions: [{ account_id: account, date: '2026-10-01', amount: 10, import_id: 'fixture-import' }] })).toMatchObject({ status: 'ok', data: { transaction_ids: [], duplicate_import_ids: ['fixture-import'] } });
  });
  it('reconciled counterpart prevents editing transfer', async () => {
    const h = harness({ rows: [row('tx-1', { transfer_account_id: destination, transfer_transaction_id: 'tx-2' }), row('tx-2', { account_id: destination, cleared: 'reconciled', transfer_transaction_id: 'tx-1' })] });
    expect(await h.call('update_transaction', { transaction_id: 'tx-1', changes: { memo: 'new' } })).toMatchObject({ status: 'error', error: { code: 'permission_denied' } }); expect(h.mutations()).toEqual([]);
  });
});

describe('conservative verification fixtures', () => {
  it('IDs-only save performs a fresh detail read and rejects ignored intent', async () => {
    const h = harness({ reply: { transaction_ids: ['tx-1'], server_knowledge: 2 } });
    const expected_revision = await h.revision(); h.requests.length = 0;
    expect(await h.call('set_transaction_approval', { transactions: [{ id: 'tx-1', expected_revision }], approved: true, dry_run: false })).toMatchObject({ status: 'error', error: { code: 'verification_failed', details: { unverified_ids: ['tx-1'] } } });
    expect(h.requests.filter(r => r.path === `${base}/transactions/tx-1` && r.method === 'GET')).toHaveLength(3);
  });
  it('IDs-only matching save is verified through fresh reads', async () => {
    const h = harness({ rows: [row('tx-1', { approved: true })], reply: { transaction_ids: ['tx-1'], server_knowledge: 2 } });
    const expected_revision = await h.revision();
    expect(await h.call('set_transaction_approval', { transactions: [{ id: 'tx-1', expected_revision }], approved: true, dry_run: false })).toMatchObject({ status: 'ok', data: { transactions: [row('tx-1', { approved: true })] } });
  });
  it('create comparison uses a complete multiset, not position', async () => {
    const a = row('new-a', { amount: -1000 }); const b = row('new-b', { amount: 2000 });
    const h = harness({ reply: { transaction_ids: ['new-a', 'new-b'], transactions: [b, a], server_knowledge: 2 } });
    expect((await h.call('create_transactions', { dry_run: false, transactions: [
      { account_id: account, date: '2026-10-01', amount: -1000 }, { account_id: account, date: '2026-10-01', amount: 2000 },
    ] })).status).toBe('ok');
  });
  it('create missing/extra entities and changed amounts fail conservatively', async () => {
    for (const data of [
      { transaction_ids: [], server_knowledge: 2 },
      { transaction_ids: ['new-a'], transactions: [row('new-a', { amount: -999 })], server_knowledge: 2 },
      { transaction_ids: ['new-a'], transactions: [row('other')], server_knowledge: 2 },
    ] as JsonObject[]) {
      const h = harness({ reply: data });
      expect(await h.call('create_transactions', { dry_run: false, transactions: [{ account_id: account, date: '2026-10-01', amount: -1000 }] })).toMatchObject({ status: 'error', error: { code: 'verification_failed', outcome: 'applied' } });
    }
  });
  it('mixed-sign split execution verifies children as multiset', async () => {
    const split = row('new-a', { category_id: null, subtransactions: [
      { id: 's1', transaction_id: 'new-a', amount: 1000, deleted: false },
      { id: 's2', transaction_id: 'new-a', amount: -2000, deleted: false },
    ] });
    const h = harness({ reply: { transaction_ids: ['new-a'], transactions: [split], server_knowledge: 2 } });
    expect((await h.call('create_transactions', { dry_run: false, transactions: [{ account_id: account, date: '2026-10-01', amount: -1000, category_id: null, subtransactions: [{ amount: -2000 }, { amount: 1000 }] }] })).status).toBe('ok');
  });
  it('payee name resolves identity without requiring original name', async () => {
    const h = harness({ reply: { transaction: row('tx-1', { payee_id: payee, payee_name: 'Renamed' }), server_knowledge: 2 } });
    const expected_revision = await h.revision();
    expect((await h.call('update_transaction', { transaction_id: 'tx-1', changes: { payee_name: 'Requested' }, expected_revision, dry_run: false })).status).toBe('ok');
    expect(h.mutations()[0]?.body).toEqual({ transaction: { payee_name: 'Requested', payee_id: null } });
  });
  it('bank import preserves acknowledged IDs including duplicates and warns about opaque scope', async () => {
    const h = harness({ reply: { transaction_ids: ['opaque-a', 'opaque-a'] } });
    const preview = await h.call('import_transactions', {});
    expect(preview).toMatchObject({ status: 'preview', preview: { unknown_effects: true, body: null } });
    if (preview.status === 'preview') expect(preview.preview.warnings.join(' ')).toMatch(/all linked accounts.*matching/is);
    expect(await h.call('import_transactions', { dry_run: false })).toMatchObject({ status: 'ok', data: { transaction_ids: ['opaque-a', 'opaque-a'] } });
  });
  it('import acknowledgment without IDs is verification_failed, not invented success', async () => {
    const h = harness({ reply: {} }); expect(await h.call('import_transactions', { dry_run: false })).toMatchObject({ status: 'error', error: { code: 'verification_failed', outcome: 'applied' } });
  });
  it('reconciled create status gated even in previews', async () => {
    const h = harness(); expect(await h.call('create_transactions', { transactions: [{ account_id: account, date: '2026-10-01', amount: 1, cleared: 'reconciled' }] })).toMatchObject({ status: 'error', error: { code: 'permission_denied' } }); expect(h.mutations()).toEqual([]);
  });
  it('delete requires policy and confirmation; no extra semantic context', async () => {
    const h = harness(); expect((await h.call('delete_transaction', { transaction_id: 'tx-1' })).status).toBe('error'); expect(h.requests).toEqual([]);
    expect((await harness({ config: { allowDeletes: false } }).call('delete_transaction', { transaction_id: 'tx-1', confirm_delete: true })).status).toBe('error');
  });
  it('contradictory deletion acknowledgment re-reads, never claims deletion of existing entity', async () => {
    const h = harness({ reply: { transaction: row(), server_knowledge: 2 } }); const expected_revision = await h.revision();
    expect(await h.call('delete_transaction', { transaction_id: 'tx-1', confirm_delete: true, dry_run: false, expected_revision })).toMatchObject({ status: 'error', error: { code: 'verification_failed' } }); expect(h.mutations()).toHaveLength(1);
  });
  it('tracking boundary transfer is allowed and sends only one leg', async () => {
    const target = acct(destination, { on_budget: false, transfer_payee_id: transferPayee });
    const h = harness({ accounts: [acct(), target] });
    expect((await h.call('create_transactions', { transactions: [{ account_id: account, date: '2026-10-01', amount: -1000, payee_id: transferPayee, category_id: category }] })).status).toBe('preview');
    expect(h.mutations()).toEqual([]);
  });
  it('edited transfer re-inspects graph and reports observed counterpart state', async () => {
    const h = harness({ rows: [row('tx-1', { payee_id: transferPayee, category_id: null, transfer_account_id: destination, transfer_transaction_id: 'tx-2' }), row('tx-2', { account_id: destination, category_id: null, transfer_account_id: account, transfer_transaction_id: 'tx-1' })] });
    const expected_revision = await h.revision(); h.requests.length = 0;
    const result = await h.call('update_transaction', { transaction_id: 'tx-1', changes: { memo: 'new' }, expected_revision, dry_run: false });
    expect(result.status).toBe('ok');
    expect(h.mutations()).toHaveLength(1);
    const mutationIndex = h.requests.findIndex(r => r.method === 'PUT');
    expect(h.requests.slice(mutationIndex + 1)).toContainEqual({ method: 'GET', path: `${base}/transactions/tx-2` });
    expect(result.meta.warnings.join(' ')).toMatch(/observed.*tx-2/i);
  });
  it('acknowledged transfer graph gaps are disclosed without retry', async () => {
    const created = row('new-a', { payee_id: transferPayee, category_id: null, transfer_account_id: destination, transfer_transaction_id: 'missing-counterpart' });
    const h = harness({ rows: [created], reply: { transaction_ids: ['new-a'], transactions: [created], server_knowledge: 2 } });
    const r = await h.call('create_transactions', { dry_run: false, transactions: [{ account_id: account, date: '2026-10-01', amount: -1000, payee_id: transferPayee, category_id: null }] });
    expect(r.status).toBe('ok'); expect(r.meta.warnings.join(' ')).toMatch(/verification gap/i); expect(h.mutations()).toHaveLength(1);
  });
});

describe('additional transfer and split invariants', () => {
  it.each<JsonObject>([{ account_id: destination }, { payee_id: transferPayee }])('existing split cannot become tracking/onbudget-transfer split %j', async changes => {
    const h = harness({ accounts: [acct(), acct(destination, { on_budget: changes.account_id ? false : true, transfer_payee_id: transferPayee })], rows: [row('tx-1', { category_id: null, subtransactions: [{ id: 'c1', transaction_id: 'tx-1', amount: -400, deleted: false }, { id: 'c2', transaction_id: 'tx-1', amount: -600, deleted: false }] })] });
    expect((await h.call('update_transaction', { transaction_id: 'tx-1', changes })).status).toBe('error'); expect(h.mutations()).toEqual([]);
  });
  it('approval cannot target a deleted transaction', async () => {
    const h = harness({ rows: [row('tx-1', { deleted: true })] });
    expect((await h.call('set_transaction_approval', { transactions: [{ id: 'tx-1' }], approved: true })).status).toBe('error'); expect(h.mutations()).toEqual([]);
  });
  it('same transfer payee cannot point outside plan through a dangling payee', async () => {
    const h = harness({ accounts: [acct()] });
    expect((await h.call('create_transactions', { transactions: [{ account_id: account, date: '2026-10-01', amount: 100, payee_id: transferPayee }] })).status).toBe('error');
  });
  it('split-transfer child onbudget destination rejected but tracking destination permitted', async () => {
    const args: JsonObject = { transactions: [{ account_id: account, date: '2026-10-01', amount: -1000, category_id: null, subtransactions: [{ amount: -400, payee_id: transferPayee }, { amount: -600, category_id: category }] }] };
    expect((await harness().call('create_transactions', args)).status).toBe('error');
    const h = harness({ accounts: [acct(), acct(destination, { on_budget: false, transfer_payee_id: transferPayee })] });
    expect((await h.call('create_transactions', args)).status).toBe('preview');
  });
  it('bulk split-transfer counterpart overlap is rejected by real safety', async () => {
    const h = harness({ rows: [row('tx-1', { category_id: null, subtransactions: [{ id: 'c', transaction_id: 'tx-1', amount: -1000, deleted: false, transfer_transaction_id: 'tx-2' }] }), row('tx-2')] });
    expect(await h.call('set_transaction_approval', { transactions: [{ id: 'tx-1' }, { id: 'tx-2' }], approved: true })).toMatchObject({ status: 'error', error: { code: 'conflict' } }); expect(h.mutations()).toEqual([]);
  });
  it('created transfer whose acknowledgment lacks links discloses graph verification gap', async () => {
    const h = harness(); const r = await h.call('create_transactions', { dry_run: false, transactions: [{ account_id: account, date: '2026-10-01', amount: -1000, payee_id: transferPayee, category_id: null }] });
    expect(r.status).toBe('ok'); expect(r.meta.warnings.join(' ')).toMatch(/verification gap/i); expect(h.mutations()).toHaveLength(1);
  });
});

describe('fresh transfer and batch authority', () => {
  it('fresh transfer read contradicting save acknowledgment fails verification', async () => {
    const original = row('tx-1', { payee_id: transferPayee, category_id: null, transfer_account_id: destination, transfer_transaction_id: 'tx-2' });
    const h = harness({ rows: [original, row('tx-2', { account_id: destination, category_id: null })], reply: { transaction: { ...original, memo: 'new' }, server_knowledge: 2 } });
    const expected_revision = await h.revision();
    expect(await h.call('update_transaction', { transaction_id: 'tx-1', changes: { memo: 'new' }, expected_revision, dry_run: false })).toMatchObject({ status: 'error', error: { code: 'verification_failed', outcome: 'applied' } }); expect(h.mutations()).toHaveLength(1);
  });
  it('every live bulk target must have a revision, none partially submitted', async () => {
    const h = harness(); const a = await h.revision();
    expect(await h.call('set_transaction_approval', { transactions: [{ id: 'tx-1', expected_revision: a }, { id: 'tx-2' }], approved: true, dry_run: false })).toMatchObject({ status: 'error', error: { code: 'validation_error' } }); expect(h.mutations()).toEqual([]);
  });
});

it('ID-only verification metadata uses authoritative detail-read timestamp', async () => {
  const readTime = '2026-10-07T12:00:01.000Z';
  const h = harness({ rows: [row('tx-1', { approved: true })], reply: { transaction_ids: ['tx-1'], server_knowledge: 2 }, readTime });
  const expected_revision = await h.revision();
  const r = await h.call('set_transaction_approval', { transactions: [{ id: 'tx-1', expected_revision }], approved: true, dry_run: false });
  expect(r.status).toBe('ok'); expect(r.meta.fetched_at).toBe(readTime);
});
