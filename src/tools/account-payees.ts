import type { CallContext, ErrorCode, HandlerMap, Json, JsonObject, Services, ToolHandler, ToolName } from '../contracts.js';
import { inputValidators, outputValidators } from '../catalog.js';
import { ToolFailure } from '../errors.js';

function fail(code: ErrorCode, message: string, details?: JsonObject): never {
  throw new ToolFailure({ code, message, retryable: false, outcome: 'not_applied', ...(details ? { details } : {}) });
}
function object(value: Json | undefined): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function path(ctx: CallContext, resource: string, id?: string): string {
  if (!ctx.planId) fail('plan_required', 'Select an explicit plan.');
  if (id !== undefined && !uuid.test(id)) fail('upstream_error', 'Expected an acknowledged UUID.');
  return `/plans/${encodeURIComponent(ctx.planId)}/${resource}${id === undefined ? '' : `/${encodeURIComponent(id)}`}`;
}

/** Only endpoint intent/verification; safety owns policy, fresh preflight, locking and revisions. */
export function createAccountPayeeTools({ state }: Services): HandlerMap {
  function handler(name: ToolName, field: 'account' | 'payee', update = false): ToolHandler {
    return async (args, ctx) => {
      if (!inputValidators.get(name)!(args)) fail('validation_error', 'Invalid tool arguments.');
      const intent: JsonObject = field === 'account' ? { ...(args.account as JsonObject) } : { name: args.name! };
      const targetId = update ? String(args.payee_id) : undefined;
      return state.write(ctx, args, {
        targets: targetId === undefined ? [] : [{ ref: { kind: 'payee', id: targetId }, ...(typeof args.expected_revision === 'string' ? { expectedRevision: args.expected_revision } : {}) }],
        async prepare(current) {
          if (update) {
            const old = current[0]!.entity;
            if (old.deleted === true) fail('not_found', 'Payee is deleted.');
            if (old.transfer_account_id != null) fail('unsupported_operation', 'Transfer payees cannot be renamed.');
          }
          return { method: update ? 'PATCH' : 'POST', path: path(ctx, `${field}s`, targetId), body: { [field]: intent }, warnings: [], unknownEffects: false, setsReconciled: false, usesImportId: false };
        },
        async verify(reply) {
          let entity = reply.data[field];
          let fetchedAt = reply.fetchedAt;
          // An ID-only or incomplete acknowledgment is not field verification.
          const detailTool = field === 'account' ? 'ynab_get_account' : 'ynab_get_payee';
          const complete = (data: JsonObject): boolean => !!outputValidators.get(detailTool)!({ status: 'ok', data, meta: state.meta(ctx) });
          const acknowledged = object(entity) && typeof entity.id === 'string' ? entity.id : reply.data[`${field}_id`];
          if (targetId !== undefined && acknowledged !== undefined && acknowledged !== targetId) fail('verification_failed', 'Save response returned a different payee.', { observed: reply.data });
          const id = typeof acknowledged === 'string' ? acknowledged : targetId;
          if (!complete({ [field]: entity ?? null })) {
            if (!id) fail('verification_failed', 'Save response did not identify the created entity.');
            if (field === 'payee') {
              const inspection = await state.inspect(ctx, { kind: 'payee', id });
              entity = inspection.entity; fetchedAt = inspection.source.fetchedAt;
            } else {
              const source = await state.get(ctx, path(ctx, 'accounts', id), undefined, true);
              if (!complete(source.data)) fail('verification_failed', 'Incomplete account verification response.', { observed: source.data });
              entity = source.data.account; fetchedAt = source.fetchedAt;
            }
          }
          if (!object(entity) || typeof entity.id !== 'string' || (id !== undefined && entity.id !== id) || entity.deleted !== false) fail('verification_failed', 'Saved entity is missing, deleted or has a different identity.', { observed: reply.data });
          // Do not guess balance normalization or accept abs/sign conversions: the opening
          // milliunit intent must be confirmed, not merely the account name and type.
          if (Object.entries(intent).some(([key, value]) => entity[key] !== value)) fail('verification_failed', 'Saved fields differ from requested intent.', { observed: entity });
          const data: JsonObject = { ...reply.data, [field]: entity };
          if (!outputValidators.get(name)!({ status: 'ok', data, meta: state.meta(ctx) })) fail('verification_failed', 'Incomplete save response.', { observed: data });
          return { data, warnings: [], fetchedAt, ...(field === 'payee' ? { revisions: { [`payee:${entity.id}`]: state.revision(ctx, { kind: 'payee', id: entity.id }, entity) } } : {}) };
        },
      });
    };
  }
  return {
    ynab_create_account: handler('ynab_create_account', 'account'),
    ynab_create_payee: handler('ynab_create_payee', 'payee'),
    ynab_update_payee: handler('ynab_update_payee', 'payee', true),
  };
}
