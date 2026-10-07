// Dependency-free consistency checks for the proposal artifacts, not a server test suite.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const read = (file) => readFileSync(new URL(file, root), 'utf8');
const catalog = JSON.parse(read('docs/tool-catalog.json'));
const proposal = read('docs/proposal.md');
const upstream = read('docs/reference/ynab-openapi-1.87.0.yaml');
const digest = createHash('sha256').update(upstream).digest('hex');
assert.equal(digest, '69411d596ee4b6f79720615038ac9cdfea43875013ca9d0e5d235ba505ebf26f');
assert.equal(catalog.upstream.version, '1.87.0');
assert.equal(catalog.upstream.base_url, 'https://api.ynab.com/v1');

// The pinned YAML uses these exact indent levels for paths and HTTP operations.
const operations = new Set();
let endpoint;
for (const line of upstream.split('\n')) {
  const pathMatch = line.match(/^  (\/[^:]+):$/);
  if (pathMatch) endpoint = pathMatch[1];
  const methodMatch = line.match(/^    (get|post|put|patch|delete):$/);
  if (methodMatch && endpoint) operations.add(`${methodMatch[1].toUpperCase()} ${endpoint}`);
}

function checkSchema(schema, label) {
  assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema', label);
  assert.equal(schema.type, 'object', label);
  function walk(value) {
    if (!value || typeof value !== 'object') return;
    if (value.$ref) {
      assert.match(value.$ref, /^#\/\$defs\//, `${label}: nonlocal reference`);
      assert.ok(schema.$defs?.[value.$ref.slice('#/$defs/'.length)], `${label}: missing reference ${value.$ref}`);
    }
    if (value.required && value.properties) {
      for (const name of value.required) assert.ok(Object.hasOwn(value.properties, name), `${label}: required field ${name}`);
    }
    for (const child of Object.values(value)) walk(child);
  }
  walk(schema);
}

const names = new Set();
for (const tool of catalog.tools) {
  assert.ok(!names.has(tool.name), `Duplicate ${tool.name}`);
  names.add(tool.name);
  assert.match(tool.name, /^ynab_[a-z_]+$/);
  assert.ok(proposal.includes(`\`${tool.name}\``), `Missing tool documentation: ${tool.name}`);
  assert.ok(['core', 'extended'].includes(tool.profile));
  assert.equal(tool.inputSchema.additionalProperties, false);
  assert.equal(tool.annotations.readOnlyHint, !tool.permissions.write);
  assert.equal(tool.annotations.openWorldHint, true);
  assert.ok(!Object.hasOwn(tool.inputSchema.properties, 'budget_id'));
  checkSchema(tool.inputSchema, `${tool.name}.inputSchema`);
  checkSchema(tool.outputSchema, `${tool.name}.outputSchema`);
  for (const operation of tool.upstream) {
    assert.ok(operations.has(`${operation.method} ${operation.path}`), `Undocumented endpoint: ${JSON.stringify(operation)}`);
  }
  if (tool.permissions.write) assert.equal(tool.inputSchema.properties.dry_run.default, true);
  if (tool.permissions.delete) {
    assert.equal(tool.permissions.write, true);
    assert.equal(tool.inputSchema.properties.confirm_delete.default, false);
  }
}
assert.equal(names.size, 35);
assert.equal(catalog.tools.filter((tool) => tool.profile === 'core').length, 25);
assert.equal(catalog.tools.filter((tool) => tool.profile === 'extended').length, 10);
for (const file of ['docs/proposal.md', '.env.example']) {
  assert.ok(!/YNAB_(?:ALLOWED_)?BUDGET/.test(read(file)), `Old configuration terminology in ${file}`);
}
console.log(`Checked ${names.size} tools, 70 schema reference trees, endpoint mappings, terminology, and upstream SHA-256.`);
