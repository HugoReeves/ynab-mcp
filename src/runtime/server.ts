import type { Server } from '@modelcontextprotocol/server';
import type { Clock, Connection, Services } from '../contracts.js';
import { createSafetyState } from '../safety/index.js';
import { createReadTools } from '../tools/read.js';
import { createTransactionTools } from '../tools/transactions.js';
import { createMaintenanceTools } from '../tools/maintenance.js';
import { createDispatcher } from './dispatcher.js';
import { createProtocolServer } from './protocol.js';

/** One process owns one API, policy scope, cache, cursor store, and plan-lock table. */
export function createServices(connection: Connection, clock: Clock = { now: () => Date.now() }): Services {
  return {
    config: connection.config, api: connection.api, clock,
    state: createSafetyState(connection.config, connection.api, clock),
  };
}

/** Reuse the dispatcher, never a connected protocol Server, across HTTP exchanges. */
export function createServerFactory(connection: Connection, clock?: Clock): () => Server {
  const services = createServices(connection, clock);
  const dispatcher = createDispatcher(services, {
    ...createReadTools(services),
    ...createTransactionTools(services),
    ...createMaintenanceTools(services),
  });
  return () => createProtocolServer(dispatcher);
}

export function createServer(connection: Connection, clock?: Clock): Server {
  return createServerFactory(connection, clock)();
}
