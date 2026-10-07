import { describe, it, expect } from 'vitest';
import { createSafetyState } from '../../src/safety/index.js';
import { assertCalendarDate, assertTransactionDate, assertScheduledDate, resolveReadMonth, oneYearAgo } from '../../src/safety/dates.js';
import { catalog } from '../../src/catalog.js';
import type { Config, CallContext, ApiRequest, JsonObject, WriteSpec, PreparedWrite, OkResult, ApiReply } from '../../src/contracts.js';
const plan = '11111111-1111-4111-8111-111111111111';
const transaction = (id: string, extra: JsonObject = {}): JsonObject => ({ id, account_id: plan, account_name: 'Fixture', date: '2024-02-29', approved: false, deleted: false, cleared: 'uncleared', amount: 1, subtransactions: [], ...extra });
const config: Config = { defaultPlanId: plan, allowedPlanIds: [plan], readOnly: false, allowDeletes: true, allowImports: true, allowReconciledChanges: false, toolProfile: 'extended', timeoutMs: 60000, cacheTtlSeconds: 30, logLevel: 'error' };
function setup(name = 'ynab_update_transaction', patch: Partial<Config> = {}) {
  let now = Date.UTC(2024, 1, 29, 23, 59);
  const requests: ApiRequest[] = [];
  const rows: Record<string, JsonObject> = { a: transaction('a') };
  let mutationError: unknown;
  const state = createSafetyState({ ...config, ...patch }, { async request(_ctx, req) {
    requests.push(req);
    if (req.method !== 'GET') { if (mutationError) throw mutationError; return { data: { transaction: rows.a!, server_knowledge: 1 }, fetchedAt: new Date(now).toISOString() }; }
    const id = req.path.split('/').at(-1)!;
    if (!rows[id]) throw new Error('missing fixture');
    return { data: { transaction: structuredClone(rows[id]!), server_knowledge: 1 }, fetchedAt: new Date(now).toISOString() };
  } }, { now: () => now });
  const ctx: CallContext = { tool: catalog.find(t => t.name === name)!, requestId: 'r1', planId: plan, startedAtMs: now, deadlineMs: now + 60000, signal: new AbortController().signal };
  const prepared: PreparedWrite = { method: 'PUT', path: `/plans/${plan}/transactions/a`, body: { transaction: { memo: 'new' } }, warnings: [], unknownEffects: false, setsReconciled: false, usesImportId: false };
  const spec: WriteSpec = { targets: [{ ref: { kind: 'transaction', id: 'a' } }], async prepare() { return prepared; }, async verify() { return { data: { transaction: rows.a! }, warnings: [] }; } };
  return { state, ctx, rows, requests, spec, prepared, advance: (ms: number) => { now += ms; }, failMutation: (e: unknown) => { mutationError = e; } };
}
describe('UTC dates', () => {
  it('validates leap days, months and boundaries without local time', () => {
    expect(() => assertCalendarDate('2023-02-29')).toThrow();
    expect(() => assertCalendarDate('2024-02-29')).not.toThrow();
    expect(() => assertCalendarDate('2024-2-01')).toThrow();
    expect(resolveReadMonth('current', Date.UTC(2024, 1, 29, 23, 59))).toBe('2024-02-01');
    expect(() => resolveReadMonth('2024-02-02', 0)).toThrow();
    expect(oneYearAgo(Date.UTC(2024, 1, 29))).toBe('2023-02-28');
    expect(() => assertTransactionDate('2024-03-01', Date.UTC(2024, 1, 29))).toThrow();
    expect(() => assertScheduledDate('2024-02-29', Date.UTC(2024, 1, 29))).toThrow();
    expect(() => assertScheduledDate('2029-03-01', Date.UTC(2024, 1, 29))).toThrow();
  });
});
describe('policy and inspection', () => {
  it('gates discovery and direct calls, requires explicit allowed UUID plans', async () => {
    const { state, ctx } = setup('ynab_update_transaction', { readOnly: true });
    expect(state.available(ctx.tool)).toBe(false);
    expect(() => state.assertAvailable(ctx.tool)).toThrow();
    await expect(state.get(ctx, `/plans/${plan}/transactions/a`)).rejects.toThrow();
    expect(() => state.resolvePlan('last-used')).toThrow();
    expect(() => state.resolvePlan('22222222-2222-4222-8222-222222222222')).toThrow();
    expect(state.resolvePlan()).toBe(plan);
  });
  it('caches clones but bypasses fresh inspections and invalidates', async () => {
    const { state, ctx, requests } = setup();
    const path = `/plans/${plan}/transactions/a`;
    const first = await state.get(ctx, path, { b: 2, a: 1 }); first.data.transaction = null;
    expect((await state.get(ctx, path, { a: 1, b: 2 })).cacheHit).toBe(true);
    expect(requests).toHaveLength(1);
    await state.inspect(ctx, { kind: 'transaction', id: 'a' });
    expect(requests).toHaveLength(2);
    state.invalidatePlan(plan); await state.get(ctx, path, { a: 1, b: 2 }); expect(requests).toHaveLength(3);
    await expect(state.get(ctx, `/plans/${plan}/../user`)).rejects.toThrow();
  });
  it('traverses complete counterpart cycles and split children, hashes non-display fields', async () => {
    const { state, ctx, rows, requests } = setup();
    rows.a!.subtransactions = [{ id: 's', transaction_id: 'a', amount: 1, deleted: false, transfer_transaction_id: 'b' }];
    rows.b = transaction('b', { transfer_transaction_id: 'a', cleared: 'reconciled' });
    const current = await state.inspect(ctx, { kind: 'transaction', id: 'a' });
    expect(current.counterparts.map(x => x.id)).toEqual(['b']); expect(requests).toHaveLength(2);
    expect(state.revision(ctx, current.ref, { ...current.entity, amount_formatted: 'display' }, current.counterparts)).toBe(current.revision);
    expect(state.revision(ctx, current.ref, current.entity, [{ ...rows.b, amount: 2 }])).not.toBe(current.revision);
  });
});
describe('write lifecycle', () => {
  it('preview preserves frozen schema and executes no mutation; live requires revision', async () => {
    const { state, ctx, spec, requests } = setup();
    const result = await state.write(ctx, {}, spec);
    expect(result.status).toBe('preview');
    if (result.status === 'preview') expect(Object.keys(result.preview).sort()).toEqual(['affected_ids','before','body','expected_revisions','method','path','unknown_effects','validated','warnings']);
    expect(requests.every(x => x.method === 'GET')).toBe(true);
    await expect(state.write(ctx, { dry_run: false }, spec)).rejects.toThrow();
  });
  it('detects changes during prepare, protects reconciled graphs and overlaps', async () => {
    const { state, ctx, spec, rows, requests } = setup();
    const before = await state.inspect(ctx, spec.targets[0]!.ref);
    const targets = [{ ...spec.targets[0]!, expectedRevision: before.revision }];
    await expect(state.write(ctx, { dry_run: false }, { ...spec, targets, async prepare() { rows.a!.amount = 2; return spec.prepare([]); } })).rejects.toThrow();
    expect(requests.every(x => x.method === 'GET')).toBe(true);
    rows.a!.transfer_transaction_id = 'b'; rows.b = transaction('b', { cleared: 'reconciled', transfer_transaction_id: 'a' });
    await expect(state.write(ctx, {}, spec)).rejects.toThrow();
    rows.b.cleared = 'uncleared';
    await expect(state.write(ctx, {}, { ...spec, targets: [...spec.targets, { ref: { kind: 'transaction', id: 'b' } }] })).rejects.toThrow();
  });
  it('rejects catalog endpoint mismatches, deletion confirmation and reconciled/import flags even for previews', async () => {
    const { state, ctx, spec, prepared } = setup();
    for (const p of [{ ...prepared, path: `/plans/${plan}/payees` }, { ...prepared, setsReconciled: true }]) {
      await expect(state.write(ctx, {}, { ...spec, async prepare() { return p; } })).rejects.toThrow();
    }
    const noImports = setup(undefined, { allowImports: false });
    await expect(noImports.state.write(noImports.ctx, {}, { ...noImports.spec, async prepare() { return { ...noImports.prepared, usesImportId: true }; } })).rejects.toThrow();
    const del = setup('ynab_delete_transaction');
    await expect(del.state.write(del.ctx, {}, del.spec)).rejects.toThrow();
  });
  it('submits once and reports applied verification failure or unknown without retry', async () => {
    const { state, ctx, spec, requests, failMutation } = setup();
    const before = await state.inspect(ctx, spec.targets[0]!.ref);
    const live = { ...spec, targets: [{ ...spec.targets[0]!, expectedRevision: before.revision }], async verify() { throw new Error('private'); } };
    const applied = await state.write(ctx, { dry_run: false }, live);
    expect(applied.status === 'error' && applied.error.outcome).toBe('applied');
    failMutation(new Error('private')); const unknown = await state.write(ctx, { dry_run: false }, live);
    expect(unknown.status === 'error' && unknown.error.outcome).toBe('unknown');
    expect(requests.filter(x => x.method !== 'GET')).toHaveLength(2);
    expect(JSON.stringify(unknown)).not.toContain('private');
  });
  it('serializes per-plan preview preparation', async () => {
    const { state, ctx, spec } = setup(); let active = 0; let max = 0;
    const locked = { ...spec, async prepare() { active++; max = Math.max(max, active); await new Promise(r => setTimeout(r, 5)); active--; return spec.prepare([]); } };
    await Promise.all([state.write(ctx, {}, locked), state.write(ctx, {}, locked)]); expect(max).toBe(1);
  });
});
describe('frozen paging', () => {
  function paging() {
    const f = setup('ynab_list_transactions'); let calls = 0;
    const fetch = async (): Promise<OkResult> => { calls++; return { status: 'ok' as const, data: { transactions: [{ id: 'a', subtransactions: [{ id: 's' }] }, { id: 'b', deleted: true }] }, meta: { ...f.state.meta(f.ctx), resolved_month: '2024-02-01' } }; };
    return { ...f, fetch, calls: () => calls };
  }
  it('preserves children, tombstones, frozen dates and source time across midnight', async () => {
    const f = paging(); const first = await f.state.page(f.ctx, { page_size: 1 }, 'transactions', f.fetch);
    f.advance(120000);
    const next = await f.state.page({ ...f.ctx, requestId: 'r2' }, { page_size: 1, cursor: first.meta.next_cursor! }, 'transactions', f.fetch);
    expect(f.calls()).toBe(1); expect(next.meta.fetched_at).toBe(first.meta.fetched_at); expect(next.meta.request_id).toBe('r2');
    expect(next.data.transactions).toEqual([{ id: 'b', deleted: true }]); expect(first.data.transactions).toEqual([{ id: 'a', subtransactions: [{ id: 's' }] }]);
    expect(next.meta.complete).toBe(true); expect(next.meta.resolved_month).toBe('2024-02-01');
  });
  it('rejects selector mismatch, expiry, invalidation and invalid page sizes before fetching', async () => {
    const f = paging(); const first = await f.state.page(f.ctx, { page_size: 1 }, 'transactions', f.fetch);
    await expect(f.state.page(f.ctx, { page_size: 2, cursor: first.meta.next_cursor! }, 'transactions', f.fetch)).rejects.toThrow();
    f.advance(300000); await expect(f.state.page(f.ctx, { page_size: 1, cursor: first.meta.next_cursor! }, 'transactions', f.fetch)).rejects.toThrow();
    await expect(f.state.page(f.ctx, { page_size: 0 }, 'transactions', f.fetch)).rejects.toThrow(); expect(f.calls()).toBe(1);
    const second = await f.state.page(f.ctx, { page_size: 1 }, 'transactions', f.fetch); f.state.invalidatePlan(plan);
    await expect(f.state.page(f.ctx, { page_size: 1, cursor: second.meta.next_cursor! }, 'transactions', f.fetch)).rejects.toThrow();
  });
  it('shortens at whole row boundaries, rejects oversized rows and accepts empty collections', async () => {
    const f = paging(); const fetch = async () => ({ status: 'ok' as const, data: { transactions: [{ id: 'a', memo: 'x'.repeat(300000) }, { id: 'b', memo: 'x'.repeat(300000) }] }, meta: f.state.meta(f.ctx) });
    const first = await f.state.page(f.ctx, {}, 'transactions', fetch); expect(first.meta.returned_count).toBe(1); expect(first.meta.complete).toBe(false);
    await expect(f.state.page(f.ctx, {}, 'transactions', async () => ({ status: 'ok', data: { transactions: [{ memo: 'x'.repeat(530000) }] }, meta: f.state.meta(f.ctx) }))).rejects.toThrow();
    expect((await f.state.page(f.ctx, {}, 'transactions', async () => ({ status: 'ok', data: { transactions: [] }, meta: f.state.meta(f.ctx) }))).meta.returned_count).toBe(0);
  });
});

