import { randomUUID } from 'node:crypto';
import type { CallToolResult } from '@modelcontextprotocol/server';
import { catalog, inputValidators, outputValidators } from '../catalog.js';
import type { CallContext, HandlerMap, JsonObject, Services, ToolError, ToolResult } from '../contracts.js';
import { ToolFailure } from '../errors.js';

const INPUT_LIMIT = 1024 * 1024;
const OUTPUT_LIMIT = 512 * 1024;
const DEADLINE_MS = 60000;
export type DispatchResult = CallToolResult & { structuredContent: ToolResult; isError: boolean };
export interface Dispatcher {
  listTools(): typeof catalog;
  callTool(name: string, args: unknown, signal?: AbortSignal): Promise<DispatchResult>;
}

/** JSON bytes, not JS string length; serialization failures are contained at the boundary. */
function json(value: unknown, limit: number): string {
  const text = JSON.stringify(value);
  if (text === undefined) throw new Error('Non-JSON value');
  if (Buffer.byteLength(text, 'utf8') > limit) throw new RangeError('Size limit');
  return text;
}

export function createDispatcher(services: Services, handlers: HandlerMap): Dispatcher {
  const definitions = new Map(catalog.map(tool => [tool.name as string, tool]));
  return {
    listTools: () => catalog.filter(tool => {
      try { return services.state.available(tool); }
      catch { return false; } // Discovery fails closed, without leaking exception text.
    }),
    async callTool(name, rawArgs, signal) {
      const tool = definitions.get(name);
      // Even an unexpected infrastructure exception must not escape the tool boundary.
      let startedAtMs = Date.now();
      try {
        const now = services.clock.now();
        if (Number.isFinite(now) && !Number.isNaN(new Date(now).getTime())) startedAtMs = now;
      } catch { /* Use a safe timestamp for the error boundary. */ }
      const meta = { request_id: randomUUID(), fetched_at: new Date(startedAtMs).toISOString(), warnings: [] };
      let invoked = false;
      let planId: string | undefined;
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const abort = () => controller.abort();
      const outcome = () => invoked && tool && !tool.annotations.readOnlyHint ? 'unknown' as const : 'not_applied' as const;
      const failure = (code: ToolError['code'], message: string, establishedOutcome: ToolError['outcome'] = outcome()): ToolResult => ({
        status: 'error', error: { code, message, retryable: code === 'timeout' && establishedOutcome === 'not_applied', outcome: establishedOutcome },
        meta: { ...meta, ...(planId === undefined ? {} : { plan_id: planId }) },
      });
      const envelope = (result: ToolResult): DispatchResult => ({
        structuredContent: result,
        content: [{ type: 'text', text: result.status === 'error' ? `YNAB tool error: ${result.error.code}.` : `YNAB tool result: ${result.status}.` }],
        isError: result.status === 'error',
      });
      const validate = outputValidators.get(tool?.name ?? 'ynab_get_user')!;
      const safeResponse = (code: ToolError['code'], message: string, establishedOutcome: ToolError['outcome'] = outcome()): DispatchResult => {
        // Discard invalid handler/state metadata as well as invalid output data.
        const result = { ...failure(code, message, establishedOutcome), meta };
        validate(result);
        const reply = envelope(result);
        json(reply, OUTPUT_LIMIT);
        return reply;
      };
      const finish = (result: ToolResult): DispatchResult => {
        let establishedOutcome: ToolError['outcome'] = outcome();
        try {
          // Validate the JSON snapshot before bounding it: size does not erase an
          // acknowledged application outcome. Invalid/non-JSON results remain uncertain.
          const snapshot: ToolResult = JSON.parse(json(result, Infinity));
          if (!validate(snapshot)) return safeResponse('upstream_error', 'Tool returned an invalid result.');
          establishedOutcome = snapshot.status === 'error' ? snapshot.error.outcome
            : snapshot.status === 'preview' || tool?.annotations.readOnlyHint ? 'not_applied' : 'applied';
          const reply = envelope(snapshot);
          json(reply, OUTPUT_LIMIT);
          return reply;
        } catch (error) {
          return safeResponse(error instanceof RangeError ? 'response_too_large' : 'upstream_error',
            error instanceof RangeError ? 'Tool result exceeds the size limit.' : 'Tool returned an invalid result.', establishedOutcome);
        }
      };
      try {
        if (!tool) return finish(failure('unsupported_operation', 'Unknown tool.'));
        // Direct calls must enforce the same policy as discovery, even with invalid arguments.
        services.state.assertAvailable(tool);
        const args = rawArgs === undefined ? {} : rawArgs;
        try { json(args, INPUT_LIMIT); }
        catch { return finish(failure('validation_error', 'Arguments are not bounded JSON.')); }
        if (!inputValidators.get(tool.name)!(args)) return finish(failure('validation_error', 'Invalid tool arguments.'));
        if (signal?.aborted) return finish(failure('timeout', 'Tool request cancelled.'));
        signal?.addEventListener('abort', abort, { once: true });
        if (tool.upstream.some(route => route.path.includes('/plans/'))) {
          planId = services.state.resolvePlan((args as JsonObject).plan_id as string | undefined);
        }
        const handler = handlers[tool.name];
        if (!handler) return finish(failure('unsupported_operation', 'Tool handler is unavailable.'));
        const ctx: CallContext = {
          tool, requestId: meta.request_id, startedAtMs, deadlineMs: startedAtMs + DEADLINE_MS,
          ...(planId === undefined ? {} : { planId }), signal: controller.signal,
        };
        const remaining = ctx.deadlineMs - services.clock.now();
        if (controller.signal.aborted || remaining <= 0) return finish(failure('timeout', 'Tool request deadline exceeded.'));
        const cancelled = new Promise<ToolResult>(resolve => {
          controller.signal.addEventListener('abort', () => resolve(failure('timeout', 'Tool request cancelled or deadline exceeded.')), { once: true });
        });
        timer = setTimeout(abort, remaining);
        // A race bounds even uncooperative handlers; Promise.race also consumes late rejections.
        const result = await Promise.race([Promise.resolve().then(() => {
          if (controller.signal.aborted) return failure('timeout', 'Tool request cancelled.');
          invoked = true;
          return handler(args as JsonObject, ctx);
        }), cancelled]);
        return finish(result);
      } catch (error) {
        return finish(error instanceof ToolFailure
          ? { status: 'error', error: error.error, meta: { ...meta, ...(planId === undefined ? {} : { plan_id: planId }) } }
          : failure('upstream_error', 'Tool request failed.'));
      } finally {
        if (timer !== undefined) clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
      }
    },
  };
}
