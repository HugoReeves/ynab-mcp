import { expect, it } from 'vitest';
import { createScheduledTools } from '../../src/tools/scheduled.js';
import { createSafetyState } from '../../src/safety/index.js';
import { createDispatcher } from '../../src/runtime/dispatcher.js';
import { inputValidators, outputValidators } from '../../src/catalog.js';
import { ToolFailure } from '../../src/errors.js';
import type { ApiRequest, Config, JsonObject, Services, ToolName } from '../../src/contracts.js';
const id = (n: number) => `${String(n).padStart(8, '0')}-1111-4111-8111-111111111111`;
const plan = id(1), account = id(2), category = id(3), group = id(4), schedule = id(5), payee = id(6), dest = id(7), transfer = id(8);
const base = `/plans/${plan}`, time = '2026-10-07T23:59:00.000Z';
const write = (extra: JsonObject = {}): JsonObject => ({ account_id: account, date: '2026-10-08', amount: -1000, frequency: 'monthly', ...extra });
const row = (extra: JsonObject = {}): JsonObject => ({ id: schedule, account_id: account, account_name: 'Checking', amount: -1000,
  date_first: '2026-01-01', date_next: '2026-10-08', frequency: 'monthly', deleted: false, subtransactions: [],
  payee_id: payee, payee_name: 'Old', category_id: category, memo: 'Old memo', flag_color: 'blue', ...extra });
const acct = (key: string, extra: JsonObject = {}): JsonObject => ({ id: key, name: 'Checking', type: 'checking', on_budget: true,
  closed: false, deleted: false, balance: 0, cleared_balance: 0, uncleared_balance: 0, transfer_payee_id: null, ...extra });
function harness(o: { config?: Partial<Config>; old?: JsonObject; accounts?: JsonObject[]; category?: JsonObject; group?: JsonObject;
  ignore?: boolean; reply?: JsonObject; omit?: boolean; absent?: boolean; now?: string } = {}) {
  const requests: ApiRequest[] = []; let entity = o.old ?? row();
  const config: Config = { defaultPlanId: plan, allowedPlanIds: [plan], readOnly: false, allowDeletes: true, allowReconciledChanges: false,
    allowImports: false, toolProfile: 'core', timeoutMs: 1000, cacheTtlSeconds: 30, logLevel: 'error', ...o.config };
  const api: Services['api'] = { async request(_ctx, req) {
    requests.push(structuredClone(req)); let data: JsonObject;
    if (req.method === 'GET') {
      if (req.path === `${base}/accounts`) data = { accounts: o.accounts ?? [acct(account), acct(dest, { transfer_payee_id: transfer })], server_knowledge: 1 };
      else if (req.path === `${base}/payees`) data = { payees: [{ id: payee, name: 'Old', deleted: false }, { id: transfer, name: 'Transfer', deleted: false, transfer_account_id: dest }], server_knowledge: 1 };
      else if (req.path === `${base}/categories`) data = { category_groups: [{ id: group, name: 'Ordinary', hidden: false, deleted: false, internal: false,
        ...o.group, categories: [{ id: category, category_group_id: group, name: 'Food', hidden: false, deleted: false, internal: false, budgeted: 0, activity: 0, balance: 0, ...o.category }] }], server_knowledge: 1 };
      else {
        if (o.absent && requests.some(r => r.method === 'DELETE')) throw new ToolFailure({ code: 'not_found', message: 'Absent', http_status: 404, retryable: false, outcome: 'not_applied' });
        data = { scheduled_transaction: entity };
      }
    } else {
      if (!o.ignore) {
        if (req.method === 'DELETE') entity = { ...entity, deleted: true };
        else {
          const intent = req.body!.scheduled_transaction as JsonObject;
          const { date, ...fields } = intent;
          entity = { ...(req.method === 'POST' ? row({ payee_id: null, payee_name: null, category_id: null, memo: null, flag_color: null }) : entity), ...fields, date_next: date! };
          if (typeof intent.payee_name === 'string') entity = { ...entity, payee_id: payee, payee_name: 'Renamed' };
          else if (typeof intent.payee_id === 'string') entity.payee_name = 'Resolved';
        }
      }
      data = o.reply ?? (o.omit ? { scheduled_transaction: { id: schedule } } : { scheduled_transaction: entity });
    }
    return { data: structuredClone(data), fetchedAt: time };
  } };
  const clock = { now: () => Date.parse(o.now ?? time) }, state = createSafetyState(config, api, clock);
  const services = { config, api, state, clock }, tools = createScheduledTools(services), dispatch = createDispatcher(services, tools);
  async function call(kind: string, args: JsonObject) {
    const name = `ynab_${kind}_scheduled_transaction` as ToolName;
    const result = (await dispatch.callTool(name, args)).structuredContent;
    expect(outputValidators.get(name)!(result)).toBe(true); return result;
  }
  return { call, requests, tools, mutations: () => requests.filter(r => r.method !== 'GET') };
}
const argsFor = (kind: string, w = write()): JsonObject => kind === 'create' ? { scheduled_transaction: w }
  : kind === 'update' ? { scheduled_transaction_id: schedule, scheduled_transaction: w } : { scheduled_transaction_id: schedule, confirm_delete: true };
