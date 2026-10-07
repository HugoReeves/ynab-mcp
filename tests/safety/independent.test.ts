import { describe, expect, it } from 'vitest';
import { catalog, outputValidators } from '../../src/catalog.js';
import type { ApiRequest, CallContext, Config, JsonObject, OkResult, PreparedWrite, WriteSpec } from '../../src/contracts.js';
import { createSafetyState } from '../../src/safety/index.js';

const plan = '11111111-1111-4111-8111-111111111111';
const otherPlan = '22222222-2222-4222-8222-222222222222';
const config: Config = { allowedPlanIds: null, readOnly: false, allowDeletes: true, allowImports: false, allowReconciledChanges: false, toolProfile: 'extended', timeoutMs: 60000, cacheTtlSeconds: 30, logLevel: 'error' };
const row = (id: string, extra: JsonObject = {}): JsonObject => ({ id, account_id: plan, account_name: 'Offline account', date: '2024-02-29', amount: -100, cleared: 'uncleared', approved: false, deleted: false, subtransactions: [], ...extra });
function fixture() {
  let now = Date.UTC(2024, 1, 29, 23, 59, 59);
  const requests: ApiRequest[] = [];
  const rows: Record<string, JsonObject> = {
    a: row('a', { subtransactions: [{ id: 'child-a', transaction_id: 'a', amount: -100, deleted: false, transfer_transaction_id: 'b' }] }),
    b: row('b', { transfer_transaction_id: 'a', subtransactions: [{ id: 'child-b', transaction_id: 'b', amount: -100, deleted: false, transfer_transaction_id: 'c' }] }),
    c: row('c', { transfer_transaction_id: 'b' }),
  };
  const state = createSafetyState(config, { async request(_ctx, request) {
    requests.push(request);
    const entity = rows[request.path.split('/').at(-1)!];
    if (!entity) throw new Error('Missing offline fixture');
    return { data: { transaction: structuredClone(entity), server_knowledge: 5 }, fetchedAt: new Date(now).toISOString() };
  } }, { now: () => now });
  const ctx: CallContext = { tool: catalog.find(t => t.name === 'ynab_update_transaction')!, requestId: 'independent-1', planId: plan, startedAtMs: now, deadlineMs: now + 60000, signal: new AbortController().signal };
  const prepared: PreparedWrite = { method: 'PUT', path: `/plans/${plan}/transactions/a`, body: { transaction: { memo: 'offline' } }, warnings: [], unknownEffects: false, setsReconciled: false, usesImportId: false };
  const spec: WriteSpec = { targets: [{ ref: { kind: 'transaction', id: 'a' } }], async prepare() { return prepared; }, async verify(reply) { return { data: reply.data, warnings: [] }; } };
  return { state, rows, requests, ctx, prepared, spec, advance(ms: number) { now += ms; } };
}

