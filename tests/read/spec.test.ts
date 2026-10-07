import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { catalog } from '../../src/catalog.js';
// Independent contract audit: parse only endpoint parameter declarations from the
// pinned YAML, rather than borrowing handler route or query construction.
const yaml = readFileSync(new URL('../../docs/reference/ynab-openapi-1.87.0.yaml', import.meta.url), 'utf8');
const endpoints = new Map([...yaml.matchAll(/^  (\/[^\n]+):\n([\s\S]*?)(?=^  \/|^components:|$(?![\s\S]))/gm)].map(m => [m[1]!, m[2]!]));
for (const tool of catalog.filter(t => t.annotations.readOnlyHint)) it(`${tool.name}: pinned GET routes and query declaration audit`, () => {
  for (const route of tool.upstream) {
    expect(route.method).toBe('GET');
    const endpoint = endpoints.get(route.path); expect(endpoint).toBeDefined();
    const get = endpoint!.split(/^    (?:post|put|patch|delete):/m)[0]!;
    expect(get).toMatch(/^    get:/);
    const params = [...get.matchAll(/        - name: ([^\n]+)\n          in: query/g)].map(m => m[1]);
    const inputs = tool.inputSchema.properties as Record<string, unknown>;
    for (const key of ['include_accounts', 'last_knowledge_of_server', 'since_date', 'until_date', 'type']) {
      expect(params.includes(key), `${route.path}: ${key}`).toBe(key in inputs);
    }
  }
});
