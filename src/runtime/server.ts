import type { Server } from '@modelcontextprotocol/server';
import type { Clock, Connection, Services } from '../contracts.js';
import { createSafetyState } from '../safety/index.js';
import { createReadTools } from '../tools/read.js';
import { createTransactionTools } from '../tools/transactions.js';
import { createMaintenanceTools } from '../tools/maintenance.js';
import { createDispatcher } from './dispatcher.js';
import { createProtocolServer } from './protocol.js';

export function createServer(connection: Connection, clock: Clock = { now: () => Date.now() }): Server {
  const services: Services = {
    config: connection.config, api: connection.api, clock,
    state: createSafetyState(connection.config, connection.api, clock),
  };
  return createProtocolServer(createDispatcher(services, {
    ...createReadTools(services),
    ...createTransactionTools(services),
    ...createMaintenanceTools(services),
  }));
}
