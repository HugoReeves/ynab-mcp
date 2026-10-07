import type { ApiRequest, Config, JsonObject, Services, YnabApi } from '../../src/contracts.js';
import { createSafetyState } from '../../src/safety/index.js';
import { createDispatcher } from '../../src/runtime/dispatcher.js';
import { createCategoryTools } from '../../src/tools/categories.js';

export const plan = '11111111-1111-4111-8111-111111111111';
export const groupId = '22222222-2222-4222-8222-222222222222';
export const categoryId = '33333333-3333-4333-8333-333333333333';
export const newId = '44444444-4444-4444-8444-444444444444';
export const otherGroupId = '55555555-5555-4555-8555-555555555555';
export const month = '2026-10-01';
export const root = `/plans/${plan}`;
export const baseCategory: JsonObject = {
  id: categoryId, name: 'Groceries', category_group_id: groupId, category_group_name: 'Living',
  hidden: false, internal: false, deleted: false, note: 'Keep this note',
  budgeted: 10000, activity: -2000, balance: 8000,
  goal_type: 'NEED', goal_target: 25000, goal_target_date: null,
  goal_needs_whole_amount: false, goal_cadence: 1, goal_cadence_frequency: 1,
};
export const baseGroup: JsonObject = {
  id: groupId, name: 'Living', hidden: false, internal: false, deleted: false,
};
// Representative pinned 1.87.0 read-side comparisons. There is no read goal_frequency.
export const frequencyResponses: Record<string, JsonObject> = {
  monthly: { goal_type: 'NEED', goal_target: 42000, goal_cadence: 1, goal_cadence_frequency: 1 },
  weekly: { goal_type: 'NEED', goal_target: 42000, goal_cadence: 2, goal_cadence_frequency: 1 },
  yearly: { goal_type: 'NEED', goal_target: 42000, goal_cadence: 13, goal_cadence_frequency: 1 },
};

export function fixture(overrides: Partial<Config> = {}) {
  const config: Config = {
    defaultPlanId: plan, allowedPlanIds: [plan], readOnly: false, allowDeletes: false,
    allowImports: false, allowReconciledChanges: false, toolProfile: 'extended',
    timeoutMs: 20000, cacheTtlSeconds: 30, logLevel: 'error', ...overrides,
  };
  const category = structuredClone(baseCategory);
  const assignment: JsonObject = { ...structuredClone(baseCategory), budgeted: 7000, balance: 5000 };
  const groups = [structuredClone(baseGroup), { ...structuredClone(baseGroup), id: otherGroupId, name: 'Other' }];
  const categories = [category];
  const accounts: JsonObject[] = [];
  const requests: ApiRequest[] = [];
  const controls = {
    omitEntity: false, mismatch: false, missingCreated: false,
    transform: undefined as ((row: JsonObject) => void) | undefined,
    getOverride: undefined as ((request: ApiRequest) => JsonObject | undefined) | undefined,
  };
  const list = (): JsonObject => ({ category_groups: groups.map(g => ({ ...g, categories: categories.filter(c => c.category_group_id === g.id) })), server_knowledge: 1 });
  const api: YnabApi = { async request(_ctx, request) {
    requests.push(structuredClone(request));
    let data: JsonObject;
    if (request.method === 'GET') {
      const override = controls.getOverride?.(request);
      if (override) data = override;
      else if (request.path === `${root}/categories`) data = list();
      else if (request.path === `${root}/accounts`) data = { accounts, server_knowledge: 1 };
      else if (request.path === `${root}/months/${month}/categories/${categoryId}`) data = { category: assignment };
      else if (request.path.startsWith(`${root}/categories/`)) {
        const row = categories.find(c => c.id === request.path.split('/').at(-1));
        if (!row) throw new Error('Unexpected category detail ID');
        data = { category: row };
      } else throw new Error(`Unexpected read: ${request.path}`);
    } else {
      const isGroup = request.path.includes('/category_groups');
      const intent = (request.body![isGroup ? 'category_group' : 'category']) as JsonObject;
      let row: JsonObject;
      if (request.method === 'POST') {
        row = isGroup ? { ...baseGroup, id: newId } : { ...baseCategory, id: newId, goal_type: null, goal_target: null };
        if (!controls.missingCreated) (isGroup ? groups : categories).push(row);
      } else row = isGroup ? groups[0]! : request.path.includes('/months/') ? assignment : category;
      const direct = { ...intent }; delete direct.goal_frequency;
      Object.assign(row, direct);
      if (intent.goal_frequency) Object.assign(row, frequencyResponses[String(intent.goal_frequency)]);
      if (intent.goal_target === null) Object.assign(row, { goal_type: null, goal_target: null });
      else if (typeof intent.goal_target === 'number' && row.goal_type === null) row.goal_type = 'NEED';
      controls.transform?.(row);
      if (controls.mismatch) row[isGroup ? 'name' : 'budgeted' in intent ? 'budgeted' : 'name'] = isGroup || !('budgeted' in intent) ? 'Wrong' : 99;
      data = { server_knowledge: 2, ...(controls.omitEntity ? {} : { [isGroup ? 'category_group' : 'category']: row }) };
    }
    return { data: structuredClone(data), fetchedAt: '2026-10-07T00:00:00.000Z' };
  } };
  const clock = { now: () => Date.UTC(2026, 9, 7) };
  const services: Services = { config, api, clock, state: createSafetyState(config, api, clock) };
  const handlers = createCategoryTools(services);
  const dispatcher = createDispatcher(services, handlers);
  return { services, handlers, dispatcher, requests, category, assignment, groups, categories, accounts, controls,
    mutations: () => requests.filter(r => r.method !== 'GET') };
}
