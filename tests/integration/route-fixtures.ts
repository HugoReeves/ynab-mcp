import type { ApiRequest, Config, JsonObject, ToolName, YnabApi } from '../../src/contracts.js';

// Synthetic IDs only. Routes/body expectations are transcribed from pinned 1.87.0
// OpenAPI paths + wrapper schemas and proposal Appendix 3 adapter policies.
// Deliberately no catalog.upstream, production route builders, or fake SafetyState.
export const ids = {
  plan: '10000000-0000-4000-8000-000000000001',
  account: '20000000-0000-4000-8000-000000000001',
  category: '30000000-0000-4000-8000-000000000001',
  group: '40000000-0000-4000-8000-000000000001',
  payee: '50000000-0000-4000-8000-000000000001',
  schedule: '60000000-0000-4000-8000-000000000001',
  transaction: 'synthetic-transaction',
};
export const base = `/plans/${ids.plan}`;
export const month = '2026-01-01';
export const clock = { now: () => Date.parse('2026-01-15T12:00:00.000Z') };
export const config: Config = {
  defaultPlanId: ids.plan, allowedPlanIds: [ids.plan], readOnly: false,
  allowDeletes: true, allowImports: true, allowReconciledChanges: false,
  toolProfile: 'extended', timeoutMs: 10000, cacheTtlSeconds: 0, logLevel: 'error',
};
export interface RouteCase {
  name: ToolName; args: JsonObject; request: ApiRequest;
  // Detail route that must be fetched freshly for existing-entity mutations.
  target?: string;
  batch?: boolean;
}
const read = (name: ToolName, args: JsonObject, path: string, query?: ApiRequest['query']): RouteCase =>
  ({ name, args, request: { method: 'GET', path, ...(query ? { query } : {}) } });
export const reads: RouteCase[] = [
  read('ynab_get_user', {}, '/user'),
  read('ynab_list_plans', { include_accounts: true }, '/plans', { include_accounts: true }),
  read('ynab_get_plan_settings', {}, `${base}/settings`),
  read('ynab_list_accounts', { last_knowledge_of_server: 7 }, `${base}/accounts`, { last_knowledge_of_server: 7 }),
  read('ynab_get_account', { account_id: ids.account }, `${base}/accounts/${ids.account}`),
  read('ynab_list_categories', { last_knowledge_of_server: 7 }, `${base}/categories`, { last_knowledge_of_server: 7 }),
  read('ynab_get_category', { category_id: ids.category }, `${base}/categories/${ids.category}`),
  read('ynab_list_months', { last_knowledge_of_server: 7 }, `${base}/months`, { last_knowledge_of_server: 7 }),
  read('ynab_get_month', { month }, `${base}/months/${month}`),
  read('ynab_list_payees', { last_knowledge_of_server: 7 }, `${base}/payees`, { last_knowledge_of_server: 7 }),
  read('ynab_get_payee', { payee_id: ids.payee }, `${base}/payees/${ids.payee}`),
  read('ynab_list_transactions', { since_date: '2026-01-01', until_date: '2026-01-15', type: 'unapproved', last_knowledge_of_server: 7 }, `${base}/transactions`, { since_date: '2026-01-01', until_date: '2026-01-15', type: 'unapproved', last_knowledge_of_server: 7 }),
  read('ynab_get_transaction', { transaction_id: ids.transaction }, `${base}/transactions/${ids.transaction}`),
  read('ynab_list_scheduled_transactions', { last_knowledge_of_server: 7 }, `${base}/scheduled_transactions`, { last_knowledge_of_server: 7 }),
  read('ynab_get_scheduled_transaction', { scheduled_transaction_id: ids.schedule }, `${base}/scheduled_transactions/${ids.schedule}`),
  read('ynab_list_money_movements', { month }, `${base}/months/${month}/money_movements`),
  read('ynab_list_money_movement_groups', { month }, `${base}/months/${month}/money_movement_groups`),
];
export const selectorReads: RouteCase[] = [
  read('ynab_get_category', { category_id: ids.category, month }, `${base}/months/${month}/categories/${ids.category}`),
  ...([
    ['account', 'accounts', ids.account], ['category', 'categories', ids.category],
    ['payee', 'payees', ids.payee], ['month', 'months', month],
  ] as const).map(([kind, collection, id]) => read('ynab_list_transactions', {
    scope: { kind, [kind === 'month' ? 'month' : `${kind}_id`]: id }, since_date: month,
  }, `${base}/${collection}/${id}/transactions`, { since_date: month })),
  read('ynab_list_money_movements', {}, `${base}/money_movements`),
  read('ynab_list_money_movement_groups', {}, `${base}/money_movement_groups`),
];
const txPath = `${base}/transactions/${ids.transaction}`;
const schedulePath = `${base}/scheduled_transactions/${ids.schedule}`;
const schedule: JsonObject = { account_id: ids.account, date: '2026-02-01', amount: -1000, frequency: 'monthly', category_id: ids.category, payee_id: ids.payee, memo: 'Synthetic schedule' };
const newTx: JsonObject = { account_id: ids.account, date: '2026-01-10', amount: -1000, category_id: ids.category, payee_id: ids.payee, memo: 'Synthetic create' };
const write = (name: ToolName, args: JsonObject, method: ApiRequest['method'], path: string, body?: JsonObject, target?: string, batch = false): RouteCase =>
  ({ name, args, request: { method, path, ...(body ? { body } : {}) }, ...(target ? { target } : {}), batch });
