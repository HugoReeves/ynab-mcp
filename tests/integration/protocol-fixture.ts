import type { Services, ToolResult } from '../../src/contracts.js';
import { ToolFailure } from '../../src/errors.js';
export const id = '00000000-0000-4000-8000-000000000001';
export const meta = { request_id: 'fixture', fetched_at: '2026-01-01T00:00:00.000Z', warnings: [] };
export const ok: ToolResult = { status: 'ok', data: { user: { id } }, meta };
export function fakeServices(): Services {
  const unavailable = () => { throw new Error('Unused fixture service'); };
  return {
    config: { readOnly: true, allowDeletes: false, allowImports: false, allowReconciledChanges: false,
      allowedPlanIds: null, toolProfile: 'core', timeoutMs: 10000, cacheTtlSeconds: 0, logLevel: 'error' },
    api: { request: unavailable }, clock: { now: () => Date.now() },
    state: { available: t => t.annotations.readOnlyHint && t.profile === 'core',
      assertAvailable(t) { if (!this.available(t)) throw new ToolFailure({ code: 'permission_denied', message: 'Tool unavailable', retryable: false, outcome: 'not_applied' }); },
      resolvePlan: () => id, meta: () => meta, get: unavailable, inspect: unavailable, revision: unavailable,
      page: unavailable, write: unavailable, invalidatePlan: unavailable },
  };
}
