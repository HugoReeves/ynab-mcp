import type { Meta, ToolError } from '../../src/contracts.js';

export const fixtureMeta: Meta = {
  request_id: 'fixture-request', fetched_at: '2026-01-01T00:00:00.000Z', warnings: [],
};
export const fixtureError: ToolError = {
  code: 'validation_error', message: 'Invalid arguments', retryable: false, outcome: 'not_applied',
};
