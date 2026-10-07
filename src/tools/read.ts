import { catalog, outputValidators } from '../catalog.js';
import type { ApiRequest, CallContext, EntityRef, HandlerMap, JsonObject, OkResult, ResolvedScope, Services, ToolHandler, ToolName } from '../contracts.js';
import { ToolFailure } from '../errors.js';
import { assertCalendarDate, oneYearAgo, resolveReadMonth } from '../safety/dates.js';
import { planPath } from '../ynab/client.js';

function fail(message: string): never {
  throw new ToolFailure({ code: 'validation_error', message, retryable: false, outcome: 'not_applied' });
}
const pendingWarning = 'Pending bank transactions are excluded by YNAB.';
const deltaWarning = 'Delta contains changed entities and tombstones, not a complete snapshot. Apply every page before committing server_knowledge; retain separate tokens for each exact endpoint/filter/date window.';

/** Local paging delegates to the shared frozen snapshot store. All date resolution
 * and normalization deliberately live inside fetchFirst, never on continuation. */
export function createReadTools({ config, state, clock }: Services): HandlerMap {
  const handlers: Partial<Record<ToolName, ToolHandler>> = {};
  for (const tool of catalog.filter(t => t.annotations.readOnlyHint)) {
    handlers[tool.name] = async (args, ctx) => {
      const fetchFirst = async (): Promise<OkResult> => {
        const name = tool.name;
        const scoped = (...segments: string[]): string => {
          if (!ctx.planId) throw new ToolFailure({ code: 'plan_required', message: 'Select an explicit plan.', retryable: false, outcome: 'not_applied' });
          return planPath(ctx.planId, ...segments);
        };
        const readMonth = (value: string): string => resolveReadMonth(value, clock.now());
        let path = ''; // Revision-bearing detail routes are owned by inspect.
        let query: Record<string, string | number | boolean> = {};
        let month: string | undefined;
        let scope: ResolvedScope | undefined;
        let since: string | undefined;
        let until: string | undefined;
        let ref: EntityRef | undefined;
        switch (name) {
          case 'ynab_get_user': path = '/user'; break;
          case 'ynab_list_plans': path = '/plans'; query.include_accounts = args.include_accounts as boolean | undefined ?? false; break;
          case 'ynab_get_plan_settings': path = scoped('settings'); break;
          case 'ynab_get_account': path = scoped('accounts', args.account_id as string); break;
          case 'ynab_get_month': month = readMonth(args.month as string); path = scoped('months', month); break;
          case 'ynab_get_category':
            if (args.month !== undefined) {
              month = readMonth(args.month as string);
              ref = { kind: 'category_assignment', id: args.category_id as string, month };
              path = scoped('months', month, 'categories', ref.id);
            } else { ref = { kind: 'category', id: args.category_id as string }; path = scoped('categories', ref.id); }
            break;
          case 'ynab_get_payee': ref = { kind: 'payee', id: args.payee_id as string }; path = scoped('payees', ref.id); break;
          case 'ynab_get_transaction': ref = { kind: 'transaction', id: args.transaction_id as string }; break;
          case 'ynab_get_scheduled_transaction': ref = { kind: 'scheduled_transaction', id: args.scheduled_transaction_id as string }; path = scoped('scheduled_transactions', ref.id); break;
          case 'ynab_list_transactions': {
            scope = structuredClone(args.scope ?? { kind: 'plan' }) as ResolvedScope;
            switch (scope.kind) {
              case 'plan': path = scoped('transactions'); break;
              case 'account': path = scoped('accounts', scope.account_id, 'transactions'); break;
              case 'category': path = scoped('categories', scope.category_id, 'transactions'); break;
              case 'payee': path = scoped('payees', scope.payee_id, 'transactions'); break;
              case 'month': month = readMonth(scope.month); scope.month = month; path = scoped('months', month, 'transactions'); break;
            }
            since = args.since_date as string | undefined ?? (scope.kind === 'month' ? undefined : oneYearAgo(clock.now()));
            until = args.until_date as string | undefined;
            if (since !== undefined) { assertCalendarDate(since); query.since_date = since; }
            if (until !== undefined) { assertCalendarDate(until); query.until_date = until; }
            if (since && until && since > until) fail('since_date must not exceed until_date.');
            if (month && ((since && since.slice(0, 7) > month.slice(0, 7)) || (until && until < month))) fail('Date window does not intersect the selected month.');
            if (args.type !== undefined) query.type = args.type as string;
            break;
          }
          case 'ynab_list_money_movements':
          case 'ynab_list_money_movement_groups': {
            const collection = name === 'ynab_list_money_movements' ? 'money_movements' : 'money_movement_groups';
            if (args.month !== undefined) { month = readMonth(args.month as string); path = scoped('months', month, collection); }
            else path = scoped(collection);
            break;
          }
          default: {
            const collection = name === 'ynab_list_categories' ? 'categories' : name.slice('ynab_list_'.length);
            path = scoped(collection);
          }
        }
        const delta = args.last_knowledge_of_server !== undefined;
        if (delta) query.last_knowledge_of_server = args.last_knowledge_of_server as number;
        const inspection = ref ? await state.inspect(ctx, ref) : undefined;
        const source = inspection?.source ?? await state.get(ctx, path, Object.keys(query).length ? query as ApiRequest['query'] : undefined);
        const result: OkResult = { status: 'ok', data: structuredClone(source.data), meta: state.meta(ctx, source) };
        if (tool.pageCollection) result.meta.mode = delta ? 'delta' : 'snapshot';
        if (delta) result.meta.warnings.push(deltaWarning);
        if (delta && name === 'ynab_list_transactions' && args.type !== undefined) result.meta.warnings.push('Rows exiting the type filter may be omitted from this delta; a full refresh without a knowledge token is required to maintain a complete filtered view.');
        if (name === 'ynab_list_transactions' || name === 'ynab_get_transaction') result.meta.warnings.push(pendingWarning);
        if (month) result.meta.resolved_month = month;
        if (scope) result.meta.resolved_scope = scope;
        if (since) result.meta.resolved_since_date = since;
        if (until) result.meta.resolved_until_date = until;
        if (inspection) result.meta.revisions = { [inspection.revisionKey]: inspection.revision };
        // Validate complete sources before deriving any group revision or paging.
        validate(ctx, result);
        if (name === 'ynab_list_plans' && config.allowedPlanIds !== null) {
          const allowed = (row: JsonObject): boolean => config.allowedPlanIds!.includes(row.id as string);
          result.data.plans = (result.data.plans as JsonObject[]).filter(allowed);
          const defaultPlan = result.data.default_plan as JsonObject | null | undefined;
          if (defaultPlan && !allowed(defaultPlan)) result.data.default_plan = null;
        }
        if (name === 'ynab_list_categories' && !delta) {
          result.meta.revisions = Object.fromEntries((result.data.category_groups as JsonObject[]).map(group => [
            `category_group:${group.id as string}`, state.revision(ctx, { kind: 'category_group', id: group.id as string }, group),
          ]));
        }
        return result;
      };
      return tool.pageCollection ? state.page(ctx, args, tool.pageCollection, fetchFirst) : fetchFirst();
    };
  }
  return handlers;
}
function validate(ctx: CallContext, result: OkResult): void {
  if (!outputValidators.get(ctx.tool.name)!(result)) throw new ToolFailure({ code: 'upstream_error', message: 'Incomplete read response.', retryable: false, outcome: 'not_applied' });
}
