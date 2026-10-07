import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CallContext, JsonObject, ToolResult } from '../../src/contracts.js';
import { catalog, outputValidators } from '../../src/catalog.js';
import { ToolFailure } from '../../src/errors.js';
import { createDispatcher, type DispatchResult } from '../../src/runtime/dispatcher.js';
import { fakeServices, id, meta, ok } from '../integration/protocol-fixture.js';

function errorCode(reply: DispatchResult) {
  expect(reply.structuredContent.status).toBe('error');
  return (reply.structuredContent as Extract<ToolResult, { status: 'error' }>).error.code;
}

afterEach(() => vi.useRealTimers());
describe('bounded dispatcher', () => {
  it('discovers policy-approved catalog definitions and rejects hidden/unknown direct calls', async () => {
    const services = fakeServices();
    const handler = vi.fn(async () => ok);
    const d = createDispatcher(services, { ynab_get_user: handler, ynab_create_account: handler });
    expect(d.listTools()).toEqual(catalog.filter(t => services.state.available(t)));
    expect(errorCode(await d.callTool('bogus', {}))).toBe('unsupported_operation');
    expect(errorCode(await d.callTool('ynab_create_account', {}))).toBe('permission_denied');
    expect(handler).not.toHaveBeenCalled();
  });
  it('fails closed if discovery policy unexpectedly throws, without exposing its exception', () => {
    const services = fakeServices(); services.state.available = () => { throw new Error('TOKEN_SENTINEL'); };
    expect(createDispatcher(services, {}).listTools()).toEqual([]);
  });
  it.each([null, [], 'secret', { extra: true }, { plan_id: null }, { page_size: '5' }, { plan_id: 'bad' }])('rejects invalid arguments %j before invoking', async args => {
    const handler = vi.fn(async () => ok);
    const d = createDispatcher(fakeServices(), { ynab_list_accounts: handler });
    expect(errorCode(await d.callTool('ynab_list_accounts', args))).toBe('validation_error');
    expect(handler).not.toHaveBeenCalled();
  });
  it('preserves omitted args/properties, resolves scoped plans once, and builds a 60s context', async () => {
    const services = fakeServices();
    services.state.resolvePlan = vi.fn(() => id);
    const args = { plan_id: id };
    const handler = vi.fn(async (received: JsonObject, ctx: CallContext): Promise<ToolResult> => {
      expect(received).toBe(args); expect(received).not.toHaveProperty('page_size');
      expect(ctx.planId).toBe(id); expect(ctx.deadlineMs - ctx.startedAtMs).toBe(60000);
      expect(ctx.requestId).toBeTruthy(); expect(ctx.signal.aborted).toBe(false);
      return { status: 'ok', data: { accounts: [], server_knowledge: 0 }, meta };
    });
    const d = createDispatcher(services, { ynab_list_accounts: handler, ynab_get_user: async args => { expect(args).toEqual({}); return ok; } });
    expect((await d.callTool('ynab_list_accounts', args)).isError).toBe(false);
    expect(services.state.resolvePlan).toHaveBeenCalledExactlyOnceWith(id);
    await d.callTool('ynab_get_user', undefined);
    expect(services.state.resolvePlan).toHaveBeenCalledTimes(1);
  });
  it('preserves explicit null on nullable catalog fields', async () => {
    const services = fakeServices(); services.state.assertAvailable = () => {};
    const handler = vi.fn(async (args: JsonObject) => { expect(args.changes).toHaveProperty('payee_id', null); return { status: 'error', error: { code: 'validation_error', message: 'fixture', retryable: false, outcome: 'not_applied' }, meta } as ToolResult; });
    const reply = await createDispatcher(services, { ynab_update_transaction: handler }).callTool('ynab_update_transaction', { transaction_id: id, changes: { payee_id: null } });
    expect(errorCode(reply)).toBe('validation_error'); expect(handler).toHaveBeenCalledOnce();
  });
  it('returns plan resolution failures without invoking the handler', async () => {
    const services = fakeServices(); const handler = vi.fn(async () => ok);
    services.state.resolvePlan = vi.fn(() => { throw new ToolFailure({ code: 'plan_required', message: 'Select a plan.', retryable: false, outcome: 'not_applied' }); });
    const reply = await createDispatcher(services, { ynab_list_accounts: handler }).callTool('ynab_list_accounts', {});
    expect(errorCode(reply)).toBe('plan_required'); expect(handler).not.toHaveBeenCalled();
    expect(services.state.resolvePlan).toHaveBeenCalledOnce();
  });
  it('accepts and validates the preview variant without adding defaults', async () => {
    const services = fakeServices(); services.state.assertAvailable = () => {};
    const preview: ToolResult = { status: 'preview', meta, preview: {
      method: 'POST', path: `/plans/${id}/accounts`, body: null, validated: true,
      before: [], expected_revisions: {}, affected_ids: [], unknown_effects: false, warnings: [],
    } };
    const d = createDispatcher(services, { ynab_create_account: async args => {
      expect(args).not.toHaveProperty('dry_run'); return preview;
    } });
    const reply = await d.callTool('ynab_create_account', { account: { name: 'Fixture', type: 'checking', balance: 0 } });
    expect(reply.structuredContent).toEqual(preview); expect(reply.isError).toBe(false);
  });
  it('bounds inputs before validation and safely handles unserializable values', async () => {
    const handler = vi.fn(async () => ok); const d = createDispatcher(fakeServices(), { ynab_get_user: handler });
    for (const args of [{ secret: 'x'.repeat(1024 * 1024) }, { n: 1n }, (() => { const a: Record<string, unknown> = {}; a.self = a; return a; })()]) {
      expect((await d.callTool('ynab_get_user', args)).isError).toBe(true);
    }
    expect(handler).not.toHaveBeenCalled();
  });
  it.each([
    { status: 'ok', data: {}, meta },
    { status: 'preview', preview: {}, meta },
    { status: 'error', error: { code: 'invented' }, meta },
  ])('validates every returned union and sanitizes violations', async result => {
    const d = createDispatcher(fakeServices(), { ynab_get_user: async () => result as ToolResult });
    const reply = await d.callTool('ynab_get_user', {});
    expect(errorCode(reply)).toBe('upstream_error');
    expect(outputValidators.get('ynab_get_user')!(reply.structuredContent)).toBe(true);
  });
  it('bounds complete MCP outputs and hides unexpected exception messages', async () => {
    const services = fakeServices();
    for (const handler of [async () => ({ ...ok, meta: { ...meta, warnings: ['x'.repeat(512 * 1024)] } }), async () => { throw new Error('TOKEN_SENTINEL'); }]) {
      const reply = await createDispatcher(services, { ynab_get_user: handler }).callTool('ynab_get_user', {});
      expect(reply.isError).toBe(true); expect(JSON.stringify(reply)).not.toContain('TOKEN_SENTINEL');
      expect(Buffer.byteLength(JSON.stringify(reply))).toBeLessThan(512 * 1024);
    }
  });
  it('bounds the response by UTF-8 bytes rather than character count', async () => {
    const d = createDispatcher(fakeServices(), { ynab_get_user: async () => {
      throw new ToolFailure({ code: 'validation_error', message: 'é'.repeat(270000), outcome: 'not_applied', retryable: false });
    } });
    const reply = await d.callTool('ynab_get_user', {});
    expect(errorCode(reply)).toBe('response_too_large');
    expect(outputValidators.get('ynab_get_user')!(reply.structuredContent)).toBe(true);
  });
  it('preserves schema-valid ToolFailure errors and replaces invalid errors', async () => {
    for (const code of ['plan_required', 'invalid'] as const) {
      const reply = await createDispatcher(fakeServices(), { ynab_get_user: async () => { throw new ToolFailure({ code: code as 'plan_required', message: 'safe', retryable: false, outcome: 'not_applied' }); } }).callTool('ynab_get_user', {});
      expect(errorCode(reply)).toBe(code === 'invalid' ? 'upstream_error' : code);
      expect(reply.content).toHaveLength(1);
      expect(reply.content?.[0]).toMatchObject({ type: 'text' });
      expect(JSON.stringify(reply.content).length).toBeLessThan(150);
    }
  });
  it('enforces cancellation before invocation and during an uncooperative handler', async () => {
    const controller = new AbortController(); const handler = vi.fn(async () => new Promise<ToolResult>(() => {}));
    const d = createDispatcher(fakeServices(), { ynab_get_user: handler });
    controller.abort(); expect(errorCode(await d.callTool('ynab_get_user', {}, controller.signal))).toBe('timeout');
    expect(handler).not.toHaveBeenCalled();
    const active = new AbortController(); const pending = d.callTool('ynab_get_user', {}, active.signal);
    await Promise.resolve(); expect(handler).toHaveBeenCalledOnce();
    active.abort(); expect(errorCode(await pending)).toBe('timeout');
  });
  it('aborts context at the deadline even when the handler ignores its signal', async () => {
    vi.useFakeTimers(); let ctx: CallContext | undefined;
    const pending = createDispatcher(fakeServices(), { ynab_get_user: async (_args, context) => { ctx = context; return new Promise(() => {}); } }).callTool('ynab_get_user', {});
    await vi.advanceTimersByTimeAsync(60000);
    expect(errorCode(await pending)).toBe('timeout'); expect(ctx?.signal.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});