async function execute(h: ReturnType<typeof harness>, kind: string, args = argsFor(kind)) {
  expect(inputValidators.get(`ynab_${kind}_scheduled_transaction` as ToolName)!(args)).toBe(true);
  const preview = await h.call(kind, args); expect(preview.status, JSON.stringify(preview)).toBe('preview');
  if (preview.status !== 'preview') throw new Error(JSON.stringify(preview));
  expect(h.mutations()).toEqual([]);
  const result = await h.call(kind, { ...args, dry_run: false, ...(kind === 'create' ? {} : { expected_revision: preview.preview.expected_revisions[`scheduled_transaction:${schedule}`]! }) });
  return { result, preview: preview.preview };
}
it('exports exactly the three owned handlers', () => expect(Object.keys(harness().tools).sort()).toEqual(['ynab_create_scheduled_transaction', 'ynab_delete_scheduled_transaction', 'ynab_update_scheduled_transaction']));
it.each(['create', 'update', 'delete'])('%s schema-valid preview, execution, exact request and denial', async kind => {
  const h = harness(), { result, preview } = await execute(h, kind); expect(result.status).toBe('ok');
  const method = kind === 'create' ? 'POST' : kind === 'update' ? 'PUT' : 'DELETE';
  const path = `${base}/scheduled_transactions${kind === 'create' ? '' : `/${schedule}`}`;
  const body = kind === 'delete' ? null : { scheduled_transaction: kind === 'create' ? write() : write({ payee_id: payee, category_id: category, memo: 'Old memo', flag_color: 'blue' }) };
  expect(preview).toMatchObject({ method, path, body, validated: true });
  expect(h.mutations()).toEqual([{ method, path, ...(body ? { body } : {}) }]);
  if (result.status === 'ok') expect(result.meta.revisions).toEqual(kind === 'delete' ? {} : { [`scheduled_transaction:${schedule}`]: expect.stringMatching(/^sha256:/) });
  const denied = harness({ config: { readOnly: true } }); expect(await denied.call(kind, argsFor(kind))).toMatchObject({ status: 'error', error: { code: 'permission_denied' } }); expect(denied.requests).toEqual([]);
});
it.each(['never','daily','weekly','everyOtherWeek','twiceAMonth','every4Weeks','monthly','everyOtherMonth','every3Months','every4Months','twiceAYear','yearly','everyOtherYear'])('frequency %s compares directly', async frequency => {
  const h = harness(); expect((await execute(h, 'create', argsFor('create', write({ frequency })))).result.status).toBe('ok');
  expect(h.mutations()[0]?.body).toEqual({ scheduled_transaction: write({ frequency }) });
});
it.each(['2026-10-07', '2026-10-06', '2031-10-08', '2027-02-29'])('rejects date %s', async date => {
  const h = harness(); expect(await h.call('create', argsFor('create', write({ date })))).toMatchObject({ status: 'error', error: { code: 'validation_error' } }); expect(h.mutations()).toEqual([]);
});
it.each(['2026-10-08', '2031-10-07'])('inclusive future window %s', async date => expect((await execute(harness(), 'create', argsFor('create', write({ date })))).result.status).toBe('ok'));
it('leap-day five-year boundary clamps to February 28 UTC', async () => {
  const h = harness({ now: '2024-02-29T23:59:59Z' }); expect((await execute(h, 'create', argsFor('create', write({ date: '2029-02-28' })))).result.status).toBe('ok');
  expect(await harness({ now: '2024-02-29T23:59:59Z' }).call('create', argsFor('create', write({ date: '2029-03-01' })))).toMatchObject({ status: 'error' });
});
const selectors: [JsonObject, JsonObject][] = [[{}, { payee_id: payee }], [{ payee_name: 'New' }, { payee_id: null, payee_name: 'New' }],
  [{ payee_id: payee }, { payee_id: payee }], [{ payee_id: null }, { payee_id: null, payee_name: null }], [{ payee_name: null }, { payee_id: null, payee_name: null }],
  [{ payee_id: payee, payee_name: null }, { payee_id: payee }], [{ payee_id: null, payee_name: 'New' }, { payee_id: null, payee_name: 'New' }]];
