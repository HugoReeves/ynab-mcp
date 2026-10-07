import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, writeFile, chmod, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConnection } from '../../src/config.js';
import { planPath } from '../../src/ynab/client.js';
import type { CallContext, ToolDefinition } from '../../src/contracts.js';

const plan = '11111111-1111-4111-8111-111111111111';
const other = '22222222-2222-4222-8222-222222222222';
let seq = 0;
const env = () => ({ YNAB_ACCESS_TOKEN: `fake-secret-${++seq}` });
const ctx = (planId: string | undefined = plan): CallContext => ({ tool: {} as ToolDefinition, requestId: 'fixture', planId, startedAtMs: Date.now(), deadlineMs: Date.now() + 60000, signal: new AbortController().signal });
const reply = (body = '{"data":{"ok":true}}', status = 200, headers = {}) => new Response(body, { status, headers });
const fake = (fn: (url: string, init: RequestInit) => Promise<Response> | Response) => vi.fn((url: string | URL | Request, init?: RequestInit) => Promise.resolve(fn(String(url), init!))) as unknown as typeof fetch;
const request = { method: 'GET' as const, path: `/plans/${plan}/accounts` };
afterEach(() => vi.useRealTimers());

describe('strict private configuration', () => {
  it('defaults are immutable and credentials absent', async () => {
    const e = env(); const c = await createConnection(e, { fetch: fake(() => reply()) });
    expect(c.config).toEqual({ allowedPlanIds: null, readOnly: true, allowDeletes: false, allowReconciledChanges: false, allowImports: false, toolProfile: 'core', timeoutMs: 20000, cacheTtlSeconds: 30, logLevel: 'warn' });
    expect(Object.isFrozen(c.config)).toBe(true);
    expect(JSON.stringify(c)).not.toContain(e.YNAB_ACCESS_TOKEN);
  });
  it.each([{}, { YNAB_ACCESS_TOKEN: '' }, { YNAB_ACCESS_TOKEN: 'a\nb' }, { YNAB_ACCESS_TOKEN: 'a', YNAB_ACCESS_TOKEN_FILE: '/missing' }, { ...env(), YNAB_READ_ONLY: 'TRUE' }, { ...env(), YNAB_TIMEOUT_MS: '1000.0' }, { ...env(), YNAB_CACHE_TTL_SECONDS: '301' }, { ...env(), YNAB_PLAN_ID: 'last-used' }, { ...env(), YNAB_ALLOWED_PLAN_IDS: `${plan},` }, { ...env(), YNAB_PLAN_ID: other, YNAB_ALLOWED_PLAN_IDS: plan }, { ...env(), YNAB_TOOL_PROFILE: 'all' }, { ...env(), YNAB_LOG_LEVEL: 'debug' }])('rejects invalid config without values %j', async (e) => {
    await expect(createConnection(e)).rejects.toMatchObject({ error: { code: 'configuration_error' } });
  });
  it('checks absolute regular private token files and trims', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ynab-http-')); const path = join(dir, 'token');
    try {
      await writeFile(path, ' fake-file-token\n', { mode: 0o600 });
      const fetcher = fake((_url, init) => { expect(new Headers(init.headers).get('authorization')).toBe('Bearer fake-file-token'); return reply(); });
      const c = await createConnection({ YNAB_ACCESS_TOKEN_FILE: path }, { fetch: fetcher });
      await c.api.request(ctx(), request);
      const link = join(dir, 'link'); await symlink(path, link);
      await expect(createConnection({ YNAB_ACCESS_TOKEN_FILE: link })).rejects.toMatchObject({ error: { code: 'configuration_error' } });
      await chmod(path, 0o200);
      await expect(createConnection({ YNAB_ACCESS_TOKEN_FILE: path })).rejects.toMatchObject({ error: { code: 'configuration_error' } });
      await chmod(path, 0o640);
      await expect(createConnection({ YNAB_ACCESS_TOKEN_FILE: path })).rejects.toMatchObject({ error: { code: 'configuration_error' } });
      await expect(createConnection({ YNAB_ACCESS_TOKEN_FILE: 'relative' })).rejects.toMatchObject({ error: { code: 'configuration_error' } });
      await expect(createConnection({ YNAB_ACCESS_TOKEN_FILE: dir })).rejects.toMatchObject({ error: { code: 'configuration_error' } });
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});

describe('paths and transport', () => {
  it('uses exact fixed origin, headers, redirect rejection and encoded query', async () => {
    const e = env(); const fetcher = fake((url, init) => {
      expect(url).toBe(`https://api.ynab.com/v1/plans/${plan}/transactions?since_date=2026-01-01&memo=a%26b`);
      expect(init.redirect).toBe('error'); expect(init.method).toBe('GET');
      expect(new Headers(init.headers).get('authorization')).toBe(`Bearer ${e.YNAB_ACCESS_TOKEN}`);
      return reply(undefined, 200, { 'X-Rate-Limit': '12/200' });
    });
    const c = await createConnection(e, { fetch: fetcher });
    expect(planPath(plan, 'transactions')).toBe(`/plans/${plan}/transactions`);
    expect((await c.api.request(ctx(), { method: 'GET', path: planPath(plan, 'transactions'), query: { since_date: '2026-01-01', memo: 'a&b' } })).rateLimit).toEqual({ used: 12, limit: 200 });
  });
  it.each(['..', '.', '%2e%2e', 'a/b', 'a\\b', 'a?b', 'a#b', '', '//evil', 'a\n'])('rejects hostile segment %s', (segment) => {
    expect(() => planPath(plan, segment)).toThrow();
  });
  it.each([`/plans/${other}/accounts`, `/plans/${plan}/../${other}`, `/plans/${plan}/%2e%2e`, `/plans/${plan}//accounts`, `/plans/${plan}/accounts?x=y`, 'https://evil.test/', '/user/extra', '/v1/user'])('rejects raw unsafe/outside path %s', async (path) => {
    const fetcher = fake(() => reply()); const c = await createConnection(env(), { fetch: fetcher });
    await expect(c.api.request(ctx(), { method: 'GET', path })).rejects.toBeDefined(); expect(fetcher).not.toHaveBeenCalled();
  });
  it('enforces allowlist at final request and permits only unscoped GET user/plans', async () => {
    const fetcher = fake(() => reply()); const c = await createConnection({ ...env(), YNAB_ALLOWED_PLAN_IDS: other }, { fetch: fetcher });
    await expect(c.api.request(ctx(), request)).rejects.toMatchObject({ error: { code: 'permission_denied' } });
    await c.api.request(ctx(undefined), { method: 'GET', path: '/user' });
    await c.api.request(ctx(undefined), { method: 'GET', path: '/plans' });
    await expect(c.api.request(ctx(), { method: 'POST', path: '/user' })).rejects.toBeDefined();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});

describe('bounded responses and safe errors', () => {
  it.each([[401, 'authentication_error'], [403, 'permission_denied'], [404, 'not_found'], [409, 'conflict'], [429, 'rate_limited'], [400, 'validation_error']])('maps %s without retry and redacts echoed secrets', async (status, code) => {
    const e = env(); const fetcher = fake(() => reply(JSON.stringify({ error: { id: 'fixture', name: 'safe', detail: `Bearer ${e.YNAB_ACCESS_TOKEN}` } }), status as number, { 'Retry-After': '3' }));
    const c = await createConnection(e, { fetch: fetcher });
    try { await c.api.request(ctx(), request); throw new Error('expected failure'); } catch (err) {
      expect(err).toMatchObject({ error: { code, http_status: status, upstream: { id: 'fixture', name: 'safe' } } });
      expect(JSON.stringify(err)).not.toContain(e.YNAB_ACCESS_TOKEN);
    }
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it.each(['not json', '{"data":[]}', '{}', '{"data":{"amount":9007199254740993}}', '{"data":{"amount":1.5}}', '{"data":{"server_knowledge":1e20}}', '{"data":{"amount":9007199254740991.1}}', '{"data":{"amount":1e-400}}', '{"data":{"debt_interest_rates":{"2026-01-01":1.5}}}'])('rejects malformed or unsafe response %s', async (body) => {
    const c = await createConnection(env(), { fetch: fake(() => reply(body)) });
    await expect(c.api.request(ctx(), request)).rejects.toBeDefined();
  });
  it.each([400, 401, 403, 404, 409, 429])('definite mutation rejection %s is not-applied and never retried', async (status) => {
    const fetcher = fake(() => reply('{"error":{"id":"fixture","name":"safe","detail":"rejected"}}', status));
    const c = await createConnection(env(), { fetch: fetcher });
    await expect(c.api.request(ctx(), { ...request, method: 'POST', body: { amount: 1 } })).rejects.toMatchObject({ error: { http_status: status, outcome: 'not_applied' } }); expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('returns successful mutations once but treats malformed acknowledgments as unknown', async () => {
    let count = 0; const fetcher = fake((_url, init) => {
      expect(init.body).toBe('{"amount":1}'); expect(new Headers(init.headers).get('content-type')).toBe('application/json');
      return ++count === 1 ? reply('{"data":{"transaction":{"id":"fake-id","amount":1}}}', 201) : reply('{}');
    });
    const c = await createConnection(env(), { fetch: fetcher });
    expect((await c.api.request(ctx(), { ...request, method: 'POST', body: { amount: 1 } })).data.transaction).toEqual({ id: 'fake-id', amount: 1 });
    await expect(c.api.request(ctx(), { ...request, method: 'POST', body: { amount: 1 } })).rejects.toMatchObject({ error: { code: 'outcome_unknown', outcome: 'unknown', retryable: false } }); expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('allows safe signed integer edges and display decimals', async () => {
    const c = await createConnection(env(), { fetch: fake(() => reply('{"data":{"amount":-9007199254740991,"balance":9007199254740991,"goal_target_currency":1234.56,"goal_under_funded_currency":0.001,"goal_snoozed_at":"2026-01-01","currency_format":{"example_format":"1,234.56"}}}')) });
    expect((await c.api.request(ctx(), request)).data.amount).toBe(-9007199254740991);
  });
  it('bounds streamed bytes before parsing and cancels reader', async () => {
    const cancel = vi.fn(); const stream = new ReadableStream({ start(c) { c.enqueue(new Uint8Array(8 * 1024 * 1024 + 1)); }, cancel });
    const c = await createConnection(env(), { fetch: fake(() => new Response(stream)) });
    await expect(c.api.request(ctx(), request)).rejects.toMatchObject({ error: { code: 'response_too_large' } }); expect(cancel).toHaveBeenCalled();
  });
  it('rejects oversized content-length without reading or trusting it as the only bound', async () => {
    const cancel = vi.fn(); const c = await createConnection(env(), { fetch: fake(() => new Response(new ReadableStream({ cancel }), { headers: { 'Content-Length': String(8 * 1024 * 1024 + 1) } })) });
    await expect(c.api.request(ctx(), request)).rejects.toMatchObject({ error: { code: 'response_too_large' } }); expect(cancel).toHaveBeenCalled();
  });
  it('rejects redirects even with noncompliant injected transport', async () => {
    const c = await createConnection(env(), { fetch: fake(() => reply('', 302, { location: 'https://evil.test/' })) });
    await expect(c.api.request(ctx(), request)).rejects.toMatchObject({ error: { code: 'upstream_error' } });
  });
  it('GET retries at most twice, mutation never retries and exception secrets stay private', async () => {
    const e = env(); const fetcher = fake(() => { throw new Error(e.YNAB_ACCESS_TOKEN); });
    const c = await createConnection(e, { fetch: fetcher });
    await expect(c.api.request(ctx(), request)).rejects.toMatchObject({ error: { code: 'upstream_error' } }); expect(fetcher).toHaveBeenCalledTimes(3);
    try { await c.api.request(ctx(), { ...request, method: 'POST', body: { memo: 'fake' } }); } catch (err) {
      expect(err).toMatchObject({ error: { code: 'outcome_unknown', outcome: 'unknown', retryable: false } }); expect(JSON.stringify(err)).not.toContain(e.YNAB_ACCESS_TOKEN);
    }
    expect(fetcher).toHaveBeenCalledTimes(4);
  });
  it.each([502, 503, 504])('retries GET %s but not mutation', async (status) => {
    const fetcher = fake(() => reply('{}', status)); const c = await createConnection(env(), { fetch: fetcher });
    await expect(c.api.request(ctx(), request)).rejects.toBeDefined(); expect(fetcher).toHaveBeenCalledTimes(3);
    await expect(c.api.request(ctx(), { ...request, method: 'PATCH' })).rejects.toMatchObject({ error: { code: 'outcome_unknown' } }); expect(fetcher).toHaveBeenCalledTimes(4);
  });
});

describe('quota, deadlines and concurrency', () => {
  it('enforces rolling quota including retries and releases at one hour', async () => {
    let now = Date.now(); const fetcher = fake(() => reply()); const c = await createConnection(env(), { fetch: fetcher, clock: { now: () => now } });
    for (let i = 0; i < 200; i++) await c.api.request({ ...ctx(), startedAtMs: now, deadlineMs: now + 60000 }, request);
    await expect(c.api.request({ ...ctx(), startedAtMs: now, deadlineMs: now + 60000 }, request)).rejects.toMatchObject({ error: { code: 'rate_limited', retry_after_seconds: 3600 } });
    now += 3600000; await c.api.request({ ...ctx(), startedAtMs: now, deadlineMs: now + 60000 }, request); expect(fetcher).toHaveBeenCalledTimes(201);
  });
  it('honors external quota usage and shares accounting by private identity', async () => {
    const e = env(); const fetcher = fake(() => reply(undefined, 200, { 'X-Rate-Limit': '199/200' }));
    const c = await createConnection(e, { fetch: fetcher }); const d = await createConnection(e, { fetch: fetcher });
    await c.api.request(ctx(), request); await d.api.request(ctx(), request);
    await expect(c.api.request(ctx(), request)).rejects.toMatchObject({ error: { code: 'rate_limited' } });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('honors a lower reported server quota ceiling', async () => {
    const fetcher = fake(() => reply(undefined, 200, { 'X-Rate-Limit': '1/2' })); const c = await createConnection(env(), { fetch: fetcher });
    await c.api.request(ctx(), request); await c.api.request(ctx(), request);
    await expect(c.api.request(ctx(), request)).rejects.toMatchObject({ error: { code: 'rate_limited' } }); expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('supplies safe estimated guidance for a 429 without Retry-After', async () => {
    const c = await createConnection(env(), { fetch: fake(() => reply('{}', 429)) });
    await expect(c.api.request(ctx(), request)).rejects.toMatchObject({ error: { code: 'rate_limited', retry_after_seconds: 3600 } });
  });
  it('honors 429 Retry-After without sleeping and rejects invalid rate metadata', async () => {
    let now = Date.now(); let count = 0;
    const fetcher = fake(() => ++count === 1 ? reply('{}', 429, { 'Retry-After': '5' }) : reply(undefined, 200, { 'X-Rate-Limit': 'secret/NaN' }));
    const c = await createConnection(env(), { fetch: fetcher, clock: { now: () => now } });
    await expect(c.api.request(ctx(), request)).rejects.toMatchObject({ error: { code: 'rate_limited', retry_after_seconds: 5 } });
    await expect(c.api.request(ctx(), request)).rejects.toMatchObject({ error: { code: 'rate_limited' } }); expect(fetcher).toHaveBeenCalledTimes(1);
    now += 5000; expect((await c.api.request({ ...ctx(), startedAtMs: now, deadlineMs: now + 60000 }, request)).rateLimit).toEqual({ used: 2, limit: 200, estimated: true });
  });
  it('caps requests at two including separate connections', async () => {
    const releases: (() => void)[] = []; let active = 0; let maximum = 0;
    const fetcher = fake(() => new Promise<Response>((resolve) => { active++; maximum = Math.max(maximum, active); releases.push(() => { active--; resolve(reply()); }); }));
    const c = await createConnection(env(), { fetch: fetcher }); const d = await createConnection(env(), { fetch: fetcher });
    const jobs = [c, d, c, d].map(x => x.api.request(ctx(), request));
    await vi.waitFor(() => expect(releases).toHaveLength(2)); releases.splice(0).forEach(fn => fn());
    await vi.waitFor(() => expect(releases).toHaveLength(2)); releases.splice(0).forEach(fn => fn()); await Promise.all(jobs); expect(maximum).toBe(2);
  });
  it('timeout aborts fetch even when transport ignores signal; mutation uncertain', async () => {
    vi.useFakeTimers(); let signal: AbortSignal | undefined;
    const c = await createConnection({ ...env(), YNAB_TIMEOUT_MS: '1000' }, { fetch: fake((_url, init) => { signal = init.signal!; return new Promise(() => {}); }) });
    const job = c.api.request(ctx(), { ...request, method: 'POST' }); const assertion = expect(job).rejects.toMatchObject({ error: { code: 'outcome_unknown' } });
    await vi.advanceTimersByTimeAsync(1001); await assertion; expect(signal!.aborted).toBe(true);
  });
  it('aborts a stalled response body and cancels its stream', async () => {
    vi.useFakeTimers(); const cancel = vi.fn();
    const c = await createConnection({ ...env(), YNAB_TIMEOUT_MS: '1000' }, { fetch: fake(() => new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('{')); }, cancel }))) });
    const job = c.api.request(ctx(), request); const assertion = expect(job).rejects.toMatchObject({ error: { code: 'timeout' } });
    await vi.advanceTimersByTimeAsync(1001); await assertion; expect(cancel).toHaveBeenCalled();
  });
  it('removes cancelled queued calls without consuming quota or dispatching', async () => {
    const releases: (() => void)[] = []; const fetcher = fake(() => new Promise<Response>(resolve => releases.push(() => resolve(reply()))));
    const c = await createConnection(env(), { fetch: fetcher }); const jobs = [c.api.request(ctx(), request), c.api.request(ctx(), request)];
    const abort = new AbortController(); const queued = c.api.request({ ...ctx(), signal: abort.signal }, request);
    const assertion = expect(queued).rejects.toMatchObject({ error: { code: 'timeout', outcome: 'not_applied' } }); abort.abort(); await assertion;
    await vi.waitFor(() => expect(releases).toHaveLength(2)); releases.forEach(fn => fn()); await Promise.all(jobs); expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('enforces the total deadline even when a longer deadline is supplied', async () => {
    vi.useFakeTimers(); const c = await createConnection({ ...env(), YNAB_TIMEOUT_MS: '60000' }, { fetch: fake(() => new Promise(() => {})) });
    const job = c.api.request({ ...ctx(), startedAtMs: Date.now() - 59000, deadlineMs: Date.now() + 300000 }, request);
    const assertion = expect(job).rejects.toMatchObject({ error: { code: 'timeout' } }); await vi.advanceTimersByTimeAsync(1001); await assertion;
  });
  it('caps total deadline at 60s, rejects expired or cancelled contexts before sending', async () => {
    const fetcher = fake(() => reply()); const c = await createConnection(env(), { fetch: fetcher });
    await expect(c.api.request({ ...ctx(), startedAtMs: Date.now() - 60001, deadlineMs: Date.now() + 10000 }, request)).rejects.toMatchObject({ error: { code: 'timeout' } });
    const abort = new AbortController(); abort.abort(); await expect(c.api.request({ ...ctx(), signal: abort.signal }, request)).rejects.toMatchObject({ error: { code: 'timeout' } }); expect(fetcher).not.toHaveBeenCalled();
  });
});
