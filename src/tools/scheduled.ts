import type { CallContext, ErrorCode, HandlerMap, Json, JsonObject, Services, ToolHandler, ToolName } from '../contracts.js';
import { inputValidators, outputValidators } from '../catalog.js';
import { ToolFailure } from '../errors.js';
import { assertScheduledDate } from '../safety/dates.js';

function fail(code: ErrorCode, message: string): never {
  throw new ToolFailure({ code, message, retryable: false, outcome: 'not_applied' });
}
function object(value: Json | undefined): value is JsonObject { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function objects(value: Json | undefined): JsonObject[] {
  if (!Array.isArray(value) || !value.every(object)) fail('upstream_error', 'Expected complete context collection.');
  return value;
}
function path(ctx: CallContext, ...parts: string[]): string {
  if (!ctx.planId) fail('plan_required', 'Select an explicit plan.');
  return `/plans/${encodeURIComponent(ctx.planId)}/${parts.map(encodeURIComponent).join('/')}`;
}
// Only write fields are merged. The payee selectors form one coupled value.
function merge(input: JsonObject, old?: JsonObject): JsonObject {
  const write = { ...input };
  for (const field of ['memo', 'category_id', 'flag_color']) if (!(field in input) && old && field in old) write[field] = old[field]!;
  if (typeof input.payee_id === 'string' && typeof input.payee_name === 'string') fail('validation_error', 'Use only one non-null payee selector.');
  if (typeof input.payee_id === 'string') delete write.payee_name;
  else if (typeof input.payee_name === 'string') write.payee_id = null;
  else if ('payee_id' in input || 'payee_name' in input) { write.payee_id = null; write.payee_name = null; }
  else if (typeof old?.payee_id === 'string') write.payee_id = old.payee_id;
  else if (typeof old?.payee_name === 'string') { write.payee_id = null; write.payee_name = old.payee_name; }
  else if (old) { write.payee_id = null; write.payee_name = null; }
  return write;
}
function matches(intent: JsonObject, entity: JsonObject): boolean {
  if (entity.deleted === true) return false;
  for (const [key, value] of Object.entries(intent)) {
    if (key === 'payee_name' && typeof value === 'string') { if (typeof entity.payee_id !== 'string') return false; }
    else if (key === 'payee_id' && value === null && typeof intent.payee_name === 'string') continue;
    else if ((entity[key === 'date' ? 'date_next' : key] ?? null) !== value) return false;
  }
  return true;
}

/** Endpoint intent only: policy, preflights, locking and revisions belong to state.write. */
export function createScheduledTools(services: Services): HandlerMap {
  const { state, clock } = services;
  async function collection(ctx: CallContext, resource: string, field: string, tool: ToolName): Promise<JsonObject[]> {
    const reply = await state.get(ctx, path(ctx, resource), undefined, true);
    if (!outputValidators.get(tool)!({ status: 'ok', data: reply.data, meta: state.meta(ctx, reply) })) fail('upstream_error', `Incomplete semantic context: ${resource}.`);
    return objects(reply.data[field]);
  }
  async function validate(ctx: CallContext, write: JsonObject, old: JsonObject | undefined, warnings: string[]): Promise<boolean> {
    assertScheduledDate(String(write.date), clock.now());
    if (!Number.isSafeInteger(write.amount)) fail('unsafe_integer', 'Amount must be a safe integer.');
    const accounts = await collection(ctx, 'accounts', 'accounts', 'ynab_list_accounts');
    const payees = await collection(ctx, 'payees', 'payees', 'ynab_list_payees');
    const groups = await collection(ctx, 'categories', 'category_groups', 'ynab_list_categories');
    const source = accounts.find(a => a.id === write.account_id && a.deleted === false);
    if (!source) fail('validation_error', 'Account must exist in the selected plan.');
    if ((!old || write.account_id !== old.account_id) && source.closed === true) fail('validation_error', 'New schedules cannot use closed accounts.');
    let dest: JsonObject | undefined;
    if (typeof write.payee_name === 'string') {
      if (payees.some(p => p.name === write.payee_name && typeof p.transfer_account_id === 'string')) fail('validation_error', 'Transfers require a destination transfer_payee_id, not a name.');
      warnings.push('Payee-name resolution may create a payee or resolve a renamed identity.');
    } else if (typeof write.payee_id === 'string') {
      dest = accounts.find(a => a.transfer_payee_id === write.payee_id && a.deleted === false);
      if (!dest) {
        const payee = payees.find(p => p.id === write.payee_id && p.deleted === false);
        if (!payee) fail('validation_error', 'Payee must exist in the selected plan.');
        if (typeof payee.transfer_account_id === 'string') fail('validation_error', 'Transfer destination is not a valid account in this plan.');
      }
    }
    if (dest?.id === source.id) fail('validation_error', 'Cannot transfer to the same account.');
    if (dest && source.on_budget === true && dest.on_budget === true && write.category_id != null) fail('validation_error', 'On-budget transfers cannot have a category.');
    if (source.on_budget === false && write.category_id != null) fail('validation_error', 'Tracking-account schedules cannot have a category.');
    if (write.category_id != null) {
      let category: JsonObject | undefined, parent: JsonObject | undefined;
      for (const group of groups) {
        const found = objects(group.categories).find(c => c.id === write.category_id);
        if (found) { category = found; parent = group; break; }
      }
      if (!category || category.deleted === true || parent?.deleted === true) fail('validation_error', 'Category must be non-deleted in this plan.');
      if (/^credit card payments?$/i.test(String(parent?.name)) || /^credit card payments?$/i.test(String(category.category_group_name))) fail('unsupported_operation', 'Credit Card Payment categories cannot be assigned.');
      if (category.internal === true && (!/ready to assign|to be budgeted/i.test(String(category.name)) || Number(write.amount) < 0)) fail('unsupported_operation', 'Internal category is not a supported Ready to Assign inflow.');
      if (category.hidden === true || parent?.hidden === true) warnings.push('Assigning a hidden category.');
    }
    return !!dest || typeof write.payee_name === 'string';
  }
  function handler(kind: 'create' | 'update' | 'delete'): ToolHandler {
    return async (args, ctx) => {
      if (!inputValidators.get(ctx.tool.name)!(args)) fail('validation_error', 'Invalid tool arguments.');
      const id = String(args.scheduled_transaction_id);
      return state.write(ctx, args, {
        targets: kind === 'create' ? [] : [{ ref: { kind: 'scheduled_transaction', id }, ...(typeof args.expected_revision === 'string' ? { expectedRevision: args.expected_revision } : {}) }],
        async prepare(before) {
          const old = before[0]?.entity;
          if (old?.deleted === true) fail('not_found', 'Schedule is deleted.');
          if (kind === 'update' && objects(old?.subtransactions).some(c => c.deleted !== true)) fail('unsupported_operation', 'Existing split schedules are read-only.');
          const warnings = ['YNAB has no atomic compare-and-swap; changes after the final preflight remain possible.'];
          const write = kind === 'delete' ? undefined : merge(args.scheduled_transaction as JsonObject, old);
          const unknownEffects = write ? await validate(ctx, write, old, warnings) : false;
          return { method: kind === 'create' ? 'POST' : kind === 'update' ? 'PUT' : 'DELETE',
            path: path(ctx, 'scheduled_transactions', ...(kind === 'create' ? [] : [id])),
            body: write ? { scheduled_transaction: write } : null, warnings, unknownEffects, setsReconciled: false, usesImportId: false };
        },
        async verify(reply, prepared) {
          let entity = reply.data.scheduled_transaction;
          if (!object(entity) || typeof entity.id !== 'string' || (kind !== 'create' && entity.id !== id)) fail('verification_failed', 'Acknowledgment must identify the saved schedule.');
          const savedId = entity.id;
          let fetchedAt = reply.fetchedAt;
          const complete = outputValidators.get(ctx.tool.name)!({ status: 'ok', data: reply.data, meta: state.meta(ctx) });
          if (!complete || (kind === 'delete' && entity.deleted !== true)) {
            try {
              const fresh = await state.inspect(ctx, { kind: 'scheduled_transaction', id: savedId });
              entity = fresh.entity; fetchedAt = fresh.source.fetchedAt;
            } catch (error) {
              if (kind === 'delete' && complete && error instanceof ToolFailure && error.error.code === 'not_found' && error.error.http_status === 404) {
                return { data: reply.data, warnings: ['Fresh detail read confirms the schedule is absent; acknowledgment contained its pre-delete state.'], revisions: {}, fetchedAt };
              }
              throw error;
            }
          }
          if (kind === 'delete') {
            if (entity.deleted !== true) fail('verification_failed', 'Schedule remains undeleted.');
            return { data: { ...reply.data, scheduled_transaction: entity }, warnings: [], revisions: {}, fetchedAt };
          }
          if (!matches(prepared.body!.scheduled_transaction as JsonObject, entity)) fail('verification_failed', 'Requested scheduled fields were not applied.');
          return { data: { ...reply.data, scheduled_transaction: entity }, warnings: [], fetchedAt,
            revisions: { [`scheduled_transaction:${savedId}`]: state.revision(ctx, { kind: 'scheduled_transaction', id: savedId }, entity) } };
        },
      });
    };
  }
  return { ynab_create_scheduled_transaction: handler('create'), ynab_update_scheduled_transaction: handler('update'), ynab_delete_scheduled_transaction: handler('delete') };
}