it.each(selectors)('merges coupled selectors %j', async (input, expected) => {
  const h = harness(), { result } = await execute(h, 'update', argsFor('update', write(input))); expect(result.status).toBe('ok');
  expect(h.mutations()[0]?.body).toEqual({ scheduled_transaction: write({ category_id: category, memo: 'Old memo', flag_color: 'blue', ...expected }) });
});
it('preserves name only when old ID absent, and explicit null optional fields', async () => {
  const h = harness({ old: row({ payee_id: null }) }); expect((await execute(h, 'update', argsFor('update', write({ memo: null, category_id: null, flag_color: null })))).result.status).toBe('ok');
  expect(h.mutations()[0]?.body).toEqual({ scheduled_transaction: write({ payee_id: null, payee_name: 'Old', memo: null, category_id: null, flag_color: null }) });
});
it.each(['create', 'update'])('%s rejects conflicting selectors', async kind => {
  const h = harness(); expect(await h.call(kind, argsFor(kind, write({ payee_id: payee, payee_name: 'New' })))).toMatchObject({ status: 'error', error: { code: 'validation_error' } }); expect(h.mutations()).toEqual([]);
});
it.each(['approved', 'cleared', 'import_id', 'subtransactions', 'date_next'])('rejects forbidden field %s', async field => {
  const h = harness(); expect(await h.call('create', argsFor('create', write({ [field]: field === 'subtransactions' ? [] : null })))).toMatchObject({ status: 'error', error: { code: 'validation_error' } }); expect(h.mutations()).toEqual([]);
});
it('protects existing splits from any update but permits gated deletion', async () => {
  const old = row({ subtransactions: [{ id: id(9), scheduled_transaction_id: schedule, amount: -1000, deleted: false }] });
  const h = harness({ old }); expect(await h.call('update', argsFor('update'))).toMatchObject({ status: 'error', error: { code: 'unsupported_operation' } }); expect(h.mutations()).toEqual([]);
  expect((await execute(harness({ old }), 'delete')).result.status).toBe('ok');
});
it.each(['account', 'closed', 'self', 'transferName', 'transferCategory', 'tracking', 'category', 'payment', 'internal', 'deleted'])('semantic rejection %s', async test => {
  const options: Parameters<typeof harness>[0] = {}; let w = write();
  if (test === 'account') w.account_id = id(99);
  if (test === 'closed') options.accounts = [acct(account, { closed: true })];
  if (test === 'self') { options.accounts = [acct(account, { transfer_payee_id: transfer })]; w.payee_id = transfer; }
  if (test === 'transferName') w.payee_name = 'Transfer';
  if (test === 'transferCategory') w = write({ payee_id: transfer, category_id: category });
  if (test === 'tracking') { options.accounts = [acct(account, { on_budget: false })]; w.category_id = category; }
  if (test === 'category') w.category_id = id(99);
  if (test === 'payment') { options.group = { name: 'Credit Card Payments' }; w.category_id = category; }
  if (test === 'internal') { options.category = { internal: true }; w.category_id = category; }
  if (test === 'deleted') options.old = row({ deleted: true });
  const h = harness(options); expect((await h.call(test === 'deleted' ? 'update' : 'create', argsFor(test === 'deleted' ? 'update' : 'create', w))).status).toBe('error'); expect(h.mutations()).toEqual([]);
});
it('transfer creation and non-split transfer update submit only one schedule', async () => {
  for (const kind of ['create', 'update']) {
    const h = harness(); expect((await execute(h, kind, argsFor(kind, write({ payee_id: transfer, category_id: null })))).result.status).toBe('ok'); expect(h.mutations()).toHaveLength(1);
  }
});
it('tracking destination permits onbudget category, hidden category warns', async () => {
  const h = harness({ accounts: [acct(account), acct(dest, { on_budget: false, transfer_payee_id: transfer })], category: { hidden: true } });
  const { result, preview } = await execute(h, 'create', argsFor('create', write({ payee_id: transfer, category_id: category }))); expect(result.status).toBe('ok'); expect(preview.warnings.join(' ')).toMatch(/hidden/);
});
it.each(['date', 'amount', 'frequency', 'memo', 'flag_color', 'category_id', 'payee_id'])('ignored %s fails verification', async field => {
  const values: JsonObject = { date: '2026-11-01', amount: 123, frequency: 'yearly', memo: 'New', flag_color: 'red', category_id: null, payee_id: null };
  const h = harness({ ignore: true }); expect((await execute(h, 'update', argsFor('update', write({ [field]: values[field]! })))).result).toMatchObject({ status: 'error', error: { code: 'verification_failed', outcome: 'applied' } }); expect(h.mutations()).toHaveLength(1);
});
it.each(['create', 'update'])('%s fresh detail fallback for ID-only acknowledgment', async kind => {
  const h = harness({ omit: true }); expect((await execute(h, kind)).result.status).toBe('ok'); expect(h.requests.at(-1)).toEqual({ method: 'GET', path: `${base}/scheduled_transactions/${schedule}` });
});
it('wrong target response fails without substituting intended ID', async () => expect((await execute(harness({ reply: { scheduled_transaction: row({ id: id(99) }) } }), 'update')).result).toMatchObject({ status: 'error', error: { code: 'verification_failed' } }));
it('delete contradictory acknowledgment rereads detail; still-live fails, 404 confirms absence', async () => {
  expect((await execute(harness({ ignore: true }), 'delete')).result).toMatchObject({ status: 'error', error: { code: 'verification_failed' } });
  expect((await execute(harness({ reply: { scheduled_transaction: row() } }), 'delete')).result.status).toBe('ok');
  expect((await execute(harness({ reply: { scheduled_transaction: row() }, absent: true }), 'delete')).result.status).toBe('ok');
});
it('delete gates and expected revision are delegated to real state', async () => {
  for (const kind of ['update','delete']) {
    const h = harness(); expect(await h.call(kind, { ...argsFor(kind), dry_run: false })).toMatchObject({ status: 'error', error: { code: 'validation_error' } });
    expect(await h.call(kind, { ...argsFor(kind), dry_run: false, expected_revision: `sha256:${'0'.repeat(64)}` })).toMatchObject({ status: 'error', error: { code: 'conflict' } }); expect(h.mutations()).toEqual([]);
  }
  expect(await harness().call('delete', { scheduled_transaction_id: schedule })).toMatchObject({ status: 'error', error: { code: 'validation_error' } });
  const denied = harness({ config: { allowDeletes: false } }); expect(await denied.call('delete', argsFor('delete'))).toMatchObject({ status: 'error', error: { code: 'permission_denied' } }); expect(denied.requests).toEqual([]);
});
it.each(['create', 'update'])('%s rejects unknown frequency, unsafe amount, and missing required fields', async kind => {
  const invalidFields: JsonObject[] = [{ frequency: 'quarterly' }, { amount: Number.MAX_SAFE_INTEGER + 1 }, { frequency: null }];
  for (const fields of invalidFields) {
    const h = harness(); expect(await h.call(kind, argsFor(kind, write(fields)))).toMatchObject({ status: 'error', error: { code: 'validation_error' } }); expect(h.mutations()).toEqual([]);
  }
  for (const field of ['account_id', 'date', 'amount', 'frequency']) {
    const w = write(); delete w[field]; const h = harness();
    expect(await h.call(kind, argsFor(kind, w))).toMatchObject({ status: 'error', error: { code: 'validation_error' } }); expect(h.mutations()).toEqual([]);
  }
});
it.each(['missingDestination', 'deletedSource', 'deletedCategory', 'deletedGroup', 'missingPayee'])('rejects selected-plan context %s', async test => {
  const options: Parameters<typeof harness>[0] = {}; let w = write({ category_id: category });
  if (test === 'missingDestination') { options.accounts = [acct(account)]; w = write({ payee_id: transfer }); }
  if (test === 'deletedSource') options.accounts = [acct(account, { deleted: true })];
  if (test === 'deletedCategory') options.category = { deleted: true };
  if (test === 'deletedGroup') options.group = { deleted: true };
  if (test === 'missingPayee') w.payee_id = id(99);
  const h = harness(options); expect(await h.call('create', argsFor('create', w))).toMatchObject({ status: 'error', error: { code: 'validation_error' } }); expect(h.mutations()).toEqual([]);
});
it('update validates the preserved category against the new account/transfer context', async () => {
  const h = harness(); expect(await h.call('update', argsFor('update', write({ payee_id: transfer })))).toMatchObject({ status: 'error', error: { code: 'validation_error' } }); expect(h.mutations()).toEqual([]);
});
it('supports internal Ready to Assign only for inflow', async () => {
  const h = harness({ category: { internal: true, name: 'Ready to Assign' } });
  expect((await execute(h, 'create', argsFor('create', write({ amount: 1000, category_id: category })))).result.status).toBe('ok');
  expect(h.mutations()[0]?.body).toEqual({ scheduled_transaction: write({ amount: 1000, category_id: category }) });
});
it('never claims name resolution verified without a returned payee identity', async () => {
  const h = harness({ reply: { scheduled_transaction: row({ payee_id: null, payee_name: 'New' }) } });
  expect((await execute(h, 'create', argsFor('create', write({ payee_name: 'New' })))).result).toMatchObject({ status: 'error', error: { code: 'verification_failed', outcome: 'applied' } });
});
it.each(['create','update'])('%s has schema-valid exact full ScheduledWrite body', async kind => {
  const full = write({ payee_id: payee, category_id: category, memo: 'All', flag_color: 'purple' });
  const h = harness(), { result, preview } = await execute(h, kind, argsFor(kind, full)); expect(result.status).toBe('ok');
  expect(preview.body).toEqual({ scheduled_transaction: full }); expect(h.mutations()[0]?.body).toEqual({ scheduled_transaction: full });
});
it('update validates future date even when the schedule already exists', async () => {
  const h = harness(); expect(await h.call('update', argsFor('update', write({ date: '2026-10-07' })))).toMatchObject({ status: 'error', error: { code: 'validation_error' } }); expect(h.mutations()).toEqual([]);
});
it('plan allowlist is checked before any semantic reads', async () => {
  const h = harness(); expect(await h.call('create', { ...argsFor('create'), plan_id: id(99) })).toMatchObject({ status: 'error', error: { code: 'permission_denied' } }); expect(h.requests).toEqual([]);
});
