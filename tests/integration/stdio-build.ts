import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

export const root = fileURLToPath(new URL('../../', import.meta.url));
/** Build real executable JS; temporarily tolerate only the three manager-deferred tool imports. */
export function buildStdioFixture() {
  mkdirSync(join(root, '.cache'), { recursive: true });
  const directory = mkdtempSync(join(root, '.cache/stdio-'));
  try {
    execFileSync(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), '-p', join(root, 'tsconfig.build.json'), '--outDir', join(directory, 'src')], { cwd: root, stdio: 'pipe' });
  } catch (error) {
    const output = String((error as { stdout?: Buffer }).stdout ?? '');
    const lines = output.trim().split('\n');
    if (!lines.length || !lines.every(line => /src\/runtime\/server\.ts\(\d+,\d+\): error TS2307: Cannot find module '\.\.\/tools\/(read|transactions|maintenance)\.js'/.test(line))) {
      rmSync(directory, { recursive: true, force: true }); throw error;
    }
  }
  mkdirSync(join(directory, 'docs')); copyFileSync(join(root, 'docs/tool-catalog.json'), join(directory, 'docs/tool-catalog.json'));
  mkdirSync(join(directory, 'tests/integration'), { recursive: true });
  for (const name of ['protocol-fixture', 'stdio-fixture']) {
    const source = readFileSync(join(root, `tests/integration/${name}.ts`), 'utf8');
    const emitted = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.ESNext } });
    writeFileSync(join(directory, `tests/integration/${name}.js`), emitted.outputText);
  }
  return { entry: join(directory, 'src/index.js'), fixture: join(directory, 'tests/integration/stdio-fixture.js'),
    cleanup: () => rmSync(directory, { recursive: true, force: true }) };
}
