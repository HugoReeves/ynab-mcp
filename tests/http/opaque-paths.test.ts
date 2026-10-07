import { expect, it, vi } from 'vitest';
import { createConnection } from '../../src/config.js';
import type { CallContext, ToolDefinition } from '../../src/contracts.js';
import { planPath } from '../../src/ynab/client.js';

const plan = '11111111-1111-4111-8111-111111111111';
const other = '22222222-2222-4222-8222-222222222222';
let sequence = 0;
const context = (): CallContext => ({ tool: {} as ToolDefinition, requestId: 'opaque', planId: plan,
  startedAtMs: Date.now(), deadlineMs: Date.now() + 60000, signal: new AbortController().signal });
async function harness(allowed = plan) {
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('{"data":{}}'));
  const connection = await createConnection({ YNAB_ACCESS_TOKEN: `opaque-path-secret-${++sequence}`, YNAB_ALLOWED_PLAN_IDS: allowed }, { fetch: fetcher });
  return { api: connection.api, fetcher };
}

it.each(['opaque:txn.1', 'bank:fixture', 'café東京💰', "a!$&'()*+,;=@[]", 'a..b', 'ordinary_id-1'])('encodes raw opaque segment once: %s', raw => {
  expect(planPath(plan.toUpperCase(), 'transactions', raw)).toBe(`/plans/${plan}/transactions/${encodeURIComponent(raw)}`);
});

it.each(['opaque:txn.1', 'bank:fixture', 'café東京💰', "a!$&'()*+,;=@[]", 'a..b', 'ordinary_id-1'])('dispatches canonical opaque segment at fixed origin: %s', async raw => {
  const { api, fetcher } = await harness();
  const path = `/plans/${plan}/transactions/${encodeURIComponent(raw)}`;
  await api.request(context(), { method: 'GET', path });
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(fetcher.mock.calls[0]![0]).toBe(`https://api.ynab.com/v1${path}`);
  expect(fetcher.mock.calls[0]![1]?.redirect).toBe('error');
});

it.each(['', '.', '..', '%', '%3A', '%252F', 'a/b', 'a\\b', 'a?b', 'a#b', 'a b', 'a\t', 'a\n', 'a\u0000', 'a\u001f', 'a\u007f', 'a\u0080', 'a\u0085', 'a\u009f', 'a\u00a0'])('rejects unsafe raw builder segment %j', raw => {
  expect(() => planPath(plan, 'transactions', raw)).toThrow();
});

it.each(['', '.', '..', '%2E', '%2E%2E', '.%2E', '%2Fuser', 'a%2Fb', 'a%5Cb', 'a%3Fb', 'a%23b', '%25', '%252F', '%252e%252e', '%', '%2', '%GG', '%FF', '%C0%AF', '%ED%A0%80', 'a%20b', 'a%09b', 'a%00b', 'a%7Fb', 'a%C2%80b', 'a%C2%85b', 'a%C2%9Fb', 'a%C2%A0b', 'bank:fixture', 'bank%3afixture', '%61', '%21', 'café', 'a\\b', 'a?b', 'a#b', 'a/b/..'])('rejects unsafe or noncanonical HTTP segment %j before dispatch', async encoded => {
  const { api, fetcher } = await harness();
  await expect(api.request(context(), { method: 'GET', path: `/plans/${plan}/transactions/${encoded}` })).rejects.toMatchObject({ error: { code: 'validation_error' } });
  expect(fetcher).not.toHaveBeenCalled();
});

it.each([`/plans/${other}/transactions/bank%3Afixture`, '/plans/not-a-uuid/transactions/bank%3Afixture', `https://evil.test/plans/${plan}/transactions/bank%3Afixture`, `/plans/${plan}//bank%3Afixture`])('preserves plan and origin confinement: %s', async path => {
  const { api, fetcher } = await harness();
  await expect(api.request(context(), { method: 'GET', path })).rejects.toBeDefined();
  expect(fetcher).not.toHaveBeenCalled();
});

it('preserves selected-plan allowlist for canonical opaque paths', async () => {
  const { api, fetcher } = await harness(other);
  await expect(api.request(context(), { method: 'GET', path: `/plans/${plan}/transactions/bank%3Afixture` })).rejects.toMatchObject({ error: { code: 'permission_denied' } });
  expect(fetcher).not.toHaveBeenCalled();
});