describe('independent adversarial safety verification', () => {
  it('rejects a reconciled second-hop split counterpart before preparation', async () => {
    const f = fixture(); f.rows.c!.cleared = 'reconciled'; let prepared = false;
    await expect(f.state.write(f.ctx, {}, { ...f.spec, async prepare() { prepared = true; return f.prepared; } })).rejects.toMatchObject({ error: { code: 'permission_denied', outcome: 'not_applied' } });
    expect(prepared).toBe(false);
    expect(f.requests.map(r => r.path.split('/').at(-1))).toEqual(['a', 'b', 'c']);
    expect(f.requests.every(r => r.method === 'GET')).toBe(true);
  });

  it('returns a catalog-valid preview containing the full cyclic split graph', async () => {
    const f = fixture(); const result = await f.state.write(f.ctx, {}, f.spec);
    const validator = outputValidators.get(f.ctx.tool.name)!;
    expect(validator(result), JSON.stringify(validator.errors)).toBe(true);
    expect(result.status).toBe('preview');
    if (result.status !== 'preview') throw new Error('Expected preview');
    expect(result.preview.affected_ids).toEqual(['a', 'b', 'c']);
    expect(result.preview.before).toEqual([f.rows.a, f.rows.b, f.rows.c]);
    expect(f.requests).toHaveLength(3);
    expect(f.requests.every(r => r.method === 'GET')).toBe(true);
  });

  it('detects a counterpart reconciliation during preparation without submitting', async () => {
    const f = fixture(); const initial = await f.state.inspect(f.ctx, f.spec.targets[0]!.ref);
    await expect(f.state.write(f.ctx, { dry_run: false }, { ...f.spec, targets: [{ ref: initial.ref, expectedRevision: initial.revision }], async prepare() { f.rows.c!.cleared = 'reconciled'; return f.prepared; } })).rejects.toMatchObject({ error: { code: 'conflict', outcome: 'not_applied' } });
    expect(f.requests.every(r => r.method === 'GET')).toBe(true);
  });

  it('rejects overlapping indirect graphs even when the explicit target IDs differ', async () => {
    const f = fixture();
    await expect(f.state.write(f.ctx, {}, { ...f.spec, targets: [...f.spec.targets, { ref: { kind: 'transaction', id: 'c' } }] })).rejects.toMatchObject({ error: { code: 'conflict' } });
    expect(f.requests.every(r => r.method === 'GET')).toBe(true);
  });

  it('rejects missing graph detail rather than preparing a partial preview', async () => {
    const f = fixture(); delete f.rows.c!.subtransactions;
    await expect(f.state.write(f.ctx, {}, f.spec)).rejects.toMatchObject({ error: { code: 'upstream_error' } });
    expect(f.requests.every(r => r.method === 'GET')).toBe(true);
  });

  it('rejects cross-plan reads and prepared writes even with an unrestricted allowlist', async () => {
    const f = fixture();
    await expect(f.state.get(f.ctx, `/plans/${otherPlan}/transactions/a`)).rejects.toMatchObject({ error: { code: 'permission_denied' } });
    expect(f.requests).toHaveLength(0);
    await expect(f.state.write(f.ctx, {}, { ...f.spec, async prepare() { return { ...f.prepared, path: `/plans/${otherPlan}/transactions/a` }; } })).rejects.toMatchObject({ error: { code: 'permission_denied' } });
    expect(f.requests.every(r => r.method === 'GET')).toBe(true);
  });

  it('keeps a schema-valid frozen snapshot across UTC midnight and invalidates it after a write', async () => {
    const f = fixture();
    const pageCtx = { ...f.ctx, tool: catalog.find(t => t.name === 'ynab_list_transactions')! };
    const args = { page_size: 1 };
    const fetch = async (): Promise<OkResult> => ({ status: 'ok', data: { transactions: [f.rows.a!, f.rows.b!], server_knowledge: 5 }, meta: { ...f.state.meta(pageCtx), resolved_since_date: '2023-02-28', resolved_until_date: '2024-02-29' } });
    const first = await f.state.page(pageCtx, args, 'transactions', fetch);
    f.rows.b!.memo = 'changed after snapshot'; f.advance(2000);
    const next = await f.state.page({ ...pageCtx, requestId: 'independent-2' }, { ...args, cursor: first.meta.next_cursor! }, 'transactions', async () => { throw new Error('Continuation must not fetch'); });
    expect(outputValidators.get(pageCtx.tool.name)!(first)).toBe(true);
    expect(outputValidators.get(pageCtx.tool.name)!(next)).toBe(true);
    expect((next.data.transactions as JsonObject[])[0]!.memo).toBeUndefined();
    expect(next.meta).toMatchObject({ request_id: 'independent-2', fetched_at: first.meta.fetched_at, resolved_until_date: '2024-02-29', complete: true });
    await f.state.get(f.ctx, f.prepared.path);
    const initial = await f.state.inspect(f.ctx, f.spec.targets[0]!.ref);
    const result = await f.state.write(f.ctx, { dry_run: false }, { ...f.spec, targets: [{ ref: initial.ref, expectedRevision: initial.revision }] });
    expect(result.status).toBe('ok');
    expect(f.requests.filter(r => r.method === 'PUT')).toHaveLength(1);
    expect((await f.state.get(f.ctx, f.prepared.path)).cacheHit).toBe(false);
    await expect(f.state.page(pageCtx, { ...args, cursor: first.meta.next_cursor! }, 'transactions', fetch)).rejects.toMatchObject({ error: { code: 'cursor_invalid' } });
  });
});
