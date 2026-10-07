import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import type { Clock, Config, Connection } from './contracts.js';
import { ToolFailure } from './errors.js';
import { createApi, isUuid } from './ynab/client.js';

function invalid(): never {
  throw new ToolFailure({ code: 'configuration_error', message: 'Invalid YNAB configuration or token source.', retryable: false, outcome: 'not_applied' });
}

export async function createConnection(
  env: Readonly<Record<string, string | undefined>>,
  options?: { fetch?: typeof globalThis.fetch; clock?: Clock },
): Promise<Connection> {
  const bool = (key: string, fallback: boolean): boolean => {
    const value = env[key];
    if (value === undefined) return fallback;
    if (value !== 'true' && value !== 'false') invalid();
    return value === 'true';
  };
  const integer = (key: string, fallback: number, min: number, max: number): number => {
    const value = env[key];
    if (value === undefined) return fallback;
    if (!/^(0|[1-9][0-9]*)$/.test(value)) invalid();
    const number = Number(value);
    if (!Number.isSafeInteger(number) || number < min || number > max) invalid();
    return number;
  };
  const choice = <T extends string>(key: string, fallback: T, choices: readonly T[]): T => {
    const value = env[key] ?? fallback;
    if (!choices.includes(value as T)) invalid();
    return value as T;
  };
  const uuid = (value: string): string => {
    if (!isUuid(value)) invalid();
    return value.toLowerCase();
  };
  const allowedPlanIds = env.YNAB_ALLOWED_PLAN_IDS === undefined ? null : Object.freeze(env.YNAB_ALLOWED_PLAN_IDS.split(',').map(uuid));
  const defaultPlanId = env.YNAB_PLAN_ID === undefined ? undefined : uuid(env.YNAB_PLAN_ID);
  if (defaultPlanId && allowedPlanIds && !allowedPlanIds.includes(defaultPlanId)) invalid();
  const config: Config = Object.freeze({
    ...(defaultPlanId ? { defaultPlanId } : {}), allowedPlanIds,
    readOnly: bool('YNAB_READ_ONLY', true), allowDeletes: bool('YNAB_ALLOW_DELETES', false),
    allowReconciledChanges: bool('YNAB_ALLOW_RECONCILED_CHANGES', false), allowImports: bool('YNAB_ALLOW_IMPORTS', false),
    toolProfile: choice('YNAB_TOOL_PROFILE', 'core', ['core', 'extended']),
    timeoutMs: integer('YNAB_TIMEOUT_MS', 20000, 1000, 60000),
    cacheTtlSeconds: integer('YNAB_CACHE_TTL_SECONDS', 30, 0, 300),
    logLevel: choice('YNAB_LOG_LEVEL', 'warn', ['error', 'warn', 'info']),
  });
  if ((env.YNAB_ACCESS_TOKEN !== undefined) === (env.YNAB_ACCESS_TOKEN_FILE !== undefined)) invalid();
  let token = env.YNAB_ACCESS_TOKEN;
  if (env.YNAB_ACCESS_TOKEN_FILE !== undefined) {
    const path = env.YNAB_ACCESS_TOKEN_FILE;
    if (!isAbsolute(path)) invalid();
    try {
      // Inspect the opened inode, not a racy stat/read pair. Never follow symlinks.
      const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const stat = await file.stat();
        if (!stat.isFile() || stat.size > 65536 || (process.platform !== 'win32' &&
          (stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0 || (stat.mode & 0o400) === 0))) invalid();
        const bytes = Buffer.alloc(65537); let size = 0;
        while (size < bytes.length) {
          const { bytesRead } = await file.read(bytes, size, bytes.length - size, size);
          if (!bytesRead) break;
          size += bytesRead;
        }
        if (size > 65536) invalid();
        token = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, size));
      } finally { await file.close(); }
    } catch { invalid(); }
  }
  token = token?.trim();
  if (!token || !/^[\x21-\x7e]+$/.test(token)) invalid();
  return Object.freeze({ config, api: createApi(config, token, options?.fetch ?? globalThis.fetch, options?.clock ?? { now: () => Date.now() }) });
}
