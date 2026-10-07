import { describe, expect, it, vi } from 'vitest';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { catalog } from '../../src/catalog.js';
import { createDispatcher } from '../../src/runtime/dispatcher.js';
import { createProtocolServer } from '../../src/runtime/protocol.js';
import { fakeServices, ok } from '../integration/protocol-fixture.js';

describe('low-level protocol adapter', () => {
  it('uses official legacy discovery/call with exact schemas and structured errors, emitting no console output', async () => {
    const services = fakeServices(); const log = vi.spyOn(console, 'log');
    const server = createProtocolServer(createDispatcher(services, { ynab_get_user: async () => ok }));
    const client = new Client({ name: 'fixture', version: '1' }, { versionNegotiation: { mode: 'legacy' } });
    const [a, b] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(b); await client.connect(a);
      const tools = await client.listTools();
      expect(tools.tools).toEqual(catalog.filter(t => services.state.available(t)).map(t => ({ name: t.name, description: t.description, inputSchema: t.inputSchema, outputSchema: t.outputSchema, annotations: t.annotations })));
      const success = await client.callTool({ name: 'ynab_get_user', arguments: {} });
      expect(success.structuredContent).toEqual(ok); expect(success.isError).toBe(false);
      expect(success.content?.every(c => c.type === 'text')).toBe(true);
      for (const [name, args, code] of [['ynab_get_user', { extra: true }, 'validation_error'], ['ynab_create_account', {}, 'permission_denied'], ['bogus', {}, 'unsupported_operation']] as const) {
        const result = await client.callTool({ name, arguments: args });
        expect(result.isError).toBe(true);
        expect(result.structuredContent).toMatchObject({ status: 'error', error: { code } });
      }
      expect(log).not.toHaveBeenCalled();
    } finally { await client.close(); await server.close(); log.mockRestore(); }
  });
});
