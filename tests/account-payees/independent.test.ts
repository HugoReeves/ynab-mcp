import { describe, expect, it } from 'vitest';
import { catalog, inputValidators, outputValidators } from '../../src/catalog.js';
import type { ApiRequest, Config, JsonObject, ToolName } from '../../src/contracts.js';
import { createSafetyState } from '../../src/safety/index.js';
import { createDispatcher } from '../../src/runtime/dispatcher.js';
import { createAccountPayeeTools } from '../../src/tools/account-payees.js';

const plan = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const root = `/plans/${plan}`;
const stamp = '2026-10-07T00:00:00.000Z';
const payee = { id, name: 'Independent', deleted: false, transfer_account_id: null };
const account = { id, name: 'Independent', type: 'checking', balance: -12340, cleared_balance: -12340, uncleared_balance: 0, on_budget: true, closed: false, deleted: false, transfer_payee_id: null };
const owned: ToolName[] = ['ynab_create_account', 'ynab_create_payee', 'ynab_update_payee'];
// Independent literal fixtures, real policy/revisions/locking/verification; never a live API.
function harness(saved: JsonObject, detail: JsonObject = { payee }, old: JsonObject = { ...payee, name: 'Before' }) {
  const requests: ApiRequest[] = [];
  const config: Config = { defaultPlanId: plan, allowedPlanIds: [plan], readOnly: false, allowDeletes: false, allowImports: false, allowReconciledChanges: false, toolProfile: 'extended', timeoutMs: 60000, cacheTtlSeconds: 30, logLevel: 'error' };
  const clock = { now: () => Date.parse(stamp) };
  let current = old;
  const api = { async request(_ctx: unknown, request: ApiRequest) {
    requests.push(structuredClone(request));
    const data = request.method !== 'GET' ? saved : requests.some(r => r.method !== 'GET') ? detail : { payee: current };
    return { data: structuredClone(data), fetchedAt: stamp };
  } };
  const state = createSafetyState(config, api, clock);
  const services = { config, clock, api, state };
  const handlers = createAccountPayeeTools(services);
  const dispatcher = createDispatcher(services, handlers);
  async function call(name: ToolName, args: JsonObject) {
    const result = (await dispatcher.callTool(name, args)).structuredContent;
    expect(outputValidators.get(name)!(result), JSON.stringify(result)).toBe(true);
    return result;
  }
  async function execute(name: ToolName, args: JsonObject) {
    const preview = await call(name, args);
    expect(preview.status).toBe('preview');
    if (preview.status !== 'preview') throw Error('Expected preview');
    return call(name, { ...args, dry_run: false, ...(name === 'ynab_update_payee' ? { expected_revision: preview.preview.expected_revisions[`payee:${id}`]! } : {}) });
  }
  return { call, execute, handlers, requests, change: (entity: JsonObject) => { current = entity; } };
}
const accountArgs = { account: { name: account.name, type: account.type, balance: account.balance } };
const rows: [ToolName, JsonObject, JsonObject, ApiRequest][] = [
  ['ynab_create_account', accountArgs, { account }, { method: 'POST', path: `${root}/accounts`, body: accountArgs }],
  ['ynab_create_payee', { name: payee.name }, { payee, server_knowledge: 71 }, { method: 'POST', path: `${root}/payees`, body: { payee: { name: payee.name } } }],
  ['ynab_update_payee', { payee_id: id, name: payee.name }, { payee, server_knowledge: 71 }, { method: 'PATCH', path: `${root}/payees/${id}`, body: { payee: { name: payee.name } } }],
];

