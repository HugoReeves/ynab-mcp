import type { ApiReply, CallContext, EntityRef, ErrorCode, HandlerMap, Json, JsonObject, Services, ToolHandler, WriteTarget } from '../contracts.js';
import { inputValidators, outputValidators } from '../catalog.js';
import { ToolFailure } from '../errors.js';
import { assertCalendarDate } from '../safety/dates.js';

function fail(code: ErrorCode, message: string, details?: JsonObject): never {
  throw new ToolFailure({ code, message, retryable: false, outcome: 'not_applied', ...(details ? { details } : {}) });
}
function object(value: Json | undefined): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function rows(value: Json | undefined): JsonObject[] {
  if (!Array.isArray(value) || !value.every(object)) fail('upstream_error', 'Expected complete category context.');
  return value;
}
function path(ctx: CallContext, ...parts: string[]): string {
  if (!ctx.planId) fail('plan_required', 'Select an explicit plan.');
  return `/plans/${encodeURIComponent(ctx.planId)}/${parts.map(encodeURIComponent).join('/')}`;
}
const cadence: Readonly<Record<string, number>> = { monthly: 1, weekly: 2, yearly: 13 };
const loanTypes = new Set(['mortgage', 'autoLoan', 'studentLoan', 'personalLoan', 'medicalDebt', 'otherDebt']);
const raceWarning = 'YNAB has no atomic compare-and-swap; changes after the final preflight remain possible.';
function paymentGroup(group: JsonObject | undefined, category?: JsonObject): boolean {
  return [group?.name, category?.category_group_name].some(name => typeof name === 'string' && /^credit card payments?$/i.test(name));
}
function usableGroup(group: JsonObject | undefined, warnings: string[], allowPayment = false): JsonObject {
  if (!group || group.deleted === true) fail('validation_error', 'Category group must exist and be non-deleted in this plan.');
  if (group.internal === true && !(allowPayment && paymentGroup(group))) fail('unsupported_operation', 'Internal category groups cannot be changed or used as destinations.');
  if (group.hidden === true) warnings.push('The category group is hidden.');
  return group;
}
function usableCategory(category: JsonObject, warnings: string[]): void {
  if (category.deleted === true) fail('not_found', 'Category is deleted.');
  if (category.internal === true) fail('unsupported_operation', 'Internal categories cannot be changed by these tools.');
  if (category.hidden === true) warnings.push('The category is hidden.');
}

