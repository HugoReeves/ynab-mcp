import { readFileSync } from 'node:fs';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { default as formats } from 'ajv-formats';
import type { ValidateFunction } from 'ajv';
import type { ToolDefinition, ToolName } from './contracts.js';

export interface LoadedCatalog {
  readonly catalog: readonly ToolDefinition[];
  readonly inputValidators: ReadonlyMap<ToolName, ValidateFunction>;
  readonly outputValidators: ReadonlyMap<ToolName, ValidateFunction>;
}

function freeze(value: unknown): void {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
}

function assertLocalSchema(schema: unknown): void {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) throw new Error('Invalid catalog schema');
  const root = schema as Record<string, unknown>;
  if (root.$schema !== 'https://json-schema.org/draft/2020-12/schema' || root.type !== 'object') {
    throw new Error('Catalog requires object schemas in draft 2020-12');
  }
  function walk(value: unknown): void {
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      if (key === '$ref' && (typeof child !== 'string' || !child.startsWith('#/$defs/'))) {
        throw new Error('Catalog schemas must be self-contained');
      }
      if (key === '$id' || key === '$dynamicRef') throw new Error('Unsupported catalog reference scope');
      walk(child);
    }
  }
  walk(root);
}

// Package-relative in both src/ and dist/; docs/tool-catalog.json is a package asset.
export function loadCatalog(url = new URL('../docs/tool-catalog.json', import.meta.url)): LoadedCatalog {
  const ajv = new Ajv2020({ strict: false, allErrors: true, coerceTypes: false,
    useDefaults: false, removeAdditional: false });
  // ajv-formats is a CommonJS callable; its public default declaration is wrapped in NodeNext.
  const addFormats = formats as unknown as typeof import('ajv-formats').default;
  addFormats(ajv);
  const metadata = ajv.compile({
    type: 'object', required: ['format_version', 'tools'],
    properties: {
      format_version: { const: 1 },
      tools: { type: 'array', minItems: 35, maxItems: 35, items: {
        type: 'object', required: ['name', 'description', 'profile', 'permissions', 'upstream', 'inputSchema', 'outputSchema', 'annotations'],
        properties: {
          name: { type: 'string', pattern: '^ynab_[a-z_]+$' }, description: { type: 'string' },
          profile: { enum: ['core', 'extended'] }, pageCollection: { type: 'string' },
          permissions: { type: 'object', required: ['write', 'delete', 'imports'],
            additionalProperties: false, properties: { write: { type: 'boolean' }, delete: { type: 'boolean' }, imports: { type: 'boolean' } } },
          upstream: { type: 'array', minItems: 1, items: { type: 'object', required: ['method', 'path'],
            properties: { method: { enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] }, path: { type: 'string', pattern: '^/' } } } },
          inputSchema: { type: 'object' }, outputSchema: { type: 'object' },
          annotations: { type: 'object', required: ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint'],
            additionalProperties: false, properties: { readOnlyHint: { type: 'boolean' }, destructiveHint: { type: 'boolean' },
              idempotentHint: { type: 'boolean' }, openWorldHint: { type: 'boolean' } } },
        },
      } },
    },
  });
  const document: unknown = JSON.parse(readFileSync(url, 'utf8'));
  if (!metadata(document)) throw new Error('Invalid catalog metadata');
  const tools = (document as { tools: ToolDefinition[] }).tools;
  const inputs = new Map<ToolName, ValidateFunction>();
  const outputs = new Map<ToolName, ValidateFunction>();
  for (const tool of tools) {
    if (inputs.has(tool.name)) throw new Error('Duplicate catalog tool');
    assertLocalSchema(tool.inputSchema);
    assertLocalSchema(tool.outputSchema);
    inputs.set(tool.name, ajv.compile(tool.inputSchema));
    outputs.set(tool.name, ajv.compile(tool.outputSchema));
  }
  if (tools.filter(t => t.profile === 'core').length !== 25) throw new Error('Invalid catalog profiles');
  freeze(tools);
  return { catalog: tools, inputValidators: inputs, outputValidators: outputs };
}

export const { catalog, inputValidators, outputValidators } = loadCatalog();