export const writes: RouteCase[] = [
  write('ynab_create_transactions', { transactions: [newTx] }, 'POST', `${base}/transactions`, { transactions: [{ ...newTx, approved: false, cleared: 'uncleared' }] }),
  write('ynab_update_transaction', { transaction_id: ids.transaction, changes: { memo: 'Changed' } }, 'PUT', txPath, { transaction: { memo: 'Changed' } }, txPath),
  write('ynab_update_transactions', { transactions: [{ id: ids.transaction, changes: { memo: 'Bulk changed' } }] }, 'PATCH', `${base}/transactions`, { transactions: [{ id: ids.transaction, memo: 'Bulk changed' }] }, txPath, true),
  write('ynab_set_transaction_approval', { transactions: [{ id: ids.transaction }], approved: true }, 'PATCH', `${base}/transactions`, { transactions: [{ id: ids.transaction, approved: true }] }, txPath, true),
  write('ynab_categorize_transactions', { transactions: [{ id: ids.transaction }], category_id: null }, 'PATCH', `${base}/transactions`, { transactions: [{ id: ids.transaction, category_id: null }] }, txPath, true),
  write('ynab_delete_transaction', { transaction_id: ids.transaction, confirm_delete: true }, 'DELETE', txPath, undefined, txPath),
  write('ynab_import_transactions', {}, 'POST', `${base}/transactions/import`),
  write('ynab_create_scheduled_transaction', { scheduled_transaction: schedule }, 'POST', `${base}/scheduled_transactions`, { scheduled_transaction: schedule }),
  write('ynab_update_scheduled_transaction', { scheduled_transaction_id: ids.schedule, scheduled_transaction: schedule }, 'PUT', schedulePath, { scheduled_transaction: { ...schedule, flag_color: null } }, schedulePath),
  write('ynab_delete_scheduled_transaction', { scheduled_transaction_id: ids.schedule, confirm_delete: true }, 'DELETE', schedulePath, undefined, schedulePath),
  write('ynab_create_account', { account: { name: 'Synthetic cash', type: 'cash', balance: 0 } }, 'POST', `${base}/accounts`, { account: { name: 'Synthetic cash', type: 'cash', balance: 0 } }),
  write('ynab_create_payee', { name: 'Synthetic new payee' }, 'POST', `${base}/payees`, { payee: { name: 'Synthetic new payee' } }),
  write('ynab_update_payee', { payee_id: ids.payee, name: 'Renamed' }, 'PATCH', `${base}/payees/${ids.payee}`, { payee: { name: 'Renamed' } }, `${base}/payees/${ids.payee}`),
  write('ynab_create_category_group', { name: 'Synthetic new group' }, 'POST', `${base}/category_groups`, { category_group: { name: 'Synthetic new group' } }),
  write('ynab_update_category_group', { category_group_id: ids.group, name: 'Renamed group' }, 'PATCH', `${base}/category_groups/${ids.group}`, { category_group: { name: 'Renamed group' } }, `${base}/categories`),
  write('ynab_create_category', { category: { name: 'Synthetic new category', category_group_id: ids.group } }, 'POST', `${base}/categories`, { category: { name: 'Synthetic new category', category_group_id: ids.group } }),
  write('ynab_update_category', { category_id: ids.category, changes: { note: 'Changed note' } }, 'PATCH', `${base}/categories/${ids.category}`, { category: { note: 'Changed note' } }, `${base}/categories/${ids.category}`),
  write('ynab_set_category_assignment', { category_id: ids.category, month, budgeted: 2000 }, 'PATCH', `${base}/months/${month}/categories/${ids.category}`, { category: { budgeted: 2000 } }, `${base}/months/${month}/categories/${ids.category}`),
];

