import { Server } from '@modelcontextprotocol/server';
import { catalog } from '../catalog.js';
import type { Dispatcher } from './dispatcher.js';

/** Low-level adapter only: transport and concrete service composition belong to the caller. */
export function createProtocolServer(dispatcher: Dispatcher): Server {
  const server = new Server({ name: 'ynab-mcp', version: '0.1.0' }, { capabilities: { tools: {} } });
  server.setRequestHandler('tools/list', () => ({
    tools: dispatcher.listTools().map(tool => ({
      name: tool.name, description: tool.description,
      inputSchema: tool.inputSchema as { type: 'object'; [key: string]: unknown },
      outputSchema: tool.outputSchema, annotations: tool.annotations,
    })),
  }));
  server.setRequestHandler('tools/call', async (request, ctx) => {
    const result = await dispatcher.callTool(request.params.name, request.params.arguments, ctx.mcpReq.signal);
    const tool = catalog.find(tool => tool.name === request.params.name);
    return server.projectCallToolResult(result, tool?.outputSchema);
  });
  return server;
}
