import type { ApiReply, ApiRequest, CallContext, Clock, Config, ErrorCode, JsonObject, RateLimit, ToolError, YnabApi } from '../contracts.js';
import { ToolFailure } from '../errors.js';

const BASE = 'https://api.ynab.com/v1';
const MAX_BYTES = 8 * 1024 * 1024;
const HOUR = 3600000;
export const isUuid = (value: string): boolean => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const segmentSafe = (value: string): boolean => value.length > 0 &&
  !/[/\\?#%\s\x00-\x1f\x7f-\x9f]/.test(value) && value !== '.' && value !== '..';
// Decode exactly once; reject forbidden raw values and alternate escape spellings.
function encodedSegmentSafe(value: string): boolean {
  try {
    const decoded = decodeURIComponent(value);
    return segmentSafe(decoded) && encodeURIComponent(decoded) === value;
  } catch { return false; }
}
function failure(code: ErrorCode, message: string, extra: Partial<ToolError> = {}): ToolFailure {
  return new ToolFailure({ code, message, retryable: false, outcome: 'not_applied', ...extra });
}
export function planPath(planId: string, ...segments: string[]): string {
  if (!isUuid(planId) || segments.some(segment => !segmentSafe(segment))) {
    throw failure('validation_error', 'Invalid plan or path segment.');
  }
  try {
    return `/plans/${planId.toLowerCase()}${segments.length ? `/${segments.map(segment => encodeURIComponent(segment)).join('/')}` : ''}`;
  } catch { throw failure('validation_error', 'Invalid plan or path segment.'); }
}

// The process-wide semaphore includes body consumption, not just response headers.
let active = 0;
interface Waiter { grant(): void }
const waiters: Waiter[] = [];
function acquire(signal: AbortSignal): Promise<() => void> {
  return new Promise((resolve, reject) => {
    let granted = false;
    const release = () => {
      if (!granted) return;
      granted = false; active--;
      waiters.shift()?.grant();
    };
    const waiter: Waiter = { grant() {
      signal.removeEventListener('abort', abort);
      active++; granted = true; resolve(release);
    } };
    const abort = () => {
      const index = waiters.indexOf(waiter);
      if (index !== -1) waiters.splice(index, 1);
      reject(failure('timeout', 'Request cancelled or deadline exceeded.', { retryable: true }));
    };
    if (signal.aborted) { abort(); return; }
    signal.addEventListener('abort', abort, { once: true });
    if (active < 2) waiter.grant(); else waiters.push(waiter);
  });
}
interface Quota { times: number[]; blockedUntil: number; limit: number; limitUntil: number }
// Private token identity shares accounting across connections without exposing credentials.
const quotas = new Map<string, Quota>();
const object = (value: unknown): value is JsonObject => value !== null && typeof value === 'object' && !Array.isArray(value);

// Integer properties in the pinned upstream schemas. Display currency examples are numbers,
// not milliunits: ordinary finite decimals must remain valid.
const integerKeys = new Set(['decimal_digits', 'server_knowledge', 'balance', 'cleared_balance', 'uncleared_balance',
  'budgeted', 'activity', 'amount', 'goal_day', 'goal_cadence', 'goal_cadence_frequency', 'goal_target',
  'goal_percentage_complete', 'goal_months_to_budget', 'goal_under_funded', 'goal_overall_funded',
  'goal_overall_left', 'income', 'to_be_budgeted', 'age_of_money']);

function parse(text: string): unknown {
  try {
    return JSON.parse(text, (key: string, value: unknown, context?: { source?: string }) => {
      if (typeof value !== 'number') return value;
      if (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value))) {
        throw failure('unsafe_integer', 'Upstream number exceeds the safe numeric range.');
      }
      // A source-aware reviver prevents rounding a fractional literal into a safe integer.
      // LoanAccountPeriodicValue uses date-keyed integer values.
      if (integerKeys.has(key) || /^\d{4}-\d{2}-\d{2}$/.test(key)) {
        if (!Number.isSafeInteger(value) || (context?.source && !exactInteger(context.source))) {
          throw failure('unsafe_integer', 'Upstream integer field is not a safe integer.');
        }
      }
      return value;
    });
  } catch (err) {
    if (err instanceof ToolFailure) throw err;
    throw failure('upstream_error', 'Upstream response is not valid JSON.');
  }
}
function exactInteger(source: string): boolean {
  const match = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(source);
  if (!match) return false;
  const digits = (match[2] + (match[3] ?? '')).replace(/^0+/, '');
  if (!digits) return true;
  const shift = Number(match[4] ?? 0) - (match[3]?.length ?? 0);
  if (!Number.isSafeInteger(shift) || digits.length + shift > 16 || digits.length + shift <= 0) return false;
  if (shift < 0 && !/^0*$/.test(digits.slice(digits.length + shift))) return false;
  const integral = shift >= 0 ? digits + '0'.repeat(shift) : digits.slice(0, digits.length + shift);
  return BigInt(integral) <= BigInt(Number.MAX_SAFE_INTEGER);
}

