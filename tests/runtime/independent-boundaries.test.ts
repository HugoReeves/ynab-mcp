import { describe, expect, it, vi } from 'vitest';
import { catalog, outputValidators } from '../../src/catalog.js';
import type { ToolResult } from '../../src/contracts.js';
import { ToolFailure } from '../../src/errors.js';
import { createDispatcher } from '../../src/runtime/dispatcher.js';
import { fakeServices, id, meta } from '../integration/protocol-fixture.js';

const args = { account: { name: 'Fixture', type: 'checking', balance: 0 } };
const safeError = (outcome: 'applied' | 'not_applied' | 'unknown'): ToolResult => ({
  status: 'error', error: { code: 'verification_failed', message: 'Safe fixture', retryable: false, outcome }, meta: { ...meta, warnings: [] },
});

describe('independent boundary review', () => {
  it('denies every hidden direct call before argument validation or plan resolution', async () => {
    const services = fakeServices();
    services.state.resolvePlan = vi.fn(() => id);
    const dispatcher = createDispatcher(services, {});
    for (const tool of catalog.filter(t => !services.state.available(t))) {
      const reply = await dispatcher.callTool(tool.name, { invalid: true });
      expect(reply.structuredContent).toMatchObject({ status: 'error', error: { code: 'permission_denied', outcome: 'not_applied' } });
      expect(outputValidators.get(tool.name)!(reply.structuredContent)).toBe(true);
    }
    expect(services.state.resolvePlan).not.toHaveBeenCalled();
  });

  it.each(['applied', 'not_applied', 'unknown'] as const)('preserves ordinary %s mutation failures', async outcome => {
    const services = fakeServices(); services.state.assertAvailable = () => {};
    const reply = await createDispatcher(services, { ynab_create_account: async () => { throw new ToolFailure((safeError(outcome) as Extract<ToolResult, { status: 'error' }>).error); } }).callTool('ynab_create_account', args);
    expect(reply.structuredContent).toMatchObject({ error: { outcome } });
  });

  it('reports unknown rather than retryable on cancellation after mutation-handler invocation', async () => {
    const services = fakeServices(); services.state.assertAvailable = () => {};
    const controller = new AbortController();
    const handler = vi.fn(async (): Promise<ToolResult> => new Promise(() => {}));
    const pending = createDispatcher(services, { ynab_create_account: handler }).callTool('ynab_create_account', args, controller.signal);
    await Promise.resolve(); expect(handler).toHaveBeenCalledOnce(); controller.abort();
    expect((await pending).structuredContent).toMatchObject({ status: 'error', error: { code: 'timeout', outcome: 'unknown', retryable: false } });
  });

  it.each(['applied', 'not_applied', 'unknown'] as const)('retains known %s outcome when bounding a schema-valid mutation error', async outcome => {
    const services = fakeServices(); services.state.assertAvailable = () => {};
    const result = safeError(outcome);
    result.meta.warnings = ['x'.repeat(512 * 1024)];
    expect(outputValidators.get('ynab_create_account')!(result)).toBe(true);
    const reply = await createDispatcher(services, { ynab_create_account: async () => result }).callTool('ynab_create_account', args);
    expect(Buffer.byteLength(JSON.stringify(reply))).toBeLessThanOrEqual(512 * 1024);
    expect(reply.structuredContent).toMatchObject({ status: 'error', error: { code: 'response_too_large', outcome } });
    expect(outputValidators.get('ynab_create_account')!(reply.structuredContent)).toBe(true);
    expect(reply.structuredContent.meta.warnings).toEqual([]);
  });

  it('does not infer application from an invalid oversized mutation result', async () => {
    const services = fakeServices(); services.state.assertAvailable = () => {};
    const result: ToolResult = { status: 'ok', data: {}, meta: { ...meta, warnings: ['x'.repeat(512 * 1024)] } };
    expect(outputValidators.get('ynab_create_account')!(result)).toBe(false);
    const reply = await createDispatcher(services, { ynab_create_account: async () => result }).callTool('ynab_create_account', args);
    expect(reply.structuredContent).toMatchObject({ status: 'error', error: { code: 'upstream_error', outcome: 'unknown' } });
    expect(outputValidators.get('ynab_create_account')!(reply.structuredContent)).toBe(true);
    expect(reply.structuredContent.meta.warnings).toEqual([]);
  });

  it.each(['mutation success', 'preview', 'read success'] as const)('retains established outcome for oversized %s without copying private metadata', async variant => {
    const services = fakeServices(); services.state.assertAvailable = () => {};
    const oversizedMeta = { ...meta, plan_id: id, warnings: ['PRIVATE_SENTINEL'.repeat(40000)] };
    const result: ToolResult = variant === 'preview' ? {
      status: 'preview', meta: oversizedMeta, preview: {
        method: 'POST', path: `/plans/${id}/accounts`, body: null, validated: true,
        before: [], expected_revisions: {}, affected_ids: [], unknown_effects: false, warnings: [],
      },
    } : variant === 'mutation success' ? {
      status: 'ok', meta: oversizedMeta, data: { account: {
        id, name: 'Fixture', type: 'checking', on_budget: true, closed: false, deleted: false,
        balance: 0, cleared_balance: 0, uncleared_balance: 0, transfer_payee_id: null,
      } },
    } : { status: 'ok', meta: oversizedMeta, data: { user: { id } } };
    const tool = variant === 'read success' ? 'ynab_get_user' : 'ynab_create_account';
    expect(outputValidators.get(tool)!(result)).toBe(true);
    const reply = await createDispatcher(services, { [tool]: async () => result }).callTool(tool, variant === 'read success' ? {} : args);
    expect(reply.structuredContent).toMatchObject({ status: 'error', error: {
      code: 'response_too_large', outcome: variant === 'mutation success' ? 'applied' : 'not_applied',
    } });
    expect(outputValidators.get(tool)!(reply.structuredContent)).toBe(true);
    expect(reply.structuredContent.meta).toEqual({ request_id: expect.any(String), fetched_at: expect.any(String), warnings: [] });
    expect(reply.structuredContent.meta.request_id).not.toBe(meta.request_id);
    expect(JSON.stringify(reply)).not.toContain('PRIVATE_SENTINEL');
    expect(Buffer.byteLength(JSON.stringify(reply))).toBeLessThanOrEqual(512 * 1024);
  });
});
