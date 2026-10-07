import { createHash, randomUUID } from 'node:crypto';
import type { CachedReply, CallContext, Clock, Config, EntityRef, ErrorCode, Inspection, Json, JsonObject, Meta, OkResult, SafetyState, ToolDefinition, ToolResult, YnabApi } from '../contracts.js';
import { ToolFailure } from '../errors.js';
import { inputValidators, outputValidators } from '../catalog.js';
import { resolveReadMonth } from './dates.js';
const BUDGET = 64 * 1024 * 1024;
const PAGE_LIMIT = 512 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function fail(code: ErrorCode, message: string): never { throw new ToolFailure({ code, message, retryable: false, outcome: 'not_applied' }); }
function segment(value: string): string {
  if (!value || /[/\\?#%\s\x00-\x1f\x7f]/.test(value) || value === '.' || value === '..') fail('validation_error', 'Unsafe path segment.');
  return encodeURIComponent(value);
}
function object(value: Json | undefined): value is JsonObject { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function canonical(value: Json): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (object(value)) return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k]!)}`).join(',')}}`;
  return JSON.stringify(value);
}
function compareIds(a: Json, b: Json): number { const left = String((a as JsonObject).id); const right = String((b as JsonObject).id); return left < right ? -1 : left > right ? 1 : 0; }
function bytes(value: unknown): number { return Buffer.byteLength(JSON.stringify(value), 'utf8'); }
const projections: Partial<Record<EntityRef['kind'], readonly string[]>> = {
  payee: ['id', 'name', 'transfer_account_id', 'deleted'],
  category_group: ['id', 'name', 'hidden', 'internal', 'deleted'],
  category_assignment: ['id', 'budgeted', 'activity', 'balance', 'hidden', 'internal', 'deleted'],
  category: ['id', 'name', 'note', 'category_group_id', 'hidden', 'internal', 'deleted', 'goal_type', 'goal_target', 'goal_target_date', 'goal_needs_whole_amount', 'goal_day', 'goal_cadence', 'goal_cadence_frequency', 'goal_creation_month', 'goal_snoozed_at'],
};
const nullable = ['memo', 'flag_color', 'flag_name', 'payee_id', 'category_id', 'transfer_account_id', 'payee_name', 'category_name'];
function detailProjection(entity: JsonObject): JsonObject {
  const project = (value: Json): Json => {
    if (Array.isArray(value)) {
      const result = value.map(project);
      if (result.every(v => object(v) && typeof v.id === 'string')) result.sort(compareIds);
      return result;
    }
    if (!object(value)) return value;
    const result: JsonObject = {};
    for (const [key, v] of Object.entries(value)) if (!key.endsWith('_formatted') && !key.endsWith('_currency')) result[key] = project(v);
    // Documented nullable fields have identical absent/null semantics.
    if (typeof value.id === 'string') {
      const fields = 'subtransactions' in value ? nullable : ['memo', 'payee_id', 'payee_name', 'category_id', 'category_name', 'transfer_account_id', ...('transaction_id' in value ? ['transfer_transaction_id'] : [])];
      for (const key of fields) if (!(key in result)) result[key] = null;
    }
    if ('date' in value) for (const key of ['transfer_transaction_id', 'matched_transaction_id', 'import_id', 'import_payee_name', 'import_payee_name_original', 'debt_transaction_type']) if (!(key in result)) result[key] = null;
    return result;
  };
  return project(entity) as JsonObject;
}
interface Stored { bytes: number; expires: number; plan?: string; value: CachedReply | Snapshot }
interface Snapshot { binding: string; collection: string; result: OkResult; pageSize: number }
interface Cursor { key: string; offset: number }
export function createSafetyState(config: Config, api: YnabApi, clock: Clock = { now: Date.now }): SafetyState {
  const stored = new Map<string, Stored>(); const cursors = new Map<string, Cursor>(); const locks = new Map<string, Promise<void>>();
  const generations = new Map<string, number>();
  let globalGeneration = 0;
  const generation = (plan?: string): number => plan ? generations.get(plan) ?? 0 : globalGeneration;
  let used = 0;
  function remove(key: string): void { const item = stored.get(key); if (item) { used -= item.bytes; stored.delete(key); } for (const [token, cursor] of cursors) if (cursor.key === key) cursors.delete(token); }
  function prune(): void { for (const [key, entry] of stored) if (entry.expires <= clock.now()) remove(key); }
  function store(key: string, value: Stored['value'], expires: number, plan?: string): boolean {
    prune(); remove(key); const size = bytes(value); if (size > BUDGET) return false;
    while (used + size > BUDGET) remove(stored.keys().next().value!);
    stored.set(key, { bytes: size, expires, ...(plan ? { plan } : {}), value: structuredClone(value) }); used += size; return true;
  }
  function authorize(ctx: CallContext): void {
    state.assertAvailable(ctx.tool);
    if (ctx.planId !== undefined) state.resolvePlan(ctx.planId);
  }
  function pathCheck(ctx: CallContext, path: string): void {
    authorize(ctx);
    if ((path === '/user' || path === '/plans') && ctx.tool.upstream.some(r => r.method === 'GET' && r.path === path)) return;
    if (!ctx.planId) fail('plan_required', 'Select an explicit plan.');
    const parts = path.split('/');
    if (parts[0] !== '' || parts[1] !== 'plans' || parts[2] !== segment(ctx.planId) || parts.length < 4) fail('permission_denied', 'Request must remain inside the selected plan.');
    for (const part of parts.slice(3)) {
      let decoded: string; try { decoded = decodeURIComponent(part); } catch { fail('validation_error', 'Invalid path encoding.'); }
      if (segment(decoded) !== part) fail('validation_error', 'Invalid path encoding.');
    }
  }
  function scoped(ctx: CallContext, ...parts: string[]): string { if (!ctx.planId) fail('plan_required', 'Select an explicit plan.'); state.resolvePlan(ctx.planId); return `/plans/${segment(ctx.planId)}/${parts.map(segment).join('/')}`; }
  function keyOf(ref: EntityRef): string { return ref.kind === 'category_assignment' ? `category:${ref.id}:${ref.month}` : `${ref.kind}:${ref.id}`; }
  function ids(current: readonly Inspection[]): string[] { return [...new Set(current.flatMap(i => [i.entity, ...i.counterparts].map(e => String(e.id))))]; }
  function protect(current: readonly Inspection[]): void {
    const seen = new Set<string>();
    const reconciled = (v: Json): boolean => object(v) ? v.cleared === 'reconciled' || Object.values(v).some(reconciled) : Array.isArray(v) && v.some(reconciled);
    for (const item of current) {
      if (!config.allowReconciledChanges && item.ref.kind === 'transaction' && [item.entity, ...item.counterparts].some(reconciled)) fail('permission_denied', 'Reconciled transactions and counterparts are protected.');
      for (const entity of [item.entity, ...item.counterparts]) {
        const key = `${item.ref.kind}:${String(entity.id)}`;
        if (seen.has(key)) fail('conflict', 'Write target graphs overlap.'); seen.add(key);
      }
    }
  }
  function recovery(ctx: CallContext): string {
    const name = ctx.tool.name;
    if (name === 'ynab_update_scheduled_transaction' || name === 'ynab_delete_scheduled_transaction') return 'ynab_get_scheduled_transaction';
    if (name.includes('scheduled')) return 'ynab_list_scheduled_transactions';
    if (name === 'ynab_update_transaction' || name === 'ynab_delete_transaction') return 'ynab_get_transaction';
    if (name.includes('transaction')) return 'ynab_list_transactions';
    if (name === 'ynab_update_payee') return 'ynab_get_payee';
    if (name.includes('payee')) return 'ynab_list_payees';
    if (name === 'ynab_set_category_assignment' || name === 'ynab_update_category') return 'ynab_get_category';
    if (name.includes('account')) return 'ynab_list_accounts';
    return 'ynab_list_categories';
  }
  const state: SafetyState = {
    resolvePlan(explicit) {
      const plan = explicit ?? config.defaultPlanId;
      if (!plan) fail('plan_required', 'Select an explicit plan.');
      if (!UUID.test(plan)) fail('validation_error', 'Plan must be a UUID, not an alias.');
      if (config.allowedPlanIds !== null && !config.allowedPlanIds.includes(plan)) fail('permission_denied', 'Plan is not allowed.'); return plan;
    },
    available(tool: ToolDefinition) { return !(tool.profile === 'extended' && config.toolProfile !== 'extended') && !(tool.permissions.write && config.readOnly) && !(tool.permissions.delete && !config.allowDeletes) && !(tool.permissions.imports && !config.allowImports); },
    assertAvailable(tool) { if (!state.available(tool)) fail('permission_denied', 'Tool is not enabled by connection policy.'); },
    async get(ctx, path, query, bypassCache = false) {
      pathCheck(ctx, path); prune();
      if (ctx.signal.aborted || clock.now() >= ctx.deadlineMs) fail('timeout', 'Read deadline elapsed.');
      const epoch = generation(ctx.planId);
      const key = `get:${canonical({ plan: ctx.planId ?? null, path, query: query ? { ...query } : null })}`;
      const cached = stored.get(key);
      if (!bypassCache && cached) return { ...structuredClone(cached.value as CachedReply), cacheHit: true };
      const reply = await api.request(ctx, { method: 'GET', path, ...(query ? { query } : {}) });
      const result: CachedReply = { ...structuredClone(reply), cacheHit: false };
      if (!bypassCache && config.cacheTtlSeconds > 0 && epoch === generation(ctx.planId)) store(key, result, clock.now() + config.cacheTtlSeconds * 1000, ctx.planId);
      return result;
    },
    meta(ctx, source): Meta { return { request_id: ctx.requestId, fetched_at: source?.fetchedAt ?? new Date(clock.now()).toISOString(), warnings: [], ...(ctx.planId ? { plan_id: ctx.planId } : {}), ...(source ? { cache_hit: source.cacheHit } : {}), ...(source?.rateLimit ? { rate_limit: { ...source.rateLimit } } : {}) }; },
    revision(ctx, ref, entity, counterparts = []) {
      if (!ctx.planId) fail('plan_required', 'Revision requires plan context.'); state.resolvePlan(ctx.planId); segment(ref.id);
      if (ref.kind === 'category_assignment') { if (ref.month === 'current') fail('validation_error', 'Assignment revisions require an explicit month.'); resolveReadMonth(ref.month, clock.now()); }
      if (ref.kind === 'transaction' || ref.kind === 'scheduled_transaction') {
        const kind = ref.kind;
        const validateDetail = (detail: JsonObject): void => {
          if (!outputValidators.get(`ynab_get_${kind}`)!({ status: 'ok', data: { [kind]: detail, server_knowledge: 0 }, meta: state.meta(ctx) })) fail('upstream_error', 'Revisions require complete entity detail.');
        };
        validateDetail(entity); counterparts.forEach(validateDetail);
      }
      const fields = projections[ref.kind]; const projection: JsonObject = fields ? Object.fromEntries(fields.map(k => [k, entity[k] ?? null])) : detailProjection(entity);
      const payload: JsonObject = { plan_id: ctx.planId, kind: ref.kind, id: ref.id, month: ref.kind === 'category_assignment' ? ref.month : null, entity: projection, counterparts: counterparts.map(detailProjection).sort(compareIds) };
      return `sha256:${createHash('sha256').update(canonical(payload)).digest('hex')}`;
    },
    async inspect(ctx, ref) {
      authorize(ctx); segment(ref.id);
      let path: string; let field: string;
      switch (ref.kind) {
        case 'category_assignment': if (ref.month === 'current') fail('validation_error', 'Assignments require an explicit month.'); resolveReadMonth(ref.month, clock.now()); path = scoped(ctx, 'months', ref.month, 'categories', ref.id); field = 'category'; break;
        case 'category_group': path = scoped(ctx, 'categories'); field = 'category_groups'; break;
        default: path = scoped(ctx, `${ref.kind === 'category' ? 'categorie' : ref.kind}s`, ref.id); field = ref.kind;
      }
      const source = await state.get(ctx, path, undefined, true);
      const validatorName = ref.kind === 'category_group' ? 'ynab_list_categories' : ref.kind === 'category_assignment' ? 'ynab_get_category' : `ynab_get_${ref.kind}`;
      const validator = outputValidators.get(validatorName as ToolDefinition['name']);
      if (validator && !validator({ status: 'ok', data: source.data, meta: state.meta(ctx, source) })) fail('upstream_error', 'Incomplete entity detail response.');
      let entity: Json | undefined = source.data[field];
      if (ref.kind === 'category_group') entity = Array.isArray(entity) ? entity.find(e => object(e) && e.id === ref.id) : undefined;
      if (!object(entity) || entity.id !== ref.id) fail('not_found', 'Target entity was not returned.');
      const counterparts: JsonObject[] = [];
      if (ref.kind === 'transaction') {
        const visited = new Set([ref.id]); const queue: string[] = [];
        const links = (value: Json): void => {
          if (Array.isArray(value)) { value.forEach(links); return; }
          if (!object(value)) return;
          if (typeof value.transfer_transaction_id === 'string' && !visited.has(value.transfer_transaction_id)) { segment(value.transfer_transaction_id); visited.add(value.transfer_transaction_id); queue.push(value.transfer_transaction_id); }
          if (value.subtransactions !== undefined) links(value.subtransactions);
        };
        links(entity);
        for (let n = 0; n < queue.length; n++) {
          const id = queue[n]!; const other = await state.get(ctx, scoped(ctx, 'transactions', id), undefined, true);
          if (!outputValidators.get('ynab_get_transaction')!({ status: 'ok', data: other.data, meta: state.meta(ctx, other) })) fail('upstream_error', 'Incomplete counterpart detail response.');
          const row = other.data.transaction; if (!object(row) || row.id !== id) fail('upstream_error', 'Counterpart inspection incomplete.'); counterparts.push(row); links(row);
        }
      }
      return { ref, entity, counterparts, revisionKey: keyOf(ref), revision: state.revision(ctx, ref, entity, counterparts), source };
    },
    async page(ctx, args, collection, fetchFirst) {
      authorize(ctx); prune();
      if (ctx.tool.pageCollection !== collection) fail('validation_error', 'Collection does not match tool catalog.');
      const continuation = args.cursor !== undefined;
      if (!inputValidators.get(ctx.tool.name)!(args)) fail(continuation ? 'cursor_invalid' : 'validation_error', 'Invalid original page selectors.');
      if (args.plan_id !== undefined && args.plan_id !== ctx.planId) fail(args.cursor === undefined ? 'permission_denied' : 'cursor_invalid', 'Page plan must match context.');
      const pageSize = args.page_size ?? 100;
      if (typeof pageSize !== 'number' || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 500) fail('validation_error', 'Invalid page size.');
      const selectors = { ...args }; delete selectors.cursor; selectors.page_size = pageSize;
      const binding = canonical({ plan: ctx.planId ?? null, tool: ctx.tool.name, selectors, collection });
      let snap: Snapshot; let key: string; let offset = 0;
      if (args.cursor !== undefined) {
        if (typeof args.cursor !== 'string') fail('cursor_invalid', 'Invalid cursor.');
        const cursor = cursors.get(args.cursor); const entry = cursor && stored.get(cursor.key);
        if (!cursor || !entry) fail('cursor_invalid', 'Cursor expired or was evicted.');
        snap = entry.value as Snapshot; key = cursor.key; offset = cursor.offset;
        if (snap.binding !== binding) fail('cursor_invalid', 'Cursor selectors do not match.');
      } else {
        const epoch = generation(ctx.planId);
        const result = structuredClone(await fetchFirst());
        if (epoch !== generation(ctx.planId)) fail('conflict', 'Plan changed while fetching the snapshot.');
        if (!Array.isArray(result.data[collection])) fail('upstream_error', 'Expected primary collection.');
        snap = { binding, collection, result, pageSize }; key = `snapshot:${randomUUID()}`;
      }
      const all = snap.result.data[collection] as Json[];
      let token: string = randomUUID();
      const make = (end: number): OkResult => {
        const result = structuredClone(snap.result); result.data[collection] = structuredClone(all.slice(offset, end));
        result.meta.request_id = ctx.requestId; delete result.meta.next_cursor;
        result.meta.complete = end >= all.length; result.meta.total_count = all.length; result.meta.returned_count = end - offset;
        if (!result.meta.complete) result.meta.next_cursor = token;
        if (result.meta.revisions) {
          const included = new Set((result.data[collection] as Json[]).filter(object).map(e => String(e.id)));
          result.meta.revisions = Object.fromEntries(Object.entries(result.meta.revisions).filter(([k]) => included.has(k.split(':')[1]!)));
        }
        return result;
      };
      let end = Math.min(offset + pageSize, all.length); let result = make(end);
      while (bytes(result) > PAGE_LIMIT && end > offset) result = make(--end);
      if (bytes(result) > PAGE_LIMIT || (end === offset && offset < all.length)) fail('response_too_large', 'A complete row cannot fit; narrow the requested scope or dates.');
      if (end < all.length) {
        if (!stored.has(key) && !store(key, snap, clock.now() + 300000, ctx.planId)) fail('response_too_large', 'Snapshot exceeds memory budget.');
        const existing = [...cursors].find(([, cursor]) => cursor.key === key && cursor.offset === end);
        if (existing) { token = existing[0]; result.meta.next_cursor = token; }
        else cursors.set(token, { key, offset: end });
      }
      return result;
    },
    async write(ctx, args, spec): Promise<ToolResult> {
      authorize(ctx); if (!ctx.planId) fail('plan_required', 'Writes require a plan.');
      if (!ctx.tool.permissions.write || config.readOnly) fail('permission_denied', 'Writes are disabled.');
      if (ctx.tool.permissions.delete && args.confirm_delete !== true) fail('validation_error', 'Deletion requires confirmation.');
      const plan = ctx.planId; const previous = locks.get(plan) ?? Promise.resolve(); let release!: () => void;
      const done = new Promise<void>(resolve => { release = resolve; }); const tail = previous.then(() => done); locks.set(plan, tail);
      await previous;
      try {
        authorize(ctx);
        if (ctx.signal.aborted || clock.now() >= ctx.deadlineMs) fail('timeout', 'Write deadline elapsed.');
        const before: Inspection[] = [];
        for (const target of spec.targets) {
          const current = await state.inspect(ctx, target.ref);
          if (args.dry_run === false && !target.expectedRevision) fail('validation_error', 'Execution requires an expected revision for every target.');
          if (target.expectedRevision !== undefined && target.expectedRevision !== current.revision) fail('conflict', 'Expected revision is stale.');
          before.push(current);
        }
        protect(before);
        const prepared = await spec.prepare(before);
        pathCheck(ctx, prepared.path);
        const matches = ctx.tool.upstream.some(route => {
          if (route.method !== prepared.method) return false;
          const expected = route.path.split('/'); const actual = prepared.path.split('/');
          return expected.length === actual.length && expected.every((part, i) => part === '{plan_id}' ? actual[i] === segment(plan) : /^\{[^}]+\}$/.test(part) ? !!actual[i] : actual[i] === part);
        });
        if (!matches) fail('unsupported_operation', 'Prepared endpoint does not match tool catalog.');
        if ((prepared.method === 'DELETE' && (!config.allowDeletes || args.confirm_delete !== true)) || (prepared.setsReconciled && !config.allowReconciledChanges) || (prepared.usesImportId && !config.allowImports)) fail('permission_denied', 'Prepared write violates connection policy.');
        const revisions = Object.fromEntries(before.map(i => [i.revisionKey, i.revision]));
        const meta = state.meta(ctx, before[0]?.source); meta.revisions = revisions;
        if (prepared.resolvedMonth) meta.resolved_month = prepared.resolvedMonth;
        if (args.dry_run !== false) return { status: 'preview', preview: { method: prepared.method, path: prepared.path, body: structuredClone(prepared.body), validated: true, before: before.flatMap(i => [i.entity, ...i.counterparts]).map(e => structuredClone(e)), expected_revisions: revisions, affected_ids: ids(before), unknown_effects: prepared.unknownEffects, warnings: [...prepared.warnings] }, meta };
        for (const old of before) { const fresh = await state.inspect(ctx, old.ref); if (fresh.revision !== old.revision) fail('conflict', 'Target changed during preparation.'); }
        if (ctx.signal.aborted || clock.now() >= ctx.deadlineMs) fail('timeout', 'Write deadline elapsed.');
        let reply;
        try { reply = await api.request(ctx, { method: prepared.method, path: prepared.path, ...(prepared.body === null ? {} : { body: prepared.body }) }); }
        catch (error) {
          if (error instanceof ToolFailure && error.error.outcome !== 'unknown') return { status: 'error', error: { ...error.error, retryable: false, ...(error.error.outcome === 'applied' ? { recovery_tool: recovery(ctx) } : {}) }, meta };
          return { status: 'error', error: { code: 'outcome_unknown', message: 'Mutation application is uncertain; reconcile with a read before any further write.', retryable: false, outcome: 'unknown', recovery_tool: recovery(ctx) }, meta };
        } finally { state.invalidatePlan(plan); }
        try {
          const verified = await spec.verify(reply, prepared, before);
          return { status: 'ok', data: verified.data, meta: { ...meta, fetched_at: verified.fetchedAt ?? reply.fetchedAt, cache_hit: false, warnings: [...prepared.warnings, ...verified.warnings], ...(verified.revisions ? { revisions: { ...verified.revisions } } : { revisions: {} }) } };
        } catch (error) {
          const acknowledged = new Set<string>();
          const collect = (v: Json): void => { if (Array.isArray(v)) v.forEach(collect); else if (object(v)) { if (typeof v.id === 'string') acknowledged.add(v.id); if (Array.isArray(v.transaction_ids)) v.transaction_ids.forEach(id => { if (typeof id === 'string') acknowledged.add(id); }); Object.values(v).forEach(collect); } };
          collect(reply.data);
          return { status: 'error', error: { code: 'verification_failed', message: 'Mutation acknowledged but verification could not confirm intended effects.', retryable: false, outcome: 'applied', recovery_tool: recovery(ctx), details: { ...(error instanceof ToolFailure ? error.error.details : {}), acknowledged_ids: [...acknowledged] } }, meta: { ...meta, fetched_at: reply.fetchedAt } };
        }
      } finally { release(); if (locks.get(plan) === tail) locks.delete(plan); }
    },
    invalidatePlan(planId) { generations.set(planId, generation(planId) + 1); globalGeneration++; for (const [key, value] of stored) if (value.plan === planId || (key.startsWith('get:') && (value.value as CachedReply).data.plans !== undefined) || (key.startsWith('snapshot:') && (value.value as Snapshot).collection === 'plans')) remove(key); },
  };
  return state;
}
