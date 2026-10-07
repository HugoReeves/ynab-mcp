import { afterEach, expect, it, vi } from 'vitest';
import { createConnection } from '../../src/config.js';
import type { CallContext, ToolDefinition } from '../../src/contracts.js';

const plan = '11111111-1111-4111-8111-111111111111';
let sequence = 0;
const environment = () => ({ YNAB_ACCESS_TOKEN: `independent-http-secret-${++sequence}` });
const context = (): CallContext => ({ tool: {} as ToolDefinition, requestId: 'independent', planId: plan,
  startedAtMs: Date.now(), deadlineMs: Date.now() + 60000, signal: new AbortController().signal });
const request = { method: 'GET' as const, path: `/plans/${plan}/accounts` };
const response = (text = '{"data":{}}', status = 200) => new Response(text, { status });
afterEach(() => vi.useRealTimers());

it.each(['%252e%252e', '%2Fuser', 'accounts\\..\\..\\user', 'accounts\u0000', 'accounts\n', 'accounts#fragment', 'accounts;../user'])('rejects raw path attack %j without dispatch', async segment => {
  const fetcher = vi.fn<typeof fetch>();
  const connection = await createConnection(environment(), { fetch: fetcher });
  await expect(connection.api.request(context(), { ...request, path: `/plans/${plan}/${segment}` })).rejects.toBeDefined();
  expect(fetcher).not.toHaveBeenCalled();
});

it.each(['9007199254740991.00000000000001', '-9007199254740991.00000000000001', '1.00000000000000001', '1e-999999', '9007199254740992', '-9007199254740993'])('rejects lossy integer literal %s before returning data', async literal => {
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => response(`{"data":{"amount":${literal}}}`));
  const connection = await createConnection(environment(), { fetch: fetcher });
  await expect(connection.api.request(context(), request)).rejects.toMatchObject({ error: { code: 'unsafe_integer' } });
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it.each(['90071992547409910e-1', '-90071992547409910e-1', '1000e-3', '0e999999'])('accepts exactly represented integer notation %s', async literal => {
  const connection = await createConnection(environment(), { fetch: vi.fn<typeof fetch>().mockImplementation(async () => response(`{"data":{"amount":${literal},"amount_currency":1.23}}`)) });
  expect((await connection.api.request(context(), request)).data).toEqual({ amount: Number(literal), amount_currency: 1.23 });
});

it('redacts bare token echoes in every upstream error field', async () => {
  const env = environment();
  const text = JSON.stringify({ error: { id: env.YNAB_ACCESS_TOKEN, name: `prefix-${env.YNAB_ACCESS_TOKEN}`, detail: `${env.YNAB_ACCESS_TOKEN}\nBearer unrelated-credential` } });
  const connection = await createConnection(env, { fetch: vi.fn<typeof fetch>().mockImplementation(async () => response(text, 401)) });
  const error: unknown = await connection.api.request(context(), request).catch(error => error);
  expect(error).toMatchObject({ error: { code: 'authentication_error' } });
  expect(JSON.stringify(error)).not.toContain(env.YNAB_ACCESS_TOKEN);
  expect(JSON.stringify(error)).not.toContain('unrelated-credential');
});

it.each([500, 501, 502, 503, 504])('never replays a mutation after HTTP %s', async status => {
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => response('{"error":{"id":"server","name":"failure","detail":"failure"}}', status));
  const connection = await createConnection(environment(), { fetch: fetcher });
  await expect(connection.api.request(context(), { ...request, method: 'DELETE' })).rejects.toMatchObject({ error: { code: 'outcome_unknown', outcome: 'unknown', retryable: false, http_status: status } });
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it('counts response-body consumption toward concurrency and expires queued mutations as not applied', async () => {
  vi.useFakeTimers();
  const finish: (() => void)[] = [];
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response(new ReadableStream<Uint8Array>({ start(controller) {
    controller.enqueue(new TextEncoder().encode('{"data":{}}'));
    finish.push(() => controller.close());
  } })));
  const connection = await createConnection(environment(), { fetch: fetcher });
  const reads = [connection.api.request(context(), request), connection.api.request(context(), request)];
  await vi.advanceTimersByTimeAsync(0);
  expect(fetcher).toHaveBeenCalledTimes(2);
  const queued = connection.api.request({ ...context(), deadlineMs: Date.now() + 100 }, { ...request, method: 'POST', body: {} });
  const assertion = expect(queued).rejects.toMatchObject({ error: { code: 'timeout', outcome: 'not_applied' } });
  await vi.advanceTimersByTimeAsync(101);
  await assertion;
  expect(fetcher).toHaveBeenCalledTimes(2);
  finish.forEach(close => close());
  await Promise.all(reads);
  await connection.api.request({ ...context(), deadlineMs: Date.now() - 1 }, request).catch(() => {});
  expect(fetcher).toHaveBeenCalledTimes(2);
});

it('counts failed attempts toward the rolling quota and refuses mutations before submission', async () => {
  const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error('offline fixture'));
  const connection = await createConnection(environment(), { fetch: fetcher });
  for (let index = 0; index < 67; index++) await connection.api.request(context(), request).catch(() => {});
  expect(fetcher).toHaveBeenCalledTimes(200);
  await expect(connection.api.request(context(), { ...request, method: 'POST', body: {} })).rejects.toMatchObject({ error: { code: 'rate_limited', outcome: 'not_applied' } });
  expect(fetcher).toHaveBeenCalledTimes(200);
});