describe('independent bounded account/payee contracts', () => {
  it('owns exactly three catalog tools, without stubs or unrelated handlers', () => {
    expect(Object.keys(harness({}).handlers).sort()).toEqual([...owned].sort());
    expect(rows.map(([name]) => name).sort()).toEqual([...owned].sort());
    expect(catalog.filter(t => owned.includes(t.name))).toHaveLength(3);
  });
  it.each(rows)('%s positive preview, exact execution and frozen output shape', async (name, args, saved, request) => {
    const h = harness(saved);
    expect(inputValidators.get(name)!(args)).toBe(true);
    const preview = await h.call(name, args);
    expect(preview).toMatchObject({ status: 'preview', preview: { ...request, validated: true, unknown_effects: false } });
    expect(h.requests.every(r => r.method === 'GET')).toBe(true);
    const result = await h.execute(name, args);
    expect(result).toMatchObject({ status: 'ok', data: saved, meta: { fetched_at: stamp, cache_hit: false } });
    if (result.status !== 'ok') throw Error('Expected ok');
    expect(result.data).toEqual(saved);
    if (name !== 'ynab_create_account') expect(result.meta.revisions?.[`payee:${id}`]).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(h.requests.filter(r => r.method !== 'GET')).toEqual([request]);
  });
  // SaveAccountType is deliberately narrower than the read-side AccountType.
  for (const type of ['checking', 'savings', 'cash', 'creditCard', 'otherAsset', 'otherLiability']) {
    it.each([-12340, 0, 12340])(`${type} preserves signed milliunit opening balance %s`, async balance => {
      const saved = { ...account, type, balance, cleared_balance: balance };
      const h = harness({ account: saved });
      const args = { account: { name: account.name, type, balance } };
      expect(await h.execute('ynab_create_account', args)).toMatchObject({ status: 'ok', data: { account: saved } });
      expect(h.requests).toEqual([{ method: 'POST', path: `${root}/accounts`, body: args }]);
    });
  }
  it.each(['lineOfCredit', 'mortgage', 'autoLoan', 'studentLoan', 'personalLoan', 'medicalDebt', 'otherDebt'])('rejects read-only account type %s before requests', async type => {
    const h = harness({});
    expect(await h.call('ynab_create_account', { account: { ...accountArgs.account, type }, dry_run: false })).toMatchObject({ status: 'error', error: { code: 'validation_error', outcome: 'not_applied' } });
    expect(h.requests).toEqual([]);
  });
  it.each([null, '1000', 0.001, 9007199254740992, -9007199254740992])('rejects invalid opening balance %s', async balance => {
    const h = harness({});
    expect(await h.call('ynab_create_account', { account: { ...accountArgs.account, balance } })).toMatchObject({ status: 'error', error: { code: 'validation_error' } });
    expect(h.requests).toEqual([]);
  });
  it.each<JsonObject>([{ name: 'Ignored' }, { type: 'cash' }, { balance: 12340 }, { balance: 0 }, { deleted: true }])('rejects acknowledged account mismatch %j without retry', async patch => {
    const h = harness({ account: { ...account, ...patch } });
    expect(await h.execute('ynab_create_account', accountArgs)).toMatchObject({ status: 'error', error: { code: 'verification_failed', outcome: 'applied', retryable: false } });
    expect(h.requests.filter(r => r.method !== 'GET')).toHaveLength(1);
  });
  it.each(rows)('%s verifies partial acknowledgments with a fresh detail GET', async (name, args, saved, request) => {
    const field = name === 'ynab_create_account' ? 'account' : 'payee';
    const h = harness({ [field]: { id }, ...(field === 'payee' ? { server_knowledge: 71 } : {}) }, saved);
    expect(await h.execute(name, args)).toMatchObject({ status: 'ok', data: saved });
    expect(h.requests.at(-1)).toEqual({ method: 'GET', path: `${root}/${field}s/${id}` });
    expect(h.requests.filter(r => r.method !== 'GET')).toEqual([request]);
  });
  it.each(rows)('%s rejects ignored name in fallback detail, without retry', async (name, args, saved) => {
    const field = name === 'ynab_create_account' ? 'account' : 'payee';
    const h = harness({ [field]: { id }, ...(field === 'payee' ? { server_knowledge: 71 } : {}) }, { ...saved, [field]: { ...(saved[field] as JsonObject), name: 'Before' } });
    expect(await h.execute(name, args)).toMatchObject({ status: 'error', error: { code: 'verification_failed', outcome: 'applied' } });
    expect(h.requests.filter(r => r.method !== 'GET')).toHaveLength(1);
  });
  it.each([plan, ''])('protects transfer payees with non-null transfer_account_id %j', async transfer_account_id => {
    const h = harness({}, undefined, { ...payee, transfer_account_id });
    expect(await h.call('ynab_update_payee', { payee_id: id, name: 'Rename' })).toMatchObject({ status: 'error', error: { code: 'unsupported_operation', outcome: 'not_applied' } });
    expect(h.requests).toEqual([{ method: 'GET', path: `${root}/payees/${id}` }]);
  });
  it('a payee converted to transfer after preview cannot be renamed with its stale revision', async () => {
    const h = harness({ payee, server_knowledge: 71 });
    const args = { payee_id: id, name: payee.name };
    const p = await h.call('ynab_update_payee', args);
    if (p.status !== 'preview') throw Error('Expected preview');
    h.change({ ...payee, name: 'Before', transfer_account_id: plan });
    expect(await h.call('ynab_update_payee', { ...args, dry_run: false, expected_revision: p.preview.expected_revisions[`payee:${id}`]! })).toMatchObject({ status: 'error', error: { code: 'conflict', outcome: 'not_applied' } });
    expect(h.requests.every(r => r.method === 'GET')).toBe(true);
  });
  it.each(rows)('%s rejects undocumented writable fields rather than silently discarding them', async (name, args) => {
    const h = harness({});
    const extra = name === 'ynab_create_account' ? { ...args, account: { ...(args.account as JsonObject), closed: true } } : { ...args, transfer_account_id: plan };
    expect(await h.call(name, extra)).toMatchObject({ status: 'error', error: { code: 'validation_error' } });
    expect(h.requests).toEqual([]);
  });
  it.each(['ynab_create_payee', 'ynab_update_payee'] as const)('%s requires pinned SavePayeeResponse knowledge, not detail-response knowledge', async name => {
    const h = harness({ payee: { id } }, { payee, server_knowledge: 71 });
    expect(await h.execute(name, { name: payee.name, ...(name === 'ynab_update_payee' ? { payee_id: id } : {}) })).toMatchObject({ status: 'error', error: { code: 'verification_failed', outcome: 'applied' } });
  });
});
