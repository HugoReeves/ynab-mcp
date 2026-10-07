import { describe, expect, it } from 'vitest';
import { catalog, outputValidators } from '../../src/catalog.js';
import type { ApiRequest, CallContext, Config, JsonObject, ToolName } from '../../src/contracts.js';
import { createSafetyState } from '../../src/safety/index.js';
import { createDispatcher } from '../../src/runtime/dispatcher.js';
import { createAccountPayeeTools } from '../../src/tools/account-payees.js';

const plan = '11111111-1111-4111-8111-111111111111';
const id = '22222222-2222-4222-8222-222222222222';
const base = `/plans/${plan}`;
const payee = { id, name: 'New', deleted: false, transfer_account_id: null };
const account = { id, name: 'New', type: 'checking', balance: 1234, cleared_balance: 1234, uncleared_balance: 0, on_budget: true, closed: false, deleted: false, transfer_payee_id: null };
const cases: [ToolName, JsonObject, ApiRequest, JsonObject][] = [
  ['ynab_create_account', { account: { name: 'New', type: 'checking', balance: 1234 } }, { method: 'POST', path: `${base}/accounts`, body: { account: { name: 'New', type: 'checking', balance: 1234 } } }, { account }],
  ['ynab_create_payee', { name: 'New' }, { method: 'POST', path: `${base}/payees`, body: { payee: { name: 'New' } } }, { payee, server_knowledge: 10 }],
  ['ynab_update_payee', { payee_id: id, name: 'New' }, { method: 'PATCH', path: `${base}/payees/${id}`, body: { payee: { name: 'New' } } }, { payee, server_knowledge: 10 }],
];
function fixture(saved: JsonObject, old: JsonObject = { ...payee, name: 'Old' }, readOnly = false, get?: (request: ApiRequest, requests: ApiRequest[]) => JsonObject) {
  const requests: ApiRequest[] = [];
  const config: Config = { defaultPlanId: plan, allowedPlanIds: [plan], readOnly, allowDeletes: false, allowReconciledChanges: false, allowImports: false, toolProfile: 'extended', timeoutMs: 60000, cacheTtlSeconds: 30, logLevel: 'error' };
  const clock = { now: () => Date.UTC(2026, 9, 7) };
  const api = { async request(_ctx: unknown, request: ApiRequest) {
    requests.push(structuredClone(request));
    return { data: request.method === 'GET' ? (get ? get(request, requests) : requests.some(r => r.method !== 'GET') ? { account, payee, server_knowledge: 11 } : { payee: old }) : saved, fetchedAt: '2026-10-07T00:00:00.000Z' };
  } };
  const state = createSafetyState(config, api, clock);
  const services = { config, clock, api, state };
  const handlers = createAccountPayeeTools(services);
  const dispatcher = createDispatcher(services, handlers);
  async function call(name: ToolName, args: JsonObject) {
    const result = (await dispatcher.callTool(name, args)).structuredContent;
    expect(outputValidators.get(name)!(result)).toBe(true);
    return result;
  }
  return { requests, handlers, call, state, services };
}
describe('account/payee endpoint intent with real safety', () => {
  it('exports exactly the three owned tools', () => expect(Object.keys(fixture({}).handlers).sort()).toEqual(cases.map(c => c[0]).sort()));
  it.each(cases)('%s previews and executes exact wrappers', async (name, args, request, saved) => {
    const f = fixture(saved);
    const preview = await f.call(name, args);
    expect(preview.status).toBe('preview');
    if (preview.status !== 'preview') throw new Error('preview expected');
    expect(preview.preview).toMatchObject({ ...request, validated: true, unknown_effects: false });
    expect(f.requests).toEqual(name === 'ynab_update_payee' ? [{ method: 'GET', path: `${base}/payees/${id}` }] : []);
    f.requests.length = 0;
    const result = await f.call(name, { ...args, dry_run: false, ...(name === 'ynab_update_payee' ? { expected_revision: preview.preview.expected_revisions[`payee:${id}`]! } : {}) });
    expect(result).toMatchObject({ status: 'ok', data: saved });
    expect(f.requests).toEqual(name === 'ynab_update_payee' ? [{ method: 'GET', path: `${base}/payees/${id}` }, { method: 'GET', path: `${base}/payees/${id}` }, request] : [request]);
  });
  it.each(cases)('%s rejects policy before requests', async (name, args, _request, saved) => {
    const f = fixture(saved, undefined, true);
    expect(await f.call(name, { ...args, dry_run: false })).toMatchObject({ status: 'error', error: { code: 'permission_denied', outcome: 'not_applied' } });
    expect(f.requests).toEqual([]);
  });
  it.each(cases)('%s rejects acknowledged wrong fields', async (name, args, _request, saved) => {
    const field = name === 'ynab_create_account' ? 'account' : 'payee';
    const f = fixture({ ...saved, [field]: { ...(saved[field] as JsonObject), name: 'Wrong' } });
    const preview = await f.call(name, args);
    const result = await f.call(name, { ...args, dry_run: false, ...(name === 'ynab_update_payee' ? { expected_revision: preview.meta.revisions![`payee:${id}`]! } : {}) });
    expect(result).toMatchObject({ status: 'error', error: { code: 'verification_failed', outcome: 'applied' } });
    expect(f.requests.filter(r => r.method !== 'GET')).toHaveLength(1);
  });
  it.each(cases)('%s fetches a missing response entity by acknowledged ID', async (name, args, request) => {
    const field = name === 'ynab_create_account' ? 'account' : 'payee';
    const f = fixture({ [`${field}_id`]: id, ...(field === 'payee' ? { server_knowledge: 10 } : {}) });
    const preview = await f.call(name, args);
    const result = await f.call(name, { ...args, dry_run: false, ...(name === 'ynab_update_payee' ? { expected_revision: preview.meta.revisions![`payee:${id}`]! } : {}) });
    expect(result).toMatchObject({ status: 'ok', data: { [field]: field === 'account' ? account : payee } });
    expect(f.requests.at(-1)).toEqual({ method: 'GET', path: `${base}/${field === 'account' ? 'accounts' : 'payees'}/${id}` });
    expect(f.requests.filter(r => r.method !== 'GET')).toEqual([request]);
  });
  it.each(['', 'x'.repeat(501)])('rejects invalid payee names', async name => {
    for (const tool of ['ynab_create_payee', 'ynab_update_payee'] as const) {
      const f = fixture({});
      expect(await f.call(tool, { name, ...(tool === 'ynab_update_payee' ? { payee_id: id } : {}) })).toMatchObject({ status: 'error', error: { code: 'validation_error' } });
      expect(f.requests).toEqual([]);
    }
  });
  it('rejects loan types and unsafe/fractional opening balances', async () => {
    for (const changes of [{ type: 'mortgage' }, { balance: 1.5 }, { balance: 9007199254740992 }]) {
      const f = fixture({});
      expect(await f.call('ynab_create_account', { account: { name: 'New', type: 'checking', balance: 0, ...changes } })).toMatchObject({ status: 'error', error: { code: 'validation_error' } });
      expect(f.requests).toEqual([]);
    }
  });
  it.each(['checking', 'savings', 'cash', 'creditCard', 'otherAsset', 'otherLiability'])('accepts only creatable type %s', async type => {
    expect((await fixture({}).call('ynab_create_account', { account: { name: 'New', type, balance: -100 } })).status).toBe('preview');
  });
  it('rejects transfer and deleted payees after fresh inspection', async () => {
    for (const old of [{ ...payee, transfer_account_id: plan }, { ...payee, deleted: true }]) {
      const f = fixture({}, old);
      expect(await f.call('ynab_update_payee', { payee_id: id, name: 'New' })).toMatchObject({ status: 'error' });
      expect(f.requests).toEqual([{ method: 'GET', path: `${base}/payees/${id}` }]);
    }
  });
  it('requires current revisions for rename execution', async () => {
    for (const expected_revision of [undefined, `sha256:${'0'.repeat(64)}`]) {
      const f = fixture({ payee, server_knowledge: 10 });
      expect(await f.call('ynab_update_payee', { payee_id: id, name: 'New', dry_run: false, ...(expected_revision ? { expected_revision } : {}) })).toMatchObject({ status: 'error', error: { code: expected_revision ? 'conflict' : 'validation_error' } });
      expect(f.requests).toEqual([{ method: 'GET', path: `${base}/payees/${id}` }]);
    }
  });
  it('does not treat an incorrect opening balance/type as verified', async () => {
    for (const changes of [{ balance: 0 }, { type: 'savings' }]) {
      const f = fixture({ account: { ...account, ...changes } });
      expect(await f.call('ynab_create_account', { ...cases[0]![1], dry_run: false })).toMatchObject({ status: 'error', error: { code: 'verification_failed', outcome: 'applied' } });
    }
  });
  it('rechecks a changed rename target immediately before PATCH', async () => {
    const f = fixture({ payee, server_knowledge: 10 }, undefined, false, (_r, requests) => ({ payee: { ...payee, name: requests.length < 3 ? 'Old' : 'Changed' } }));
    const preview = await f.call('ynab_update_payee', { payee_id: id, name: 'New' });
    expect(await f.call('ynab_update_payee', { payee_id: id, name: 'New', dry_run: false, expected_revision: preview.meta.revisions![`payee:${id}`]! })).toMatchObject({ status: 'error', error: { code: 'conflict', outcome: 'not_applied' } });
    expect(f.requests).toEqual(Array.from({ length: 3 }, () => ({ method: 'GET', path: `${base}/payees/${id}` })));
  });
  it('fallback detail GET bypasses cached account state', async () => {
    const f = fixture({ account_id: id }, undefined, false, (_r, requests) => ({ account: requests.some(r => r.method === 'POST') ? account : { ...account, name: 'Cached wrong name' } }));
    const ctx: CallContext = { tool: catalog.find(t => t.name === 'ynab_create_account')!, requestId: 'fixture', planId: plan, startedAtMs: f.services.clock.now(), deadlineMs: f.services.clock.now() + 60000, signal: new AbortController().signal };
    await f.state.get(ctx, `${base}/accounts/${id}`);
    expect(await f.call('ynab_create_account', { ...cases[0]![1], dry_run: false })).toMatchObject({ status: 'ok', data: { account } });
    expect(f.requests).toEqual([{ method: 'GET', path: `${base}/accounts/${id}` }, cases[0]![2], { method: 'GET', path: `${base}/accounts/${id}` }]);
  });
  it('preserves optional account server knowledge without fabricating it', async () => {
    for (const data of [{ account }, { account, server_knowledge: 42 }] as JsonObject[]) {
      expect(await fixture(data).call('ynab_create_account', { ...cases[0]![1], dry_run: false })).toMatchObject({ status: 'ok', data });
    }
  });
  it('fails closed when SavePayeeResponse lacks frozen required server knowledge', async () => {
    const f = fixture({ payee });
    expect(await f.call('ynab_create_payee', { name: 'New', dry_run: false })).toMatchObject({ status: 'error', error: { code: 'verification_failed', outcome: 'applied' } });
    expect(f.requests).toEqual([cases[1]![2]]);
  });
  it('accepts both payee name boundaries unchanged', async () => {
    for (const name of ['x', 'x'.repeat(500)]) {
      const f = fixture({ payee: { ...payee, name }, server_knowledge: 10 });
      expect(await f.call('ynab_create_payee', { name, dry_run: false })).toMatchObject({ status: 'ok', data: { payee: { name } } });
      expect(f.requests).toEqual([{ method: 'POST', path: `${base}/payees`, body: { payee: { name } } }]);
    }
  });
  it('rejects missing or unsafe creation acknowledgment IDs without speculative reads', async () => {
    for (const data of [{}, { account_id: '../escape' }, { account_id: plan }] as JsonObject[]) {
      const f = fixture(data, undefined, false, () => ({ account }));
      expect(await f.call('ynab_create_account', { ...cases[0]![1], dry_run: false })).toMatchObject({ status: 'error', error: { code: 'verification_failed', outcome: 'applied' } });
      expect(f.requests.filter(r => r.method === 'POST')).toEqual([cases[0]![2]]);
      expect(f.requests.filter(r => r.method === 'GET')).toEqual(data.account_id === plan ? [{ method: 'GET', path: `${base}/accounts/${plan}` }] : []);
    }
  });
  it('never verifies a returned different rename identity', async () => {
    const f = fixture({ payee: { ...payee, id: plan }, server_knowledge: 10 });
    const preview = await f.call('ynab_update_payee', { payee_id: id, name: 'New' });
    expect(await f.call('ynab_update_payee', { payee_id: id, name: 'New', dry_run: false, expected_revision: preview.meta.revisions![`payee:${id}`]! })).toMatchObject({ status: 'error', error: { code: 'verification_failed', outcome: 'applied' } });
    expect(f.requests.filter(r => r.method !== 'GET')).toEqual([cases[2]![2]]);
  });
  it('catalog entries remain the source of input/output definitions', () => expect(cases.every(([name]) => catalog.some(t => t.name === name))).toBe(true));
});
