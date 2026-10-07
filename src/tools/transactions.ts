import type { ApiReply, CallContext, ErrorCode, HandlerMap, Inspection, Json, JsonObject, MutationMethod, PreparedWrite, Services, ToolHandler, ToolName, VerifiedWrite, WriteTarget } from '../contracts.js';
import { inputValidators, outputValidators } from '../catalog.js';
import { ToolFailure } from '../errors.js';
import { assertTransactionDate } from '../safety/dates.js';

function fail(code: ErrorCode, message: string, details?: JsonObject): never {
  throw new ToolFailure({ code, message, retryable: false, outcome: 'not_applied', ...(details ? { details } : {}) });
}
function object(value: Json | undefined): value is JsonObject { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function objects(value: Json | undefined): JsonObject[] {
  if (!Array.isArray(value) || !value.every(object)) fail('upstream_error', 'Expected complete entity collection.');
  return value;
}
function strings(value: Json | undefined): string[] {
  if (!Array.isArray(value) || !value.every(v => typeof v === 'string')) fail('upstream_error', 'Expected acknowledged IDs.');
  return value;
}
function path(ctx: CallContext, ...segments: string[]): string {
  if (!ctx.planId) fail('plan_required', 'Select an explicit plan.');
  return `/plans/${ctx.planId}/${segments.map(encodeURIComponent).join('/')}`;
}
function integer(value: Json | undefined): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) fail('unsafe_integer', 'Amounts and split sums must be safe integers.');
  return value;
}
function couplePayee(input: JsonObject): JsonObject {
  const result = { ...input };
  if (typeof input.payee_id === 'string' && typeof input.payee_name === 'string') fail('validation_error', 'Use only one non-null payee selector.');
  if (typeof input.payee_id === 'string') delete result.payee_name;
  else if (typeof input.payee_name === 'string') result.payee_id = null;
  else if ('payee_id' in input || 'payee_name' in input) { result.payee_id = null; result.payee_name = null; }
  return result;
}
const matchingWarning = 'Import matching may change an existing transaction whose identity and reconciled state cannot be preflighted; explicit-target protections do not cover these opaque effects.';
const raceWarning = 'YNAB has no atomic compare-and-swap; changes after the final preflight remain possible.';
interface ContextData { accounts: JsonObject[]; payees: JsonObject[]; groups: JsonObject[] }

