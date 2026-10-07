import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { ApiRequest, CallContext, Config, Connection, JsonObject } from '../../src/contracts.js';

export const plan = '11111111-1111-4111-8111-111111111111';
export const id = '22222222-2222-4222-8222-222222222222';
export const config: Config = {
  defaultPlanId: plan, allowedPlanIds: [plan], readOnly: false, allowDeletes: false,
  allowReconciledChanges: false, allowImports: false, toolProfile: 'extended',
  timeoutMs: 20000, cacheTtlSeconds: 30, logLevel: 'error',
};
export const stamp = '2026-01-01T00:00:00.000Z';
export function fixture(respond: (ctx: CallContext, req: ApiRequest) => Promise<JsonObject> = async () => ({ user: { id } })) {
  const requests: ApiRequest[] = [];
  const connection: Connection = { config, api: { async request(ctx, req) {
    requests.push(req); return { data: await respond(ctx, req), fetchedAt: stamp };
  } } };
  return { connection, requests };
}
export async function client(url: URL, era: 'legacy' | 'modern' = 'modern') {
  const value = new Client({ name: 'offline-http-test', version: '1' }, {
    versionNegotiation: { mode: era === 'legacy' ? 'legacy' : { pin: '2026-07-28' } },
  });
  await value.connect(new StreamableHTTPClientTransport(url)); return value;
}
export function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}
