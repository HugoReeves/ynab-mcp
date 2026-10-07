#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import type { Server } from '@modelcontextprotocol/server';
import { serveStdio, StdioServerTransport, type StdioServerHandle } from '@modelcontextprotocol/server/stdio';
import { createConnection } from './config.js';

export const VERSION = '0.1.0';
// 1 MiB tool arguments plus bounded JSON-RPC/envelope overhead. SDK bounds bytes before decoding.
export const MAX_STDIO_BUFFER_BYTES = 2 * 1024 * 1024;
const USAGE = 'Usage: ynab-mcp [--help | --version]\nServe MCP over stdio using explicitly supplied YNAB environment configuration.\n';

/** Injectable transport entry for offline fixtures; production composition stays in createServer. */
export function startStdio(factory: () => Server): StdioServerHandle {
  const transport = new StdioServerTransport(process.stdin, process.stdout, { maxBufferSize: MAX_STDIO_BUFFER_BYTES });
  let handle: StdioServerHandle;
  let closing = false;
  const cleanup = () => {
    process.off('SIGINT', stop); process.off('SIGTERM', stop);
  };
  const shutdown = async (code = 0) => {
    if (closing) return;
    closing = true; process.exitCode = code; cleanup();
    try { await handle.close(); }
    catch { process.stderr.write('YNAB MCP transport failed.\n'); process.exitCode = 1; }
    finally { process.stdin.destroy(); }
  };
  const stop = () => { void shutdown(); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  try {
    handle = serveStdio(factory, { legacy: 'serve', transport, onerror: () => {
      // Never include SDK exceptions, arguments, environment values, or financial data.
      process.stderr.write('YNAB MCP transport failed.\n');
      void shutdown(1);
    } });
  } catch {
    cleanup(); throw new Error('Unable to start MCP transport.');
  }
  const closed = transport.onclose;
  transport.onclose = () => { closed?.(); cleanup(); };
  return { close: () => shutdown() };
}

export async function runCli(args: readonly string[] = process.argv.slice(2)): Promise<void> {
  if (args.length === 1 && args[0] === '--help') { process.stdout.write(USAGE); return; }
  if (args.length === 1 && args[0] === '--version') { process.stdout.write(`${VERSION}\n`); return; }
  if (args.length) { process.stderr.write(USAGE); process.exitCode = 2; return; }
  try {
    // No dotenv/automatic file loading. Only the explicit local launcher uses Node --env-file.
    const connection = await createConnection(process.env);
    const { createServer } = await import('./runtime/server.js');
    startStdio(() => createServer(connection));
  } catch {
    process.stderr.write('YNAB MCP startup failed. Check configuration and installation.\n');
    process.exitCode = 1;
  }
}

// Importing this module for an injected fixture must not read credentials or start a server.
let direct = false;
try { direct = !!process.argv[1] && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url; }
catch { /* An imported entry is not a CLI invocation. */ }
if (direct) await runCli();