/** Endpoint intent and comparison only. Locking, revisions, permission gates and mutation lifecycle belong to state.write. */
export function createTransactionTools(services: Services): HandlerMap {
  const { state, clock } = services;
  async function collection(ctx: CallContext, resource: string, field: string, tool: ToolName): Promise<JsonObject[]> {
    const reply = await state.get(ctx, path(ctx, resource), undefined, true);
    if (!outputValidators.get(tool)!({ status: 'ok', data: reply.data, meta: state.meta(ctx, reply) })) fail('upstream_error', 'Incomplete semantic context.');
    return objects(reply.data[field]);
  }
  async function context(ctx: CallContext): Promise<ContextData> {
    return { accounts: await collection(ctx, 'accounts', 'accounts', 'ynab_list_accounts'),
      payees: await collection(ctx, 'payees', 'payees', 'ynab_list_payees'),
      groups: await collection(ctx, 'categories', 'category_groups', 'ynab_list_categories') };
  }
  function accountIn(data: ContextData, id: Json | undefined): JsonObject {
    const found = data.accounts.find(a => a.id === id && a.deleted === false);
    if (!found) fail('validation_error', 'Account must exist in the selected plan.');
    return found;
  }
  function categoryCheck(data: ContextData, id: Json | undefined, amount: number, warnings: string[]): void {
    if (id === null || id === undefined) return;
    let found: JsonObject | undefined; let parent: JsonObject | undefined;
    for (const group of data.groups) {
      const category = objects(group.categories).find(c => c.id === id);
      if (category) { found = category; parent = group; break; }
    }
    if (!found || found.deleted === true || parent?.deleted === true) fail('validation_error', 'Category must be non-deleted in this plan.');
    if (/^credit card payments?$/i.test(String(parent?.name)) || /^credit card payments?$/i.test(String(found.category_group_name))) fail('unsupported_operation', 'Credit Card Payment categories are ignored by YNAB and cannot be assigned.');
    if (found.internal === true) {
      if (!/ready to assign|to be budgeted/i.test(String(found.name)) || amount < 0) fail('unsupported_operation', 'Internal category is not a supported Ready to Assign inflow.');
    }
    if (found.hidden === true || parent?.hidden === true) warnings.push('Assigning a hidden category.');
  }
  function transferDestination(data: ContextData, write: JsonObject, old?: JsonObject): JsonObject | undefined {
    if (typeof write.payee_name === 'string') {
      if (data.payees.some(p => p.name === write.payee_name && typeof p.transfer_account_id === 'string')) fail('validation_error', 'Transfers require the destination account transfer_payee_id, not a name.');
      return undefined;
    }
    const payeeId = 'payee_id' in write ? write.payee_id : old?.payee_id;
    if (typeof payeeId === 'string') {
      const transfer = data.accounts.find(a => a.transfer_payee_id === payeeId && a.deleted === false);
      if (transfer) return transfer;
      const payee = data.payees.find(p => p.id === payeeId && p.deleted === false);
      if (!payee) fail('validation_error', 'Payee must exist in the selected plan.');
      if (typeof payee.transfer_account_id === 'string') fail('validation_error', 'Transfer destination is not a valid account in this plan.');
    }
    if (!('payee_id' in write) && !('payee_name' in write) && typeof old?.transfer_account_id === 'string') return accountIn(data, old.transfer_account_id);
    return undefined;
  }
  function validateRow(data: ContextData, input: JsonObject, old: JsonObject | undefined, warnings: string[]): JsonObject {
    const write = couplePayee(input);
    if (!old) { write.approved ??= false; write.cleared ??= 'uncleared'; }
    if (typeof write.date === 'string') assertTransactionDate(write.date, clock.now());
    const amount = integer(write.amount ?? old?.amount);
    const source = accountIn(data, write.account_id ?? old?.account_id);
    if ((!old || 'account_id' in write) && source.closed === true) fail('validation_error', 'New transactions cannot use closed accounts.');
    const existingSplit = old && objects(old.subtransactions).some(child => child.deleted !== true);
    if (old?.deleted === true) fail('not_found', 'Transaction is deleted.');
    if (existingSplit) {
      if ('subtransactions' in write) fail('unsupported_operation', 'Existing split rows cannot be updated.');
      for (const field of ['amount', 'date', 'category_id']) if (field in write && write[field] !== (old[field] ?? null)) fail('unsupported_operation', 'Existing split amount/date/category cannot change.');
    }
    const dest = transferDestination(data, write, old);
    if (dest?.id === source.id) fail('validation_error', 'Cannot transfer to the same account.');
    if (existingSplit && (source.on_budget !== true || dest?.on_budget === true)) fail('unsupported_operation', 'Existing split cannot become a tracking-account or on-budget-transfer split.');
    const category = 'category_id' in write ? write.category_id : old?.category_id;
    if (dest && source.on_budget === true && dest.on_budget === true && category != null) fail('validation_error', 'On-budget transfers cannot have a category.');
    if (source.on_budget === false && category != null) fail('validation_error', 'Tracking-account transactions cannot have a category.');
    if ('category_id' in write) categoryCheck(data, write.category_id, amount, warnings);
    if (typeof write.payee_name === 'string') warnings.push('Payee-name resolution may create a new payee; YNAB rename rules may resolve a different identity.');
    if (Array.isArray(write.subtransactions)) {
      if (write.category_id !== null || write.subtransactions.length < 2 || write.subtransactions.length > 100) fail('validation_error', 'Splits require explicit category_id:null and 2–100 children.');
      if (source.on_budget !== true) fail('unsupported_operation', 'Tracking-account splits are unsupported.');
      if (dest?.on_budget === true) fail('unsupported_operation', 'On-budget-to-on-budget transfer splits are unsupported.');
      let sum = 0;
      const children = objects(write.subtransactions).map(child => {
        const normalized = couplePayee(child); const childAmount = integer(child.amount);
        sum = integer(sum + childAmount);
        const childDest = transferDestination(data, normalized);
        if (childDest?.id === source.id) fail('validation_error', 'Split transfer cannot target the same account.');
        if (childDest?.on_budget === true) fail('unsupported_operation', 'On-budget-to-on-budget split transfers are unsupported.');
        categoryCheck(data, normalized.category_id, childAmount, warnings);
        if (typeof normalized.payee_name === 'string') warnings.push('A split payee-name selector may create a new payee.');
        return normalized;
      });
      if (sum !== amount) fail('validation_error', 'Exact split sum must equal the parent amount.');
      write.subtransactions = children;
    }
    return write;
  }
  function validateReply(ctx: CallContext, reply: ApiReply): void {
    if (!outputValidators.get(ctx.tool.name)!({ status: 'ok', data: reply.data, meta: state.meta(ctx) })) fail('verification_failed', 'Acknowledgment does not match the catalog.');
  }
  // Name selectors resolve to an identity, not necessarily the literal name (rename rules).
  function fieldsMatch(intent: JsonObject, entity: JsonObject): boolean {
    if (entity.deleted === true) return false;
    for (const [key, value] of Object.entries(intent)) {
      if (key === 'id') { if (entity.id !== value) return false; continue; }
      if (key === 'payee_name' && typeof value === 'string') {
        if (typeof entity.payee_id !== 'string') return false;
        continue;
      }
      if (key === 'payee_id' && value === null && typeof intent.payee_name === 'string') continue;
      if (key === 'subtransactions') {
        if (!Array.isArray(value) || !Array.isArray(entity.subtransactions) || !multiset(objects(value), objects(entity.subtransactions).filter(c => c.deleted !== true))) return false;
      } else if ((entity[key] ?? null) !== value) return false;
    }
    return true;
  }
  // Bipartite matching avoids positional identity claims and greedy ambiguity with omitted fields.
  function multiset(intents: JsonObject[], entities: JsonObject[]): boolean {
    if (intents.length !== entities.length) return false;
    const assigned = new Map<number, number>();
    function match(i: number, seen: Set<number>): boolean {
      for (let j = 0; j < entities.length; j++) {
        if (seen.has(j) || !fieldsMatch(intents[i]!, entities[j]!)) continue;
        seen.add(j);
        if (!assigned.has(j) || match(assigned.get(j)!, seen)) { assigned.set(j, i); return true; }
      }
      return false;
    }
    return intents.every((_intent, i) => match(i, new Set()));
  }
  async function observed(ctx: CallContext, reply: ApiReply, ids: string[]): Promise<{ entities: JsonObject[]; fetchedAt?: string }> {
    const supplied = [...(object(reply.data.transaction) ? [reply.data.transaction] : []), ...(reply.data.transactions === undefined ? [] : objects(reply.data.transactions))];
    if (new Set(supplied.map(r => r.id)).size !== supplied.length || supplied.some(r => !ids.includes(String(r.id)))) fail('verification_failed', 'Acknowledgment has duplicate or unexpected entities.');
    const result: JsonObject[] = []; let fetchedAt: string | undefined;
    for (const id of ids) {
      const row = supplied.find(r => r.id === id);
      if (row) result.push(row);
      else {
        const fresh = await state.inspect(ctx, { kind: 'transaction', id });
        result.push(fresh.entity); fetchedAt = fresh.source.fetchedAt;
      }
    }
    return { entities: result, ...(fetchedAt ? { fetchedAt } : {}) };
  }
  async function graphVerification(ctx: CallContext, entities: JsonObject[], before: readonly Inspection[], transferPayees: ReadonlySet<string> = new Set(), confirms: (entity: JsonObject) => boolean = () => true): Promise<{ warnings: string[]; revisions: Record<string, string>; fetchedAt?: string }> {
    const warnings: string[] = []; const revisions: Record<string, string> = {}; let fetchedAt: string | undefined;
    const hasLinks = (entity: JsonObject): boolean => typeof entity.transfer_transaction_id === 'string' || typeof entity.transfer_account_id === 'string' || transferPayees.has(String(entity.payee_id)) || (Array.isArray(entity.subtransactions) && objects(entity.subtransactions).some(c => typeof c.transfer_transaction_id === 'string' || typeof c.transfer_account_id === 'string' || transferPayees.has(String(c.payee_id))));
    const oldById = new Map(before.map(i => [i.entity.id, i]));
    const inspected = new Set<string>();
    for (const entity of entities) {
      const id = String(entity.id); const old = oldById.get(id);
      if (entity.deleted === true) continue;
      if (hasLinks(entity) || (old && (hasLinks(old.entity) || old.counterparts.length > 0))) {
        let fresh: Inspection;
        try { fresh = await state.inspect(ctx, { kind: 'transaction', id }); }
        catch { warnings.push(`Transfer graph verification gap for transaction ${id}; reconcile with ynab_get_transaction.`); continue; }
        if (!confirms(fresh.entity)) fail('verification_failed', 'Fresh transfer target contradicts the intended fields.', { unverified_ids: [id], observed: fresh.entity });
        {
          revisions[fresh.revisionKey] = fresh.revision; fetchedAt = fresh.source.fetchedAt;
          if (hasLinks(fresh.entity) && fresh.counterparts.length === 0) warnings.push(`Transfer graph verification gap for transaction ${id}: no linked counterpart was returned.`);
          for (const e of [fresh.entity, ...fresh.counterparts]) inspected.add(String(e.id));
          for (const other of fresh.counterparts) warnings.push(`Observed transfer counterpart ${String(other.id)}: ${JSON.stringify({ account_id: other.account_id, amount: other.amount, category_id: other.category_id ?? null, cleared: other.cleared, deleted: other.deleted })}.`);
        }
      } else revisions[`transaction:${id}`] = state.revision(ctx, { kind: 'transaction', id }, entity);
    }
    for (const old of before) for (const other of old.counterparts) {
      const id = String(other.id); if (inspected.has(id)) continue;
      try {
        const fresh = await state.inspect(ctx, { kind: 'transaction', id }); inspected.add(id);
        warnings.push(`Observed former transfer counterpart ${id}: ${JSON.stringify({ account_id: fresh.entity.account_id, amount: fresh.entity.amount, category_id: fresh.entity.category_id ?? null, cleared: fresh.entity.cleared, deleted: fresh.entity.deleted })}.`);
      }
      catch { warnings.push(`Transfer counterpart verification gap for transaction ${id}; its post-write state could not be observed.`); }
    }
    return { warnings, revisions, ...(fetchedAt ? { fetchedAt } : {}) };
  }
  function handler(kind: 'create' | 'single' | 'bulk' | 'approval' | 'category' | 'delete' | 'import'): ToolHandler {
    return async (args, ctx) => {
      if (!inputValidators.get(ctx.tool.name)!(args)) fail('validation_error', 'Invalid tool arguments.');
      const targets: WriteTarget[] = [];
      const transferPayees = new Set<string>();
      const items = kind === 'single' || kind === 'delete' ? [{ id: args.transaction_id!, expected_revision: args.expected_revision ?? null, changes: args.changes ?? {} }]
        : kind === 'import' ? [] : objects(args.transactions);
      if (kind !== 'create' && kind !== 'import') {
        const seen = new Set<string>();
        for (const item of items) {
          const id = String(item.id);
          if (seen.has(id)) fail('validation_error', 'Duplicate transaction IDs are invalid.'); seen.add(id);
          targets.push({ ref: { kind: 'transaction', id }, ...(typeof item.expected_revision === 'string' ? { expectedRevision: item.expected_revision } : {}) });
        }
      }
      return state.write(ctx, args, {
        targets,
        async prepare(before) {
          const warnings = kind === 'import' ? ['Import scope is all linked accounts in this plan; this does not guarantee a bank refresh.', matchingWarning] : [raceWarning];
          let body: JsonObject | null = null; let method: MutationMethod; let endpoint = path(ctx, 'transactions');
          let writes: JsonObject[] = [];
          if (kind === 'import') { method = 'POST'; endpoint += '/import'; }
          else if (kind === 'delete') {
            method = 'DELETE'; endpoint = path(ctx, 'transactions', String(args.transaction_id));
            if (before.some(i => i.counterparts.length > 0)) warnings.push('YNAB controls linked transfer deletion; no independent counter-leg will be submitted.');
          } else {
            method = kind === 'create' ? 'POST' : kind === 'single' ? 'PUT' : 'PATCH';
            const data = kind === 'approval' ? undefined : await context(ctx);
            for (const account of data?.accounts ?? []) if (typeof account.transfer_payee_id === 'string') transferPayees.add(account.transfer_payee_id);
            writes = items.map(item => {
              const old = before.find(i => i.ref.id === item.id)?.entity;
              if (kind === 'approval') {
                if (old?.deleted === true) fail('not_found', 'Transaction is deleted.');
                return { id: item.id!, approved: args.approved! };
              }
              if (kind === 'category' && old && objects(old.subtransactions).some(c => c.deleted !== true)) fail('unsupported_operation', 'Categorization cannot change existing splits.');
              const input = kind === 'create' ? item : kind === 'category' ? { category_id: args.category_id! } : item.changes as JsonObject;
              const write = validateRow(data!, input, old, warnings);
              return kind === 'single' || kind === 'create' ? write : { id: item.id!, ...write };
            });
            if (kind === 'single') { endpoint = path(ctx, 'transactions', String(args.transaction_id)); body = { transaction: writes[0]! }; }
            else body = { transactions: writes };
          }
          const usesImportId = kind === 'import' || writes.some(w => typeof w.import_id === 'string');
          if (kind !== 'import' && usesImportId) warnings.push(matchingWarning);
          const prepared: PreparedWrite = { method, path: endpoint, body, warnings: [...new Set(warnings)],
            unknownEffects: usesImportId || writes.some(w => typeof w.payee_name === 'string' || transferPayees.has(String(w.payee_id)) || Array.isArray(w.subtransactions) && objects(w.subtransactions).some(c => typeof c.payee_name === 'string' || transferPayees.has(String(c.payee_id)))),
            setsReconciled: writes.some(w => w.cleared === 'reconciled'), usesImportId };
          return prepared;
        },
        async verify(reply, prepared, before): Promise<VerifiedWrite> {
          validateReply(ctx, reply);
          if (kind === 'import') { strings(reply.data.transaction_ids); return { data: reply.data, warnings: [] }; }
          if (kind === 'delete') {
            const id = String(args.transaction_id); let entity = reply.data.transaction as JsonObject;
            if (entity.id !== id) fail('verification_failed', 'Deletion acknowledged a different target.');
            const warnings: string[] = [];
            if (entity.deleted !== true) {
              try {
                const fresh = await state.inspect(ctx, { kind: 'transaction', id });
                if (fresh.entity.deleted !== true) fail('verification_failed', 'Target remains undeleted.', { observed: fresh.entity });
                entity = fresh.entity;
              } catch (error) {
                if (!(error instanceof ToolFailure && error.error.code === 'not_found' && error.error.http_status === 404)) throw error;
                warnings.push('Fresh detail read confirms the target is absent; deletion acknowledgment contained its pre-delete state.');
              }
            }
            const graph = await graphVerification(ctx, [], before);
            return { data: { ...reply.data, transaction: entity }, ...graph, warnings: [...warnings, ...graph.warnings] };
          }
          const intents = kind === 'single' ? [prepared.body!.transaction as JsonObject] : objects(prepared.body!.transactions);
          const ids = kind === 'single' ? [String(args.transaction_id)] : strings(reply.data.transaction_ids);
          if (new Set(ids).size !== ids.length) fail('verification_failed', 'Acknowledgment contains duplicate saved IDs.');
          if (kind !== 'create' && (ids.length !== targets.length || targets.some(t => !ids.includes(t.ref.id)))) fail('verification_failed', 'Some requested targets were not acknowledged.', { unverified_ids: targets.filter(t => !ids.includes(t.ref.id)).map(t => t.ref.id) });
          const observation = await observed(ctx, reply, ids);
          const entities = observation.entities;
          if (kind === 'create') {
            const duplicates = reply.data.duplicate_import_ids === undefined ? [] : strings(reply.data.duplicate_import_ids);
            const remaining = [...intents];
            for (const duplicate of duplicates) {
              const candidates = remaining.filter(i => i.import_id === duplicate);
              // Duplicate IDs are account-scoped, while the response has no account mapping. Ambiguity fails closed.
              if (candidates.length !== 1) fail('verification_failed', 'Duplicate import acknowledgment cannot be mapped conservatively.');
              remaining.splice(remaining.indexOf(candidates[0]!), 1);
            }
            if (!multiset(remaining, entities)) fail('verification_failed', 'Create multiset differs from requested intent.', { observed: entities });
          } else {
            for (const intent of intents) {
              const id = kind === 'single' ? String(args.transaction_id) : String(intent.id);
              const entity = entities.find(e => e.id === id);
              if (!entity || !fieldsMatch(intent, entity)) fail('verification_failed', 'Submitted fields were not applied.', { unverified_ids: [id], ...(entity ? { observed: entity } : {}) });
            }
          }
          const graph = await graphVerification(ctx, entities, before, transferPayees, fresh => {
            const acknowledged = entities.find(e => e.id === fresh.id)!;
            const candidates = kind === 'create' ? intents.filter(intent => fieldsMatch(intent, acknowledged))
              : intents.filter(intent => kind === 'single' || intent.id === fresh.id);
            return candidates.some(intent => fieldsMatch(intent, fresh));
          });
          // Keep upstream wrappers. Add authoritative entities only when the acknowledgment omitted them.
          const data = { ...reply.data };
          if (kind !== 'single' && data.transaction === undefined && data.transactions === undefined && entities.length > 0) data.transactions = entities;
          return { data, ...graph, ...(graph.fetchedAt ?? observation.fetchedAt ? { fetchedAt: graph.fetchedAt ?? observation.fetchedAt } : {}) };
        },
      });
    };
  }
  return {
    ynab_create_transactions: handler('create'), ynab_update_transaction: handler('single'),
    ynab_update_transactions: handler('bulk'), ynab_set_transaction_approval: handler('approval'),
    ynab_categorize_transactions: handler('category'), ynab_delete_transaction: handler('delete'),
    ynab_import_transactions: handler('import'),
  };
}