async function readBody(response: Response, signal: AbortSignal): Promise<string> {
  const length = response.headers.get('content-length');
  if (length && /^\d+$/.test(length) && Number(length) > MAX_BYTES) {
    await response.body?.cancel().catch(() => {});
    throw failure('response_too_large', 'Upstream response exceeds 8 MiB.');
  }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', abort, { once: true });
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      if (signal.aborted) throw failure('timeout', 'Request cancelled or deadline exceeded.', { retryable: true });
      const { value, done } = await abortable(reader.read(), signal);
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BYTES) throw failure('response_too_large', 'Upstream response exceeds 8 MiB.');
      chunks.push(value);
    }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch { throw failure('upstream_error', 'Upstream response has invalid text encoding.'); }
  } finally {
    signal.removeEventListener('abort', abort);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
function abortable<T>(job: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(failure('timeout', 'Request cancelled or deadline exceeded.', { retryable: true }));
    if (signal.aborted) { abort(); return; }
    signal.addEventListener('abort', abort, { once: true });
    job.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
function retryAfter(response: Response, now: number): number | undefined {
  const raw = response.headers.get('retry-after');
  if (!raw) return undefined;
  const value = /^\d+$/.test(raw) ? Number(raw) : Math.ceil((Date.parse(raw) - now) / 1000);
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}
function rate(response: Response): RateLimit | undefined {
  const match = /^(\d+)\s*\/\s*(\d+)$/.exec(response.headers.get('x-rate-limit') ?? '');
  if (!match) return undefined;
  const used = Number(match[1]); const limit = Number(match[2]);
  return Number.isSafeInteger(used) && Number.isSafeInteger(limit) && limit > 0 ? { used, limit } : undefined;
}

export function createApi(config: Config, token: string, fetcher: typeof fetch, clock: Clock): YnabApi {
  let quota = quotas.get(token);
  if (!quota) { quota = { times: [], blockedUntil: 0, limit: 200, limitUntil: 0 }; quotas.set(token, quota); }
  const accounting = quota;
  const redact = (value: string): string => {
    let safe = value;
    for (const secret of new Set([token, encodeURIComponent(token), JSON.stringify(token).slice(1, -1)])) {
      safe = safe.split(secret).join('[REDACTED]');
    }
    return safe.replace(/Bearer\s+[^\s"<>]+/gi, 'Bearer [REDACTED]').replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 1024);
  };
  return Object.freeze({ async request(ctx: CallContext, request: ApiRequest): Promise<ApiReply> {
    const mutation = request.method !== 'GET';
    if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method)) throw failure('validation_error', 'Unsupported HTTP method.');
    const parts = request.path.split('/');
    const unscoped = request.path === '/user' || request.path === '/plans';
    if (unscoped) {
      if (mutation) throw failure('permission_denied', 'Unscoped mutations are forbidden.');
    } else {
      if (parts[0] !== '' || parts[1] !== 'plans' || !isUuid(parts[2] ?? '') || parts.slice(3).some(s => !encodedSegmentSafe(s))) {
        throw failure('validation_error', 'Unsafe upstream path.');
      }
      if (!ctx.planId || !isUuid(ctx.planId) || parts[2].toLowerCase() !== ctx.planId.toLowerCase()) {
        throw failure('permission_denied', 'Request is outside the selected plan.');
      }
      if (config.allowedPlanIds && !config.allowedPlanIds.includes(ctx.planId.toLowerCase())) {
        throw failure('permission_denied', 'Selected plan is not allowed.');
      }
    }
    const url = new URL(BASE + request.path);
    if (url.origin !== 'https://api.ynab.com' || url.pathname !== '/v1' + request.path) throw failure('validation_error', 'Unsafe upstream path.');
    for (const [key, value] of Object.entries(request.query ?? {})) {
      if (typeof value === 'number' && (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value)))) {
        throw failure('validation_error', 'Invalid query number.');
      }
      url.searchParams.set(key, String(value));
    }
    let body: string | undefined;
    try { body = request.body === undefined ? undefined : JSON.stringify(request.body); }
    catch { throw failure('validation_error', 'Invalid request body.'); }
    const deadline = Math.min(ctx.deadlineMs, ctx.startedAtMs + 60000);
    if (!Number.isFinite(deadline) || deadline <= clock.now() || ctx.signal.aborted) throw failure('timeout', 'Call deadline exceeded.', { retryable: true });
    const call = new AbortController();
    const cancel = () => call.abort();
    ctx.signal.addEventListener('abort', cancel, { once: true });
    const callTimer = setTimeout(cancel, Math.max(0, deadline - clock.now()));
    try {
      for (let attempt = 0; attempt < (mutation ? 1 : 3); attempt++) {
        if (clock.now() >= deadline || call.signal.aborted) throw failure('timeout', 'Call deadline exceeded.', { retryable: true });
        const release = await acquire(call.signal);
        let sent = false;
        const controller = new AbortController();
        const abort = () => controller.abort();
        call.signal.addEventListener('abort', abort, { once: true });
        const timer = setTimeout(abort, Math.min(config.timeoutMs, Math.max(0, deadline - clock.now())));
        try {
          if (call.signal.aborted || clock.now() >= deadline) throw failure('timeout', 'Call deadline exceeded.', { retryable: true });
          const now = clock.now();
          accounting.times = accounting.times.filter(time => time > now - HOUR);
          if (accounting.limitUntil <= now) accounting.limit = 200;
          const releaseAt = Math.max(accounting.blockedUntil, accounting.times.length >= accounting.limit ? accounting.times[0] + HOUR : 0);
          if (releaseAt > now) throw failure('rate_limited', 'Local rolling-hour request quota exhausted.', {
            retryable: true, retry_after_seconds: Math.ceil((releaseAt - now) / 1000),
          });
          accounting.times.push(now); sent = true;
          const result = await abortable((async (): Promise<ApiReply> => {
            const response = await fetcher(url.toString(), {
              method: request.method, headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
              body, redirect: 'error', signal: controller.signal,
            });
            if (response.redirected || (response.status >= 300 && response.status < 400)) {
              await response.body?.cancel().catch(() => {});
              throw failure('upstream_error', 'Upstream redirects are forbidden.');
            }
            const rateLimit = rate(response);
            const guidance = retryAfter(response, clock.now());
            if (rateLimit?.limit !== undefined) {
              accounting.limit = Math.min(200, rateLimit.limit);
              accounting.limitUntil = clock.now() + HOUR;
            }
            if (response.status === 429 || (rateLimit?.used !== undefined && rateLimit.limit !== undefined && rateLimit.used >= rateLimit.limit)) {
              accounting.blockedUntil = clock.now() + (guidance === undefined ? HOUR : Math.max(1, guidance) * 1000);
            }
            if (rateLimit?.used !== undefined && rateLimit.used > accounting.times.length) {
              // Unknown external request times are conservatively held for a full hour.
              const additional = Math.min(200, rateLimit.used) - accounting.times.length;
              accounting.times.push(...Array.from({ length: Math.max(0, additional) }, () => clock.now()));
            }
            const text = await readBody(response, controller.signal);
            if (response.status >= 200 && response.status < 300) {
              const envelope = parse(text);
              if (!object(envelope) || !object(envelope.data) || 'error' in envelope) throw failure('upstream_error', 'Invalid upstream data envelope.');
              return { data: envelope.data, fetchedAt: new Date(clock.now()).toISOString(), rateLimit: rateLimit ?? { used: accounting.times.length, limit: accounting.limit, estimated: true } };
            }
            const codes: Record<number, ErrorCode> = { 400: 'validation_error', 401: 'authentication_error', 403: 'permission_denied', 404: 'not_found', 409: 'conflict', 429: 'rate_limited' };
            const code = codes[response.status] ?? 'upstream_error';
            let upstream: ToolError['upstream'];
            try {
              const envelope = parse(text);
              if (object(envelope) && object(envelope.error)) {
                const { id, name, detail } = envelope.error;
                if (typeof id === 'string' && typeof name === 'string' && typeof detail === 'string') upstream = { id: redact(id), name: redact(name), detail: redact(detail) };
              }
            } catch { /* Malformed error bodies do not obscure authoritative HTTP statuses. */ }
            throw failure(code, 'YNAB rejected the request.', { http_status: response.status, upstream,
              retryable: response.status === 429 || [502, 503, 504].includes(response.status),
              ...(guidance === undefined ? (response.status === 429 ? { retry_after_seconds: Math.max(1, Math.ceil((accounting.blockedUntil - clock.now()) / 1000)) } : {}) : { retry_after_seconds: guidance }),
            });
          })(), controller.signal);
          return result;
        } catch (err) {
          const safe = err instanceof ToolFailure ? err : failure('upstream_error', 'Upstream connection failed.', { retryable: true });
          const uncertain = sent && mutation && (safe.error.http_status === undefined || safe.error.http_status >= 500) && safe.error.code !== 'rate_limited';
          if (uncertain) throw failure('outcome_unknown', 'Mutation outcome is unknown; inspect current state before another attempt.', {
            outcome: 'unknown', ...(safe.error.http_status === undefined ? {} : { http_status: safe.error.http_status }), upstream: safe.error.upstream,
          });
          const transient = !(err instanceof ToolFailure) || [502, 503, 504].includes(safe.error.http_status ?? 0);
          if (!mutation && transient && attempt < 2 && !call.signal.aborted && clock.now() < deadline) continue;
          throw safe;
        } finally {
          clearTimeout(timer); call.signal.removeEventListener('abort', abort); controller.abort(); release();
        }
      }
      throw failure('upstream_error', 'Upstream request failed.');
    } finally { clearTimeout(callTimer); ctx.signal.removeEventListener('abort', cancel); }
  } });
}
