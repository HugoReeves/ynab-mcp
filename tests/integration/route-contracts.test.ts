import { afterEach, describe, expect, it } from 'vitest';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import type { ApiRequest, Config, JsonObject, ToolName, ToolResult } from '../../src/contracts.js';
import { catalog, inputValidators, outputValidators } from '../../src/catalog.js';
// Recorded TDD red on main foundation 28e4756:
// npm test -- tests/integration/route-contracts.test.ts -> 1 failed suite,
// 0 collected tests, Cannot find module '../../src/runtime/server.js'.
// npm run typecheck -> only TS2307 for this same intentionally absent module.
// Separate offline fixture checks validated 42 inputs + 24 read envelopes
// + 18 mutation reply envelopes. Compiler lint also reports only TS2307.
// No production stub: this suite must exercise real composition/services/safety.
import { createServer } from '../../src/runtime/server.js';
import { clock, config, Ledger, liveArgs, reads, selectorReads, writes } from './route-fixtures.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
async function connect(overrides: Partial<Config> = {}) {
  const api = new Ledger();
  const server = createServer({ config: { ...config, ...overrides }, api }, clock);
  const client = new Client({ name: 'independent-route-contracts', version: '1' }, { versionNegotiation: { mode: 'legacy' } });
  cleanups.push(async () => { await client.close(); await server.close(); });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { api, client };
}
async function call(client: Client, name: ToolName, args: JsonObject): Promise<ToolResult> {
  const result = await client.callTool({ name, arguments: args });
  const validator = outputValidators.get(name)!;
  expect(validator(result.structuredContent), JSON.stringify(validator.errors)).toBe(true);
  const envelope = result.structuredContent as unknown as ToolResult;
  expect(result.isError).toBe(envelope.status === 'error');
  expect(result.content?.some(block => block.type === 'text')).toBe(true);
  return envelope;
}
const mutations = (requests: readonly ApiRequest[]) => requests.filter(request => request.method !== 'GET');
// Ignore representational absence of empty query/body, not extra keys/fields.
function normalized(request: ApiRequest) {
  return { method: request.method, path: request.path, query: request.query ?? {}, body: request.body ?? null };
}