describe('additional safety boundaries', () => {
  it('independently projects canonical hashes, normalizes nulls and sorts children only for hashing', async () => {
    const { createHash } = await import('node:crypto'); const f = setup();
    const ref = { kind: 'payee' as const, id: plan };
    // Literal canonical JSON fixture: no production canonicalizer computes the expectation.
    const canonical = `{"counterparts":[],"entity":{"deleted":false,"id":"${plan}","name":"Fixture","transfer_account_id":null},"id":"${plan}","kind":"payee","month":null,"plan_id":"${plan}"}`;
    const expected = `sha256:${createHash('sha256').update(canonical).digest('hex')}`;
    expect(f.state.revision(f.ctx, ref, { id: plan, name: 'Fixture', deleted: false, ignored: 1 })).toBe(expected);
    expect(f.state.revision(f.ctx, ref, { id: plan, name: 'Fixture', deleted: false, transfer_account_id: null })).toBe(expected);
    const tr = { kind: 'transaction' as const, id: 'a' }; const children = [{ id: 'z', transaction_id: 'a', amount: 1, deleted: false }, { id: 's', transaction_id: 'a', amount: 2, deleted: false }];
    expect(f.state.revision(f.ctx, tr, { ...f.rows.a!, subtransactions: children })).toBe(f.state.revision(f.ctx, tr, { ...f.rows.a!, subtransactions: [...children].reverse() }));
    expect(children[0]!.id).toBe('z');
    const category = { kind: 'category' as const, id: plan };
    const base = { id: plan, goal_target: 1 };
    expect(f.state.revision(f.ctx, category, base)).toBe(f.state.revision(f.ctx, category, { ...base, goal_percentage_complete: 50, balance: 99 }));
    expect(f.state.revision(f.ctx, category, base)).not.toBe(f.state.revision(f.ctx, category, { ...base, goal_cadence: 2 }));
    expect(f.state.revision(f.ctx, { kind: 'category_assignment', id: plan, month: '2024-02-01' }, base)).not.toBe(f.state.revision(f.ctx, { kind: 'category_assignment', id: plan, month: '2024-03-01' }, base));
  });
  it('uses exact non-delta group and month-category routes', async () => {
    const requests: ApiRequest[] = []; const f = setup('ynab_update_category_group');
    const category = { id: plan, category_group_id: plan, category_group_name: 'Fixture', name: 'Fixture', hidden: false, internal: false, original_category_group_id: null, note: null, budgeted: 1, activity: 2, balance: 3, deleted: false };
    const group = { id: plan, name: 'Fixture', hidden: false, internal: false, deleted: false, categories: [category] };
    const state = createSafetyState(config, { async request(_ctx, req): Promise<ApiReply> { requests.push(req); return { data: req.path.endsWith('/categories') ? { category_groups: [group], server_knowledge: 1 } : { category, server_knowledge: 1 }, fetchedAt: '2024-02-29T00:00:00Z' }; } }, { now: () => Date.UTC(2024, 1, 29) });
    const a = await state.inspect(f.ctx, { kind: 'category_group', id: plan });
    const b = await state.inspect(f.ctx, { kind: 'category_assignment', id: plan, month: '2024-02-01' });
    expect(requests).toEqual([{ method: 'GET', path: `/plans/${plan}/categories` }, { method: 'GET', path: `/plans/${plan}/months/2024-02-01/categories/${plan}` }]);
    expect(a.entity).toEqual(group); expect(b.revisionKey).toBe(`category:${plan}:2024-02-01`);
  });
  it('rejects partial details and inaccessible counterparts before preparing', async () => {
    const f = setup(); delete f.rows.a!.subtransactions; let prepares = 0;
    await expect(f.state.write(f.ctx, {}, { ...f.spec, async prepare() { prepares++; return f.prepared; } })).rejects.toThrow(); expect(prepares).toBe(0);
    f.rows.a!.subtransactions = []; f.rows.a!.transfer_transaction_id = 'missing';
    await expect(f.state.write(f.ctx, {}, f.spec)).rejects.toThrow(); expect(f.requests.every(x => x.method === 'GET')).toBe(true);
  });
  it('allows enabled reconciled, delete and import policies, verifies once, and invalidates on success', async () => {
    const f = setup('ynab_delete_transaction', { allowReconciledChanges: true }); f.rows.a!.cleared = 'reconciled';
    const current = await f.state.inspect(f.ctx, f.spec.targets[0]!.ref);
    let verifies = 0;
    const spec = { ...f.spec, targets: [{ ...f.spec.targets[0]!, expectedRevision: current.revision }], async prepare() { return { ...f.prepared, method: 'DELETE' as const, body: null }; }, async verify() { verifies++; return { data: { transaction: f.rows.a!, server_knowledge: 1 }, warnings: ['verified'], revisions: { 'transaction:a': 'observed' }, fetchedAt: '2024-03-01T00:00:00Z' }; } };
    await f.state.get(f.ctx, f.prepared.path);
    const preview = await f.state.write(f.ctx, { confirm_delete: true }, spec); expect(preview.status).toBe('preview');
    const ok = await f.state.write(f.ctx, { confirm_delete: true, dry_run: false }, spec);
    expect(ok.status).toBe('ok'); expect(ok.meta.fetched_at).toBe('2024-03-01T00:00:00Z'); expect(ok.meta.revisions).toEqual({ 'transaction:a': 'observed' }); expect(verifies).toBe(1);
    expect((await f.state.get(f.ctx, f.prepared.path)).cacheHit).toBe(false); expect(f.requests.filter(x => x.method === 'DELETE')).toHaveLength(1);
  });
  it('invalidates cursors and GETs on unknown and known-not-applied submitted mutations', async () => {
    const { ToolFailure } = await import('../../src/errors.js'); const f = setup();
    const pageCtx = { ...f.ctx, tool: catalog.find(t => t.name === 'ynab_list_transactions')! };
    const revision = (await f.state.inspect(f.ctx, f.spec.targets[0]!.ref)).revision;
    for (const failure of [new Error('private'), new ToolFailure({ code: 'validation_error', message: 'Rejected', retryable: false, outcome: 'not_applied' })]) {
      await f.state.get(f.ctx, f.prepared.path);
      const first = await f.state.page(pageCtx, { page_size: 1 }, 'transactions', async () => ({ status: 'ok', data: { transactions: [{ id: 'a' }, { id: 'b' }] }, meta: f.state.meta(pageCtx) }));
      f.failMutation(failure); await f.state.write(f.ctx, { dry_run: false }, { ...f.spec, targets: [{ ...f.spec.targets[0]!, expectedRevision: revision }] });
      expect((await f.state.get(f.ctx, f.prepared.path)).cacheHit).toBe(false);
      await expect(f.state.page(pageCtx, { page_size: 1, cursor: first.meta.next_cursor! }, 'transactions', async () => { throw new Error('must not fetch'); })).rejects.toThrow();
    }
  });
  it('gates extended, import, delete tools and unconfigured plans independently', () => {
    for (const [name, policy] of [['ynab_create_account', { toolProfile: 'core' }], ['ynab_import_transactions', { allowImports: false }], ['ynab_delete_transaction', { allowDeletes: false }]] as const) {
      const f = setup(name, policy); expect(f.state.available(f.ctx.tool)).toBe(false); expect(() => f.state.assertAvailable(f.ctx.tool)).toThrow();
    }
    const state = createSafetyState({ ...config, defaultPlanId: undefined }, { async request() { throw new Error('no reads'); } }); expect(() => state.resolvePlan()).toThrow();
  });
  it('uses a shared oldest-first 64MiB budget for snapshots and GET payloads', async () => {
    const f = setup('ynab_list_transactions'); let reads = 0;
    const state = createSafetyState(config, { async request() { reads++; return { data: { payload: 'x'.repeat(7 * 1024 * 1024) }, fetchedAt: '2024-02-29T00:00:00Z' }; } }, { now: () => Date.UTC(2024, 1, 29) });
    const first = await state.page(f.ctx, { page_size: 1 }, 'transactions', async () => ({ status: 'ok', data: { transactions: [{ id: 'a' }, { id: 'b' }] }, meta: state.meta(f.ctx) }));
    for (let i = 0; i < 10; i++) await state.get(f.ctx, `/plans/${plan}/transactions/id-${i}`);
    await expect(state.page(f.ctx, { page_size: 1, cursor: first.meta.next_cursor! }, 'transactions', async () => { throw new Error('must not restart'); })).rejects.toThrow();
    await state.get(f.ctx, `/plans/${plan}/transactions/id-0`); expect(reads).toBe(11);
  });
  it('does not cache a concurrent read begun before mutation invalidation', async () => {
    const f = setup(); let release!: () => void; let reads = 0;
    const wait = new Promise<void>(r => { release = r; });
    const state = createSafetyState(config, { async request() { reads++; if (reads === 1) await wait; return { data: { transaction: transaction('a') }, fetchedAt: '2024-02-29T00:00:00Z' }; } }, { now: () => Date.UTC(2024, 1, 29) });
    const pending = state.get(f.ctx, f.prepared.path); state.invalidatePlan(plan); release(); await pending;
    expect((await state.get(f.ctx, f.prepared.path)).cacheHit).toBe(false); expect(reads).toBe(2);
  });
});

