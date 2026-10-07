import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { inputValidators, outputValidators } from '../../src/catalog.js';
import type { Config, JsonObject, Services, ToolName, YnabApi } from '../../src/contracts.js';
import { createDispatcher } from '../../src/runtime/dispatcher.js';
import { createSafetyState } from '../../src/safety/index.js';

const id = '11111111-1111-4111-8111-111111111111';
const schedule = { account_id: id, date: '2026-10-08', amount: -1000, frequency: 'monthly' };
// Explicit stream inventory, not derived from whichever handlers happen to exist.
const inputs: [ToolName, JsonObject][] = [
  ['ynab_create_scheduled_transaction', { scheduled_transaction: schedule }],
  ['ynab_update_scheduled_transaction', { scheduled_transaction_id: id, scheduled_transaction: schedule }],
  ['ynab_delete_scheduled_transaction', { scheduled_transaction_id: id }],
  ['ynab_create_account', { account: { name: 'Fixture', type: 'checking', balance: 0 } }],
  ['ynab_create_payee', { name: 'Fixture' }],
  ['ynab_update_payee', { payee_id: id, name: 'Fixture' }],
  ['ynab_create_category_group', { name: 'Fixture' }],
  ['ynab_update_category_group', { category_group_id: id, name: 'Fixture' }],
  ['ynab_create_category', { category: { name: 'Fixture', category_group_id: id } }],
  ['ynab_update_category', { category_id: id, changes: { goal_target: 1000, goal_frequency: 'monthly' } }],
  ['ynab_set_category_assignment', { category_id: id, month: '2026-10-01', budgeted: -1000 }],
];

function deniedServices() {
  const config: Config = {
    defaultPlanId: id, allowedPlanIds: [id], readOnly: true,
    allowDeletes: false, allowReconciledChanges: false, allowImports: false,
    toolProfile: 'extended', timeoutMs: 60000, cacheTtlSeconds: 30, logLevel: 'error',
  };
  let requests = 0;
  const api: YnabApi = { async request() { requests++; throw new Error('Unexpected API request'); } };
  const clock = { now: () => Date.UTC(2026, 9, 7) };
  const services: Services = { config, api, clock, state: createSafetyState(config, api, clock) };
  return { services, requests: () => requests };
}

describe('independent maintenance readiness (not positive handler coverage)', () => {
  it('has the frozen maintenance factory implementation before semantic verification', async () => {
    const moduleUrl = new URL('../../src/tools/maintenance.ts', import.meta.url);
    expect(existsSync(moduleUrl),
      'Missing createMaintenanceTools: all 11 route/preview/execution fixture gates remain blocked').toBe(true);
    const module = await import(moduleUrl.href);
    expect(module.createMaintenanceTools).toBeTypeOf('function');
    const handlers = module.createMaintenanceTools(deniedServices().services);
    for (const [name] of inputs) expect(handlers[name], name).toBeTypeOf('function');
  });

  it.each(inputs)('real safety denies schema-valid %s before any API access', async (name, args) => {
    expect(inputValidators.get(name)!(args)).toBe(true);
    const fixture = deniedServices();
    // No stand-in handler: this checks ONLY the shared policy boundary, not maintenance behavior.
    const dispatcher = createDispatcher(fixture.services, {});
    expect(dispatcher.listTools().some(tool => tool.name === name)).toBe(false);
    const reply = await dispatcher.callTool(name, args);
    expect(outputValidators.get(name)!(reply.structuredContent)).toBe(true);
    expect(reply.structuredContent).toMatchObject({
      status: 'error', error: { code: 'permission_denied', outcome: 'not_applied' },
    });
    expect(fixture.requests()).toBe(0);
  });
});