// Small ledger applies the *observed* request, never the expected RouteCase.
// Assumptions: each test owns a fresh ledger; batches have one ordinary target;
// category/group creates receive fresh synthetic IDs; other creates use fixture IDs;
// bank import succeeds with zero imports.
// Empty money-history arrays intentionally avoid exhaustive upstream row tests.
// Unknown routes fail loudly rather than masking a handler routing mistake.
export class Ledger implements YnabApi {
  readonly requests: ApiRequest[] = [];
  private knowledge = 8;
  private nextCreatedId = 2;
  private createdGroups: JsonObject[] = [];
  private createdCategories: JsonObject[] = [];
  private freshId(prefix: string): string {
    return `${prefix}-0000-4000-8000-${String(this.nextCreatedId++).padStart(12, '0')}`;
  }
  private account: JsonObject = { id: ids.account, name: 'Synthetic checking', type: 'checking', on_budget: true, closed: false, deleted: false, balance: 0, cleared_balance: 0, uncleared_balance: 0, transfer_payee_id: null };
  private payee: JsonObject = { id: ids.payee, name: 'Synthetic payee', deleted: false, transfer_account_id: null };
  private category: JsonObject = { id: ids.category, category_group_id: ids.group, name: 'Synthetic category', hidden: false, internal: false, deleted: false, note: null, budgeted: 0, activity: -1000, balance: -1000, goal_type: null };
  private group: JsonObject = { id: ids.group, name: 'Synthetic group', hidden: false, internal: false, deleted: false };
  private transaction: JsonObject = { id: ids.transaction, account_id: ids.account, account_name: 'Synthetic checking', date: '2026-01-10', amount: -1000, memo: 'Original', cleared: 'uncleared', approved: false, deleted: false, payee_id: ids.payee, category_id: ids.category, transfer_account_id: null, transfer_transaction_id: null, matched_transaction_id: null, import_id: null, flag_color: null, subtransactions: [] };
  private scheduled: JsonObject = { id: ids.schedule, account_id: ids.account, account_name: 'Synthetic checking', date_first: '2026-02-01', date_next: '2026-02-01', amount: -1000, frequency: 'monthly', deleted: false, payee_id: ids.payee, category_id: ids.category, memo: 'Original schedule', flag_color: null, transfer_account_id: null, subtransactions: [] };
  async request(_ctx: Parameters<YnabApi['request']>[0], request: ApiRequest) {
    if (this.requests.length >= 100) throw new Error('Fixture request bound exceeded');
    this.requests.push(structuredClone(request));
    const data = request.method === 'GET' ? this.get(request.path) : this.mutate(request);
    return { data: structuredClone(data), fetchedAt: new Date(clock.now()).toISOString() };
  }
  private get(path: string): JsonObject {
    const k = { server_knowledge: this.knowledge };
    if (path === '/user') return { user: { id: ids.plan } };
    if (path === '/plans') return { plans: [{ id: ids.plan, name: 'Synthetic plan', accounts: [this.account] }], default_plan: null };
    if (path === `${base}/settings`) return { settings: { date_format: { format: 'YYYY-MM-DD' }, currency_format: null } };
    if (path === `${base}/accounts`) return { accounts: [this.account], ...k };
    if (path === `${base}/accounts/${ids.account}`) return { account: this.account, ...k };
    if (path === `${base}/categories`) return { category_groups: [this.group, ...this.createdGroups].map(group => ({
      ...group, categories: [this.category, ...this.createdCategories].filter(category => category.category_group_id === group.id),
    })), ...k };
    const createdCategory = this.createdCategories.find(category => path === `${base}/categories/${category.id as string}`);
    if (createdCategory) return { category: createdCategory, ...k };
    const createdGroup = this.createdGroups.find(group => path === `${base}/category_groups/${group.id as string}`);
    if (createdGroup) return { category_group: createdGroup, ...k };
    if (path === `${base}/categories/${ids.category}` || path === `${base}/months/${month}/categories/${ids.category}`) return { category: this.category, ...k };
    if (path === `${base}/category_groups/${ids.group}`) return { category_group: this.group, ...k };
    if (path === `${base}/payees`) return { payees: [this.payee], ...k };
    if (path === `${base}/payees/${ids.payee}`) return { payee: this.payee, ...k };
    const monthData = { month, income: 0, budgeted: 0, activity: -1000, to_be_budgeted: 0, deleted: false };
    if (path === `${base}/months`) return { months: [monthData], ...k };
    if (path === `${base}/months/${month}`) return { month: { ...monthData, categories: [this.category] }, ...k };
    if ([`${base}/transactions`, `${base}/accounts/${ids.account}/transactions`, `${base}/categories/${ids.category}/transactions`, `${base}/payees/${ids.payee}/transactions`, `${base}/months/${month}/transactions`].includes(path)) return { transactions: [this.transaction], ...k };
    if (path === txPath) return { transaction: this.transaction, ...k };
    if (path === `${base}/scheduled_transactions`) return { scheduled_transactions: [this.scheduled], ...k };
    if (path === schedulePath) return { scheduled_transaction: this.scheduled, ...k };
    for (const collection of ['money_movements', 'money_movement_groups']) {
      if (path === `${base}/${collection}` || path === `${base}/months/${month}/${collection}`) return { [collection]: [], ...k };
    }
    throw new Error(`Unexpected fixture GET ${path}`);
  }
  private mutate(request: ApiRequest): JsonObject {
    const { method, path, body } = request;
    this.knowledge++;
    const k = { server_knowledge: this.knowledge };
    if (path === `${base}/transactions/import` && method === 'POST') return { transaction_ids: [] };
    if (path === `${base}/transactions` && (method === 'POST' || method === 'PATCH')) {
      const rows = body?.transactions as JsonObject[];
      if (!Array.isArray(rows)) throw new Error('Missing fixture transactions');
      this.transaction = { ...this.transaction, ...rows[0], id: ids.transaction };
      return { transactions: [this.transaction], transaction_ids: [ids.transaction], duplicate_import_ids: [], ...k };
    }
    if (path === txPath && (method === 'PUT' || method === 'DELETE')) {
      this.transaction = { ...this.transaction, ...(body?.transaction as JsonObject ?? {}), ...(method === 'DELETE' ? { deleted: true } : {}) };
      return { transaction: this.transaction, ...k };
    }
    if ((path === schedulePath || path === `${base}/scheduled_transactions`) && ['POST', 'PUT', 'DELETE'].includes(method)) {
      const fields = body?.scheduled_transaction as JsonObject | undefined;
      this.scheduled = { ...this.scheduled, ...fields, ...(fields ? { date_next: fields.date } : {}), ...(method === 'DELETE' ? { deleted: true } : {}) };
      delete this.scheduled.date;
      return { scheduled_transaction: this.scheduled, ...k };
    }
    if (path === `${base}/accounts` && method === 'POST') {
      this.account = { ...this.account, ...(body?.account as JsonObject) }; return { account: this.account, ...k };
    }
    if ((path === `${base}/payees` && method === 'POST') || (path === `${base}/payees/${ids.payee}` && method === 'PATCH')) {
      this.payee = { ...this.payee, ...(body?.payee as JsonObject) }; return { payee: this.payee, ...k };
    }
    if (path === `${base}/category_groups` && method === 'POST') {
      const group = { ...this.group, ...(body?.category_group as JsonObject), id: this.freshId('40000000') };
      this.createdGroups.push(group);
      return { category_group: group, ...k };
    }
    if (path === `${base}/category_groups/${ids.group}` && method === 'PATCH') {
      this.group = { ...this.group, ...(body?.category_group as JsonObject) }; return { category_group: this.group, ...k };
    }
    if (path === `${base}/categories` && method === 'POST') {
      const category = { ...this.category, ...(body?.category as JsonObject), id: this.freshId('30000000') };
      this.createdCategories.push(category);
      return { category, ...k };
    }
    if ([`${base}/categories/${ids.category}`, `${base}/months/${month}/categories/${ids.category}`].includes(path) && method === 'PATCH') {
      this.category = { ...this.category, ...(body?.category as JsonObject) }; return { category: this.category, ...k };
    }
    throw new Error(`Unexpected fixture mutation ${method} ${path}`);
  }
}

export function liveArgs(test: RouteCase, revisions: Record<string, string>): JsonObject {
  const args = structuredClone(test.args);
  args.dry_run = false;
  if (test.target) {
    // Single-target cases only; the test asserts exactly one revision entry.
    const revision = Object.values(revisions)[0];
    if (!revision) throw new Error('Missing fresh preview revision');
    if (test.batch) args.transactions = (args.transactions as JsonObject[]).map(row => ({ ...row, expected_revision: revision }));
    else args.expected_revision = revision;
  }
  return args;
}
