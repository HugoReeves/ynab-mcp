import type { HandlerMap, Services } from '../contracts.js';
import { createScheduledTools } from './scheduled.js';
import { createAccountPayeeTools } from './account-payees.js';
import { createCategoryTools } from './categories.js';

export function createMaintenanceTools(services: Services): HandlerMap {
  return {
    ...createScheduledTools(services),
    ...createAccountPayeeTools(services),
    ...createCategoryTools(services),
  };
}
