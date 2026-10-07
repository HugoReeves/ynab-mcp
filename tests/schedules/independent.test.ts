import { describe, expect, it } from 'vitest';
import { catalog, inputValidators, outputValidators } from '../../src/catalog.js';
import type { ApiRequest, Config, JsonObject, Services, ToolName } from '../../src/contracts.js';
import { createDispatcher } from '../../src/runtime/dispatcher.js';
import { createSafetyState } from '../../src/safety/index.js';
import { createScheduledTools } from '../../src/tools/scheduled.js';
import { writes } from '../integration/route-fixtures.js';

// Strict fake API: unknown routes throw; actual dispatcher and safety are retained.
const uuid = (n: number) => `${n.toString().padStart(8, '0')}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`;
const plan = uuid(1), source = uuid(2), destination = uuid(3), payee = uuid(4), otherPayee = uuid(5);
const category = uuid(6), group = uuid(7), schedule = uuid(8), transfer = uuid(9);
const root = `/plans/${plan}`, detail = `${root}/scheduled_transactions/${schedule}`;
const stamp = '2028-02-29T23:59:59.999Z';
const intent = (patch: JsonObject = {}): JsonObject => ({ account_id: source, date: '2028-03-01', amount: -42, frequency: 'never', ...patch });
const account = (id: string, patch: JsonObject = {}): JsonObject => ({ id, name: id, type: 'checking', on_budget: true, closed: false, deleted: false, balance: 0, cleared_balance: 0, uncleared_balance: 0, transfer_payee_id: null, ...patch });
const original = (): JsonObject => ({ id: schedule, account_id: source, account_name: 'Source', date_first: '2020-01-01', date_next: '2028-03-01', amount: -42, frequency: 'never', deleted: false, subtransactions: [], payee_id: payee, payee_name: 'Before', category_id: category, memo: 'preserve', flag_color: 'green' });
type Kind = 'create' | 'update' | 'delete';
const names: Record<Kind, ToolName> = { create: 'ynab_create_scheduled_transaction', update: 'ynab_update_scheduled_transaction', delete: 'ynab_delete_scheduled_transaction' };
function setup(options: { old?: JsonObject; accounts?: JsonObject[]; category?: JsonObject; group?: JsonObject; omitReply?: boolean; savedPatch?: JsonObject; config?: Partial<Config> } = {}) {
  const requests: ApiRequest[] = [];
  let saved = options.old ?? original();
  const config: Config = { defaultPlanId: plan, allowedPlanIds: [plan], toolProfile: 'extended', readOnly: false, allowDeletes: true, allowImports: false, allowReconciledChanges: false, timeoutMs: 1000, cacheTtlSeconds: 30, logLevel: 'error', ...options.config };
  const api: Services['api'] = { async request(_ctx, req) {
    requests.push(structuredClone(req));
    let data: JsonObject;
    if (req.method === 'GET') {
      switch (req.path) {
        case `${root}/accounts`: data = { accounts: options.accounts ?? [account(source), account(destination, { transfer_payee_id: transfer })], server_knowledge: 10 }; break;
        case `${root}/payees`: data = { payees: [{ id: payee, name: 'Before', deleted: false, transfer_account_id: null }, { id: otherPayee, name: 'After rename', deleted: false, transfer_account_id: null }, { id: transfer, name: 'Transfer destination', deleted: false, transfer_account_id: destination }], server_knowledge: 10 }; break;
        case `${root}/categories`: data = { category_groups: [{ id: group, name: 'Living', hidden: false, deleted: false, internal: false, ...options.group, categories: [{ id: category, category_group_id: group, name: 'Food', hidden: false, deleted: false, internal: false, budgeted: 0, activity: 0, balance: 0, ...options.category }] }], server_knowledge: 10 }; break;
        case detail: data = { scheduled_transaction: saved }; break;
        default: throw new Error(`Unexpected GET ${req.path}`);
      }
    } else {
      expect(req.path).toBe(req.method === 'POST' ? `${root}/scheduled_transactions` : detail);
      expect(['POST', 'PUT', 'DELETE']).toContain(req.method);
      if (req.method === 'DELETE') saved = { ...saved, deleted: true };
      else {
        const body = req.body!.scheduled_transaction as JsonObject;
        const { date, ...fields } = body;
        saved = { ...(req.method === 'POST' ? { ...original(), payee_id: null, payee_name: null, category_id: null, memo: null, flag_color: null } : saved), ...fields, date_next: date! };
        // Simulate upstream identity resolution independently of the production verifier.
        if (typeof fields.payee_name === 'string') saved = { ...saved, payee_id: otherPayee, payee_name: 'After rename' };
        else if (typeof fields.payee_id === 'string') saved.payee_name = 'Display only';
      }
      Object.assign(saved, options.savedPatch);
      data = { scheduled_transaction: options.omitReply ? { id: schedule } : saved };
    }
    return { data: structuredClone(data), fetchedAt: stamp };
  } };
  const clock = { now: () => Date.parse(stamp) }, state = createSafetyState(config, api, clock);
  const services: Services = { config, api, clock, state };
  const handlers = createScheduledTools(services), dispatch = createDispatcher(services, handlers);
  const mutations = () => requests.filter(r => r.method !== 'GET');
  const args = (kind: Kind, body: JsonObject = intent()): JsonObject => kind === 'delete' ? { scheduled_transaction_id: schedule, confirm_delete: true } : { scheduled_transaction: body, ...(kind === 'update' ? { scheduled_transaction_id: schedule } : {}) };
  async function call(kind: Kind, a: JsonObject) {
    const result = (await dispatch.callTool(names[kind], a)).structuredContent;
    expect(outputValidators.get(names[kind])!(result)).toBe(true);
    return result;
  }
  async function run(kind: Kind, body = intent()) {
    const a = args(kind, body);
    expect(inputValidators.get(names[kind])!(a)).toBe(true);
    const preview = await call(kind, a);
    expect(preview.status, JSON.stringify(preview)).toBe('preview');
    if (preview.status !== 'preview') throw new Error('Preview rejected');
    expect(mutations()).toEqual([]);
    const result = await call(kind, { ...a, dry_run: false, ...(kind === 'create' ? {} : { expected_revision: preview.preview.expected_revisions[`scheduled_transaction:${schedule}`]! }) });
    expect(mutations()).toHaveLength(1);
    return { result, preview: preview.preview };
  }
  return { args, call, run, requests, mutations, handlers };
}