/** Intent and response comparisons only. SafetyState owns policy, locking and revisions. */
export function createCategoryTools(services: Services): HandlerMap {
  const { state } = services;
  async function groups(ctx: CallContext): Promise<{ rows: JsonObject[]; source: ApiReply }> {
    const source = await state.get(ctx, path(ctx, 'categories'), undefined, true);
    if (!outputValidators.get('ynab_list_categories')!({ status: 'ok', data: source.data, meta: state.meta(ctx, source) })) fail('upstream_error', 'Incomplete category/group context.');
    return { rows: rows(source.data.category_groups), source };
  }
  async function accounts(ctx: CallContext): Promise<JsonObject[]> {
    const source = await state.get(ctx, path(ctx, 'accounts'), undefined, true);
    if (!outputValidators.get('ynab_list_accounts')!({ status: 'ok', data: source.data, meta: state.meta(ctx, source) })) fail('upstream_error', 'Incomplete account context for target validation.');
    return rows(source.data.accounts);
  }
  async function validateTargets(ctx: CallContext, intent: JsonObject, old: JsonObject | undefined, group: JsonObject, currentGroup?: JsonObject): Promise<string | undefined> {
    if (!Object.keys(intent).some(key => key.startsWith('goal_'))) return;
    const accountRows = await accounts(ctx);
    // The pinned Account has no category-link ID. DEBT is authoritative; matching names
    // are conservative restriction hints only, never a way to select an entity for writing.
    const names = [intent.name, old?.name].filter(name => typeof name === 'string');
    const confirmedLoan = old?.goal_type === 'DEBT';
    const loanHint = accountRows.some(a => a.deleted !== true && loanTypes.has(String(a.type)) && typeof a.name === 'string' && names.includes(a.name));
    const loan = confirmedLoan || loanHint;
    if (loanHint && !confirmedLoan && (old?.goal_type == null || typeof old?.goal_target !== 'number')) fail('unsupported_operation', 'A loan account name alone cannot establish the default target type for a missing target.');
    const credit = paymentGroup(group, old) || paymentGroup(currentGroup, old) || accountRows.some(a => a.deleted !== true && a.type === 'creditCard' && typeof a.name === 'string' && names.includes(a.name));
    if ('goal_frequency' in intent) {
      if (typeof intent.goal_target !== 'number' || 'goal_target_date' in intent) fail('validation_error', 'Frequency requires a non-null target amount and excludes target date.');
      if (loan || credit) fail('unsupported_operation', 'Recurring NEED targets are unsupported for loan and Credit Card Payment categories.');
    }
    if (loan && Object.keys(intent).some(key => key.startsWith('goal_') && key !== 'goal_target')) fail('unsupported_operation', 'Loan-linked targets support only target amount changes.');
    if (intent.goal_target === null && Object.keys(intent).some(key => key.startsWith('goal_') && key !== 'goal_target')) fail('validation_error', 'Target removal cannot be combined with other target settings.');
    if (typeof intent.goal_target_date === 'string') assertCalendarDate(intent.goal_target_date);
    if ('goal_needs_whole_amount' in intent) {
      if (intent.goal_needs_whole_amount === null) fail('unsupported_operation', 'Null NEED rollover has no verified mapping; use true or false.');
      const type = 'goal_frequency' in intent ? 'NEED' : old?.goal_type ?? (typeof intent.goal_target === 'number' ? 'NEED' : null);
      if (loan || credit || type !== 'NEED') fail('unsupported_operation', 'Rollover applies only to supported NEED targets.');
    }
    if (('goal_target_date' in intent || 'goal_needs_whole_amount' in intent) && typeof (intent.goal_target ?? old?.goal_target) !== 'number') fail('unsupported_operation', 'Target settings require an existing or supplied non-null target amount.');
    if (intent.goal_target === null) return;
    if ('goal_frequency' in intent) return 'NEED';
    if (typeof old?.goal_type === 'string') return old.goal_type;
    // Only authoritative context selects a default; account-name hints restrict only.
    return confirmedLoan ? 'DEBT' : paymentGroup(group, old) || paymentGroup(currentGroup, old) ? 'MF' : 'NEED';
  }
  function matches(intent: JsonObject, observed: JsonObject, expectedTargetType?: string): boolean {
    if (observed.deleted === true || observed.internal === true) return false;
    for (const [key, value] of Object.entries(intent)) {
      if (key === 'goal_frequency') {
        if (observed.goal_type !== 'NEED' || observed.goal_cadence !== cadence[String(value)] || observed.goal_cadence_frequency !== 1) return false;
      } else if (key === 'goal_target' && value === null) {
        if (observed.goal_target != null || observed.goal_type != null) return false;
      } else if ((observed[key] ?? null) !== value) return false;
    }
    if (typeof intent.goal_target === 'number' && observed.goal_type == null) return false;
    if (expectedTargetType !== undefined && observed.goal_type !== expectedTargetType) return false;
    if ('goal_needs_whole_amount' in intent && (observed.goal_type !== 'NEED' || typeof observed.goal_target !== 'number')) return false;
    return true;
  }
  type Kind = 'createGroup' | 'updateGroup' | 'createCategory' | 'updateCategory' | 'assignment';
  function handler(kind: Kind): ToolHandler {
    return async (args, ctx) => {
      if (!inputValidators.get(ctx.tool.name)!(args)) fail('validation_error', 'Invalid category arguments.');
      const isGroup = kind === 'createGroup' || kind === 'updateGroup';
      const create = kind === 'createGroup' || kind === 'createCategory';
      const id = isGroup ? args.category_group_id : args.category_id;
      const ref: EntityRef | undefined = create ? undefined : kind === 'assignment'
        ? { kind: 'category_assignment', id: String(id), month: String(args.month) }
        : { kind: isGroup ? 'category_group' : 'category', id: String(id) };
      if (kind === 'assignment') assertCalendarDate(String(args.month));
      const targets: WriteTarget[] = ref ? [{ ref, ...(typeof args.expected_revision === 'string' ? { expectedRevision: args.expected_revision } : {}) }] : [];
      const field = isGroup ? 'category_group' : 'category';
      const intent: JsonObject = isGroup ? { name: args.name! } : kind === 'createCategory' ? { ...(args.category as JsonObject) }
        : kind === 'updateCategory' ? { ...(args.changes as JsonObject) } : { budgeted: args.budgeted! };
      let initialIds = new Set<string>();
      let expectedTargetType: string | undefined;
      return state.write(ctx, args, {
        targets,
        async prepare(before) {
          const warnings = [raceWarning];
          const snapshot = await groups(ctx);
          initialIds = new Set((isGroup ? snapshot.rows : snapshot.rows.flatMap(g => rows(g.categories))).map(row => String(row.id)));
          const old = before[0]?.entity;
          if (isGroup) {
            if (old) usableGroup(old, warnings);
          } else {
            if (old) {
              usableCategory(old, warnings);
              usableGroup(snapshot.rows.find(g => g.id === old.category_group_id), warnings, true);
            }
            const destination = snapshot.rows.find(g => g.id === (intent.category_group_id ?? old?.category_group_id));
            const group = usableGroup(destination, warnings, !('category_group_id' in intent));
            if (kind !== 'assignment') expectedTargetType = await validateTargets(ctx, intent, old, group, snapshot.rows.find(g => g.id === old?.category_group_id));
          }
          const endpoint = isGroup ? path(ctx, 'category_groups', ...(create ? [] : [String(id)]))
            : kind === 'assignment' ? path(ctx, 'months', String(args.month), 'categories', String(id))
            : path(ctx, 'categories', ...(create ? [] : [String(id)]));
          return { method: create ? 'POST' : 'PATCH', path: endpoint, body: { [field]: intent }, warnings: [...new Set(warnings)],
            unknownEffects: false, setsReconciled: false, usesImportId: false,
            ...(kind === 'assignment' ? { resolvedMonth: String(args.month) } : {}) };
        },
        async verify(reply) {
          let observed: JsonObject;
          let fetchedAt = reply.fetchedAt;
          let knowledge: Json | undefined = reply.data.server_knowledge;
          if (reply.data[field] !== undefined) {
            if (!object(reply.data[field])) fail('verification_failed', 'Save acknowledgment has an invalid entity.');
            observed = reply.data[field];
          } else if (ref) {
            const fresh = await state.inspect(ctx, ref);
            observed = fresh.entity; fetchedAt = fresh.source.fetchedAt;
            knowledge ??= fresh.source.data.server_knowledge;
          } else {
            // Save schemas have no separate ID field. A missing create entity requires a
            // unique newly observed match in a fresh full collection, never a name selection.
            const fresh = await groups(ctx);
            const candidates = (isGroup ? fresh.rows : fresh.rows.flatMap(g => rows(g.categories)))
              .filter(row => !initialIds.has(String(row.id)) && matches(intent, row, expectedTargetType));
            if (candidates.length !== 1) fail('verification_failed', 'Create acknowledgment lacks a unique new entity.', { observed: candidates });
            observed = candidates[0]!; fetchedAt = fresh.source.fetchedAt; knowledge ??= fresh.source.data.server_knowledge;
          }
          if ((!create && observed.id !== id) || (create && initialIds.has(String(observed.id))) || !matches(intent, observed, expectedTargetType)) fail('verification_failed', 'Acknowledged category fields differ from intended effects.', { observed });
          if (knowledge === undefined) {
            const fresh = await groups(ctx); knowledge = fresh.source.data.server_knowledge;
          }
          const data: JsonObject = { ...reply.data, [field]: observed, server_knowledge: knowledge! };
          if (!outputValidators.get(ctx.tool.name)!({ status: 'ok', data, meta: state.meta(ctx) })) fail('verification_failed', 'Verified save response does not match the catalog.', { observed });
          const verifiedRef: EntityRef = ref ?? { kind: isGroup ? 'category_group' : 'category', id: String(observed.id) };
          const key = verifiedRef.kind === 'category_assignment' ? `category:${verifiedRef.id}:${verifiedRef.month}` : `${verifiedRef.kind}:${verifiedRef.id}`;
          return { data, warnings: [], fetchedAt, revisions: { [key]: state.revision(ctx, verifiedRef, observed) } };
        },
      });
    };
  }
  return {
    ynab_create_category_group: handler('createGroup'), ynab_update_category_group: handler('updateGroup'),
    ynab_create_category: handler('createCategory'), ynab_update_category: handler('updateCategory'),
    ynab_set_category_assignment: handler('assignment'),
  };
}