describe('final lifecycle and cursor regressions', () => {
  it('holds the plan lock through verification and releases after failed preparation', async () => {
    const f = setup(); const rev = (await f.state.inspect(f.ctx, f.spec.targets[0]!.ref)).revision;
    const targets = [{ ...f.spec.targets[0]!, expectedRevision: rev }]; const events: string[] = [];
    let release!: () => void; let entered!: () => void;
    const waiting = new Promise<void>(r => { release = r; }); const started = new Promise<void>(r => { entered = r; });
    const first = f.state.write(f.ctx, { dry_run: false }, { ...f.spec, targets, async verify() { events.push('verify'); entered(); await waiting; events.push('verified'); return { data: {}, warnings: [] }; } });
    await started;
    const second = f.state.write(f.ctx, {}, { ...f.spec, async prepare() { events.push('prepare2'); return f.prepared; } });
    await new Promise(r => setTimeout(r, 5)); expect(events).toEqual(['verify']); release(); await Promise.all([first, second]); expect(events).toEqual(['verify', 'verified', 'prepare2']);
    await expect(f.state.write(f.ctx, {}, { ...f.spec, async prepare() { throw new Error('bad'); } })).rejects.toThrow();
    expect((await f.state.write(f.ctx, {}, f.spec)).status).toBe('preview');
  });
  it('binds cursors to state, plan, tool and selectors, with per-page revision metadata', async () => {
    const f = setup('ynab_list_categories'); const args = { page_size: 1, last_knowledge_of_server: 0 };
    const first = await f.state.page(f.ctx, args, 'category_groups', async () => ({ status: 'ok', data: { category_groups: [{ id: 'a', categories: [{ id: 'nested' }] }, { id: 'b', categories: [] }] }, meta: { ...f.state.meta(f.ctx), revisions: { 'category_group:a': 'ra', 'category_group:b': 'rb' } } }));
    expect(first.meta.revisions).toEqual({ 'category_group:a': 'ra' });
    const next = await f.state.page(f.ctx, { ...args, cursor: first.meta.next_cursor! }, 'category_groups', async () => { throw new Error('no refetch'); }); expect(next.meta.revisions).toEqual({ 'category_group:b': 'rb' });
    const other = setup('ynab_list_categories');
    await expect(other.state.page(other.ctx, { ...args, cursor: first.meta.next_cursor! }, 'category_groups', async () => { throw new Error('no refetch'); })).rejects.toThrow();
    await expect(f.state.page(f.ctx, { ...args, last_knowledge_of_server: 1, cursor: first.meta.next_cursor! }, 'category_groups', async () => { throw new Error('no refetch'); })).rejects.toThrow();
  });
  it('rejects stale previews as well as live writes and preserves unknown import effects', async () => {
    const f = setup();
    await expect(f.state.write(f.ctx, {}, { ...f.spec, targets: [{ ...f.spec.targets[0]!, expectedRevision: 'stale' }] })).rejects.toThrow();
    const imp = setup('ynab_import_transactions');
    const preview = await imp.state.write(imp.ctx, {}, { ...imp.spec, targets: [], async prepare() { return { ...imp.prepared, method: 'POST', path: `/plans/${plan}/transactions/import`, body: null, unknownEffects: true }; } });
    expect(preview.status === 'preview' && preview.preview.unknown_effects).toBe(true); expect(imp.requests).toHaveLength(0);
  });
  it('dates reject year zero, impossible leap dates, and accept inclusive UTC five-year limit', () => {
    for (const value of ['0000-01-01', '2024-04-31', '2024-01-00', '2024-13-01', '2024-01-01T00:00:00Z']) expect(() => assertCalendarDate(value)).toThrow();
    expect(() => assertCalendarDate('0099-01-01')).not.toThrow();
    expect(() => assertScheduledDate('2029-02-28', Date.UTC(2024, 1, 29))).not.toThrow();
    expect(() => assertTransactionDate('2024-02-29', Date.UTC(2024, 1, 29, 23, 59))).not.toThrow();
    expect(oneYearAgo(Date.UTC(2025, 1, 28))).toBe('2024-02-28');
  });
});

