import { expect, it } from 'vitest';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { fakeServices, id } from '../integration/protocol-fixture.js';

it('composes the frozen service/tool factories into the full server', async () => {
  // Expected missing-tool import blocker until the manager merges the three handler streams.
  const { createServer } = await import('../../src/runtime/server.js');
  const fixture = fakeServices();
  const server = createServer({ config: fixture.config, api: {
    request: async () => ({ data: { user: { id } }, fetchedAt: '2026-01-01T00:00:00.000Z' }),
  } }, { now: () => Date.parse('2026-01-01T00:00:00Z') });
  const client = new Client({ name: 'composition-fixture', version: '1' }, { versionNegotiation: { mode: 'legacy' } });
  const [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(b); await client.connect(a);
    expect((await client.listTools()).tools).toHaveLength(15);
    const result = await client.callTool({ name: 'ynab_get_user', arguments: {} });
    expect(result.isError).toBe(false);
    expect(result.structuredContent).toMatchObject({ status: 'ok', data: { user: { id } } });
  } finally { await client.close(); await server.close(); }
});