describe('independent bounded schedules verification', () => {
  it('checks the exact 18-write positive fixture inventory (not execution of missing handlers)', () => {
    expect(writes).toHaveLength(18);
    expect(new Set(writes.map(w => w.name)).size).toBe(18);
    expect(writes.map(w => w.name).sort()).toEqual(catalog.filter(t => !t.annotations.readOnlyHint).map(t => t.name).sort());
    for (const w of writes) expect(inputValidators.get(w.name)!(w.args)).toBe(true);
    expect(Object.keys(setup().handlers).sort()).toEqual(Object.values(names).sort());
  });
  it.each<Kind>(['create', 'update', 'delete'])('%s positive preview/execution route and revision contract', async kind => {
    const h = setup(), { preview, result } = await h.run(kind);
    const body = kind === 'delete' ? null : { scheduled_transaction: kind === 'create' ? intent() : intent({ payee_id: payee, category_id: category, memo: 'preserve', flag_color: 'green' }) };
    const path = kind === 'create' ? `${root}/scheduled_transactions` : detail;
    const method = kind === 'create' ? 'POST' : kind === 'update' ? 'PUT' : 'DELETE';
    expect(preview).toMatchObject({ path, method, body, validated: true });
    expect(h.mutations()).toEqual([{ path, method, ...(body ? { body } : {}) }]);
    expect(result.status).toBe('ok');
    if (result.status === 'ok') expect(result.meta.revisions).toEqual(kind === 'delete' ? {} : { [`scheduled_transaction:${schedule}`]: expect.stringMatching(/^sha256:/) });
  });
  const selectors: [JsonObject, JsonObject][] = [
    [{}, { payee_id: payee }], [{ payee_id: otherPayee }, { payee_id: otherPayee }],
    [{ payee_name: 'Requested' }, { payee_id: null, payee_name: 'Requested' }],
    [{ payee_id: null, payee_name: 'Requested' }, { payee_id: null, payee_name: 'Requested' }],
    [{ payee_id: otherPayee, payee_name: null }, { payee_id: otherPayee }],
    [{ payee_id: null }, { payee_id: null, payee_name: null }],
    [{ payee_name: null }, { payee_id: null, payee_name: null }],
  ];
  it.each(selectors)('selector-aware merge %j preserves unrelated optionals', async (fields, expected) => {
    const h = setup(), { preview, result } = await h.run('update', intent(fields));
    expect(result.status).toBe('ok');
    expect(preview.body).toEqual({ scheduled_transaction: intent({ category_id: category, memo: 'preserve', flag_color: 'green', ...expected }) });
  });
  it('preserves a name-only old payee and explicitly clears optional fields', async () => {
    const h = setup({ old: { ...original(), payee_id: null } });
    const { preview, result } = await h.run('update', intent({ memo: null, category_id: null, flag_color: null }));
    expect(result.status).toBe('ok');
    expect(preview.body).toEqual({ scheduled_transaction: intent({ memo: null, category_id: null, flag_color: null, payee_id: null, payee_name: 'Before' }) });
  });
  it.each(['account_id', 'date', 'amount', 'frequency', 'memo', 'category_id', 'flag_color', 'payee_id'])('detects isolated ignored %s even with a schema-valid acknowledgment', async field => {
    const changes: JsonObject = { account_id: destination, date: '2028-04-01', amount: -1, frequency: 'yearly', memo: null, category_id: null, flag_color: null, payee_id: null };
    const outputField = field === 'date' ? 'date_next' : field;
    const h = setup({ savedPatch: { [outputField]: original()[outputField]! } });
    const { result } = await h.run('update', intent({ [field]: changes[field]! }));
    expect(result).toMatchObject({ status: 'error', error: { code: 'verification_failed', outcome: 'applied' } });
  });
  it('does not mistake date_first for date_next', async () => {
    const h = setup({ savedPatch: { date_first: '2028-04-01', date_next: '2028-03-01' } });
    expect((await h.run('update', intent({ date: '2028-04-01' }))).result).toMatchObject({ status: 'error', error: { code: 'verification_failed' } });
  });
  it.each<Kind>(['create', 'update', 'delete'])('%s verifies an ID-only acknowledgment by detail GET', async kind => {
    const h = setup({ omitReply: true });
    expect((await h.run(kind)).result.status).toBe('ok');
    expect(h.requests.at(-1)).toEqual({ method: 'GET', path: detail });
  });
  it('detail fallback does not turn an ignored mutation into success', async () => {
    const h = setup({ omitReply: true, savedPatch: { memo: 'preserve' } });
    expect((await h.run('update', intent({ memo: 'changed' }))).result).toMatchObject({ status: 'error', error: { code: 'verification_failed', outcome: 'applied' } });
  });
  it.each(['2028-02-29', '2028-02-30', '2033-03-01', '0000-03-01'])('rejects invalid/out-of-window UTC date %s before writes', async date => {
    const h = setup();
    expect(await h.call('create', h.args('create', intent({ date })))).toMatchObject({ status: 'error', error: { code: 'validation_error' } });
    expect(h.mutations()).toEqual([]);
  });
  it.each(['2028-03-01', '2033-02-28'])('accepts inclusive future boundary %s', async date => {
    expect((await setup().run('create', intent({ date }))).result.status).toBe('ok');
  });
  it.each(['daily','weekly','everyOtherWeek','twiceAMonth','every4Weeks','monthly','everyOtherMonth','every3Months','every4Months','twiceAYear','yearly','everyOtherYear'])('supports frequency %s', async frequency => {
    expect((await setup().run('create', intent({ frequency }))).result.status).toBe('ok');
  });
  it.each(['date_first','date_next','approved','cleared','import_id','subtransactions'])('rejects non-ScheduledWrite field %s', async key => {
    const h = setup();
    expect(await h.call('create', h.args('create', intent({ [key]: null })))).toMatchObject({ status: 'error', error: { code: 'validation_error' } });
    expect(h.requests).toEqual([]);
  });
  it.each(['account_id','date','amount','frequency'])('requires %s without schema coercion/defaults', async field => {
    const h = setup(), body = intent(); delete body[field];
    expect(await h.call('update', h.args('update', body))).toMatchObject({ status: 'error', error: { code: 'validation_error' } });
    expect(h.requests).toEqual([]);
  });
  it.each([false, true])('transfer category validity depends on destination on_budget=%s', async onBudget => {
    const h = setup({ accounts: [account(source), account(destination, { on_budget: onBudget, transfer_payee_id: transfer })] });
    const body = intent({ payee_id: transfer, category_id: category });
    if (onBudget) {
      expect(await h.call('create', h.args('create', body))).toMatchObject({ status: 'error', error: { code: 'validation_error' } });
      expect(h.mutations()).toEqual([]);
    } else expect((await h.run('create', body)).result.status).toBe('ok');
  });
  it('requires clearing preserved category when changing ordinary schedule to on-budget transfer', async () => {
    const h = setup();
    expect(await h.call('update', h.args('update', intent({ payee_id: transfer })))).toMatchObject({ status: 'error', error: { code: 'validation_error' } });
    expect(h.mutations()).toEqual([]);
    expect((await h.run('update', intent({ payee_id: transfer, category_id: null }))).result.status).toBe('ok');
  });
  it('allows unchanged closed source on update, but rejects creates and moves to it', async () => {
    const options = { accounts: [account(source, { closed: true }), account(destination)] };
    expect((await setup(options).run('update')).result.status).toBe('ok');
    for (const kind of ['create', 'update'] as const) {
      const h = setup({ ...options, ...(kind === 'update' ? { old: { ...original(), account_id: destination } } : {}) });
      expect(await h.call(kind, h.args(kind))).toMatchObject({ status: 'error', error: { code: 'validation_error' } });
      expect(h.mutations()).toEqual([]);
    }
  });
  it.each(['self','nameTransfer','trackingCategory','deletedCategory','deletedGroup','paymentCategory','internalOutflow','split'])('rejects domain invariant violation: %s', async mode => {
    const options: Parameters<typeof setup>[0] = {};
    const body = intent();
    if (mode === 'self') { options.accounts = [account(source, { transfer_payee_id: transfer })]; body.payee_id = transfer; }
    if (mode === 'nameTransfer') body.payee_name = 'Transfer destination';
    if (mode === 'trackingCategory') options.accounts = [account(source, { on_budget: false })];
    if (mode === 'deletedCategory') options.category = { deleted: true };
    if (mode === 'deletedGroup') options.group = { deleted: true };
    if (mode === 'paymentCategory') options.group = { name: 'Credit Card Payments' };
    if (mode === 'internalOutflow') options.category = { internal: true, name: 'Ready to Assign' };
    if (mode === 'split') options.old = { ...original(), subtransactions: [{ id: uuid(10), scheduled_transaction_id: schedule, amount: -42, deleted: false }] };
    const h = setup(options);
    expect((await h.call('update', h.args('update', body))).status).toBe('error');
    expect(h.mutations()).toEqual([]);
  });
  it.each<Kind>(['create', 'update', 'delete'])('%s cannot bypass read-only policy even by preview', async kind => {
    const h = setup({ config: { readOnly: true } });
    expect(await h.call(kind, h.args(kind))).toMatchObject({ status: 'error', error: { code: 'permission_denied' } });
    expect(h.requests).toEqual([]);
  });
  it.each<Kind>(['update', 'delete'])('%s requires a current revision for execution', async kind => {
    const h = setup();
    expect(await h.call(kind, { ...h.args(kind), dry_run: false })).toMatchObject({ status: 'error', error: { code: 'validation_error' } });
    expect(await h.call(kind, { ...h.args(kind), dry_run: false, expected_revision: `sha256:${'0'.repeat(64)}` })).toMatchObject({ status: 'error', error: { code: 'conflict' } });
    expect(h.mutations()).toEqual([]);
  });
  it.each<JsonObject>([{ payee_id: payee, payee_name: 'Ambiguous' }, { amount: '42' }, { amount: Number.MAX_SAFE_INTEGER + 1 }, { frequency: 'quarterly' }, { memo: 'm'.repeat(501) }, { payee_name: 'n'.repeat(201) }])('rejects invalid scalars or selectors %j', async patch => {
    const h = setup();
    expect(await h.call('create', h.args('create', intent(patch)))).toMatchObject({ status: 'error', error: { code: 'validation_error' } });
    expect(h.mutations()).toEqual([]);
  });
  it('does not invent absent optional values except the coupled payee clear', async () => {
    const old = original();
    for (const key of ['memo', 'flag_color', 'category_id', 'payee_id', 'payee_name']) delete old[key];
    const h = setup({ old });
    const { preview, result } = await h.run('update');
    expect(result.status).toBe('ok');
    expect(preview.body).toEqual({ scheduled_transaction: intent({ payee_id: null, payee_name: null }) });
  });
  it('split deletion remains available only with both confirmation and delete permission', async () => {
    const old = { ...original(), subtransactions: [{ id: uuid(10), scheduled_transaction_id: schedule, amount: -42, deleted: false }] };
    expect((await setup({ old }).run('delete')).result.status).toBe('ok');
    const h = setup({ old });
    expect(await h.call('delete', { scheduled_transaction_id: schedule })).toMatchObject({ status: 'error', error: { code: 'validation_error' } });
    const denied = setup({ old, config: { allowDeletes: false } });
    expect(await denied.call('delete', denied.args('delete'))).toMatchObject({ status: 'error', error: { code: 'permission_denied' } });
    expect([...h.mutations(), ...denied.mutations()]).toEqual([]);
  });
  it('warns for hidden category; supports internal Ready to Assign inflow', async () => {
    const h = setup({ category: { hidden: true, internal: true, name: 'Ready to Assign' } });
    const { result, preview } = await h.run('create', intent({ category_id: category, amount: 100 }));
    expect(result.status).toBe('ok'); expect(preview.warnings.join(' ')).toMatch(/hidden/i);
  });
});