describe('canonical and acknowledgment hardening', () => {
  it('never hashes transaction list rows or alias assignment months as writable detail revisions', () => {
    const f = setup(); const partial = { ...f.rows.a! }; delete partial.subtransactions;
    expect(() => f.state.revision(f.ctx, { kind: 'transaction', id: 'a' }, partial)).toThrow();
    expect(() => f.state.revision(f.ctx, { kind: 'category_assignment', id: plan, month: 'current' }, {})).toThrow();
  });
  it('preserves known applied outcomes raised at the API boundary', async () => {
    const { ToolFailure } = await import('../../src/errors.js'); const f = setup();
    const current = await f.state.inspect(f.ctx, f.spec.targets[0]!.ref);
    f.failMutation(new ToolFailure({ code: 'verification_failed', message: 'Acknowledged', retryable: false, outcome: 'applied', details: { acknowledged_ids: ['a'] } }));
    const result = await f.state.write(f.ctx, { dry_run: false }, { ...f.spec, targets: [{ ...f.spec.targets[0]!, expectedRevision: current.revision }] });
    expect(result.status === 'error' && result.error.outcome).toBe('applied');
  });
});

it('validates original page selectors before fetching', async () => {
  const f = setup('ynab_list_transactions'); let fetched = false;
  await expect(f.state.page(f.ctx, { since_date: '2023-02-29' }, 'transactions', async () => { fetched = true; return { status: 'ok', data: { transactions: [] }, meta: f.state.meta(f.ctx) }; })).rejects.toThrow();
  expect(fetched).toBe(false);
});