describe('independent offline route contracts through real server and official client', () => {
  it('has independently enumerated valid fixtures for exactly all 35 tools (17 reads + 18 writes)', () => {
    const cases = [...reads, ...writes];
    expect(reads).toHaveLength(17); expect(writes).toHaveLength(18);
    expect(new Set(cases.map(test => test.name)).size).toBe(35);
    expect(cases.map(test => test.name).sort()).toEqual(catalog.map(tool => tool.name).sort());
    for (const test of [...cases, ...selectorReads]) {
      const validator = inputValidators.get(test.name)!;
      expect(validator(test.args), `${test.name}: ${JSON.stringify(validator.errors)}`).toBe(true);
    }
  });

  it.each([
    { label: 'core read-only', overrides: { toolProfile: 'core', readOnly: true } as Partial<Config>, names: reads.slice(0, 15).map(test => test.name) },
    { label: 'extended read-only', overrides: { readOnly: true } as Partial<Config>, names: reads.map(test => test.name) },
    { label: 'full permissions', overrides: {}, names: [...reads, ...writes].map(test => test.name) },
  ])('discovers $label exactly', async ({ overrides, names }) => {
    const { client, api } = await connect(overrides);
    const result = await client.listTools();
    expect(result.tools.map(tool => tool.name).sort()).toEqual([...names].sort());
    for (const tool of result.tools) {
      const definition = catalog.find(item => item.name === tool.name)!;
      expect(tool.inputSchema).toEqual(definition.inputSchema);
      expect(tool.outputSchema).toEqual(definition.outputSchema);
    }
    expect(api.requests).toEqual([]);
  });

  it.each([...reads, ...selectorReads])('$name maps selectors to independent GET contract: $request.path', async test => {
    const { client, api } = await connect();
    const result = await call(client, test.name, test.args);
    expect(result.status).toBe('ok');
    expect(api.requests.map(normalized)).toContainEqual(normalized(test.request));
    // All read-side requests must be GETs; auxiliary inspection GETs are allowed.
    expect(mutations(api.requests)).toEqual([]);
    const primary = api.requests.filter(request => request.path === test.request.path);
    expect(primary.length).toBeGreaterThan(0);
    for (const request of primary) expect(normalized(request)).toEqual(normalized(test.request));
  });

  it.each(writes)('$name previews without mutations, then executes exact independent contract', async test => {
    const { client, api } = await connect();
    const preview = await call(client, test.name, test.args); // default dry_run must be true
    expect(preview.status).toBe('preview');
    expect(mutations(api.requests)).toEqual([]);
    if (preview.status !== 'preview') throw new Error('Expected preview');
    expect({ method: preview.preview.method, path: preview.preview.path, body: preview.preview.body }).toEqual({
      method: test.request.method, path: test.request.path, body: test.request.body ?? null,
    });
    if (test.target) {
      expect(api.requests.some(request => request.path === test.target)).toBe(true);
      expect(Object.values(preview.preview.expected_revisions)).toHaveLength(1);
    }
    const start = api.requests.length;
    const args = liveArgs(test, preview.preview.expected_revisions);
    const validator = inputValidators.get(test.name)!;
    expect(validator(args), JSON.stringify(validator.errors)).toBe(true);
    const result = await call(client, test.name, args);
    expect(result.status).toBe('ok');
    const execution = api.requests.slice(start);
    expect(mutations(execution).map(normalized)).toEqual([normalized(test.request)]);
    if (test.target) {
      const mutationIndex = execution.findIndex(request => request.method !== 'GET');
      // Fresh inspection on live execution (not reused from preview).
      expect(execution.slice(0, mutationIndex).some(request => request.method === 'GET' && request.path === test.target)).toBe(true);
    }
    // Exact body comparisons above specifically prevent approval/category helpers
    // from replaying unrelated amounts, dates, memo, cleared or approval fields.
  });

  it.each([...reads, ...writes])('$name rejects extra input before upstream activity', async test => {
    const { client, api } = await connect();
    const result = await call(client, test.name, { ...test.args, unexpected_route_contract_field: true });
    expect(result).toMatchObject({ status: 'error', error: { code: 'validation_error', outcome: 'not_applied' } });
    expect(api.requests).toEqual([]);
  });

  it.each(writes)('$name cannot bypass read-only permission with a direct call', async test => {
    const { client, api } = await connect({ readOnly: true });
    const result = await call(client, test.name, { ...test.args, dry_run: false });
    expect(result).toMatchObject({ status: 'error', error: { code: 'permission_denied', outcome: 'not_applied' } });
    expect(mutations(api.requests)).toEqual([]);
  });

  it.each(writes.filter(test => test.request.method === 'DELETE' || test.name === 'ynab_import_transactions'))(
    '$name requires its separate delete/import permission even for preview', async test => {
      const { client, api } = await connect(test.request.method === 'DELETE' ? { allowDeletes: false } : { allowImports: false });
      const result = await call(client, test.name, test.args);
      expect(result).toMatchObject({ status: 'error', error: { code: 'permission_denied', outcome: 'not_applied' } });
      expect(mutations(api.requests)).toEqual([]);
      const discovered = await client.listTools();
      expect(discovered.tools.map(tool => tool.name)).not.toContain(test.name);
    },
  );

  it.each(writes.filter(test => test.request.method === 'DELETE'))('$name requires live confirmation after fresh revision', async test => {
    const { client, api } = await connect();
    const preview = await call(client, test.name, test.args);
    if (preview.status !== 'preview') throw new Error('Expected preview');
    const result = await call(client, test.name, { ...liveArgs(test, preview.preview.expected_revisions), confirm_delete: false });
    expect(result.status).toBe('error');
    expect(mutations(api.requests)).toEqual([]);
  });
});
