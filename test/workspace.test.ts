import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { analyze, loadProject, UsageGraph, type ModuleCache } from '../src/index.ts';
import { workspaceApps, workspacePatterns } from '../src/workspace.ts';
import { app } from './helpers.ts';

const pkgJson = (name: string, extra: Record<string, unknown> = {}) => ({ name, private: true, type: 'module', ...extra });

/** A workspace where `e2e` lists `server` and `tools` in devDependencies, unless `e2e` says otherwise. */
const workspace = (server: Record<string, unknown>, e2e: Record<string, unknown> = { devDependencies: { server: '*', tools: '*' } }) =>
  app({
    'package.json': { name: 'root', private: true, workspaces: ['packages/*'] },
    'packages/e2e/package.json': pkgJson('e2e', e2e),
    'packages/e2e/src/index.ts': 'export const e2e = 1;\n',
    'packages/server/package.json': pkgJson('server', server),
    'packages/server/src/index.ts': 'export const server = 1;\n',
    'packages/tools/package.json': pkgJson('tools'),
    'packages/tools/src/index.ts': 'export const tools = 1;\n',
  });

describe('workspace apps', () => {
  test('a package another package lists only in devDependencies is an app when it has a start script', () => {
    const apps = workspaceApps(workspace({ scripts: { start: 'node src/index.ts' } })).map(a => a.path);
    assert.deepEqual(apps, ['packages/e2e', 'packages/server']);
  });

  test('without a start script it is a library', () => {
    const apps = workspaceApps(workspace({})).map(a => a.path);
    assert.deepEqual(apps, ['packages/e2e']);
  });

  test('a package in dependencies is a library even with a start script', () => {
    const dir = workspace({ scripts: { start: 'node src/index.ts' } }, { dependencies: { server: '*' } });
    const apps = workspaceApps(dir).map(a => a.path);
    assert.deepEqual(apps, ['packages/e2e', 'packages/tools']);
  });
});

describe('Nx projects', () => {
  const nx = (extra: Record<string, string | object> = {}) =>
    app({
      'package.json': { name: 'root', private: true },
      'nx.json': {},
      'apps/api/project.json': { name: 'api', projectType: 'application' },
      'apps/api/src/main.ts': "import { util } from '../../../libs/util/src/index';\nconsole.log(util);\n",
      'libs/util/project.json': { name: 'util', projectType: 'library' },
      'libs/util/src/index.ts': 'export const util = 1;\n',
      ...extra,
    });

  test('a project.json with projectType application is an app, a library is not', () => {
    assert.deepEqual(workspaceApps(nx()).map(a => a.path), ['apps/api']);
  });

  test('a library with a byakugan.json gets a verdict too', () => {
    assert.deepEqual(workspaceApps(nx({ 'libs/util/byakugan.json': { entry: ['src/index.ts'] } })).map(a => a.path), ['apps/api', 'libs/util']);
  });

  test('without nx.json and without workspaces there is nothing to list', () => {
    assert.throws(() => workspaceApps(app({ 'package.json': { name: 'root' }, 'apps/api/project.json': { projectType: 'application' } })), /no workspaces .* and no nx\.json/);
  });
});

describe('workspace patterns', () => {
  test('pnpm-workspace.yaml lists in block and flow style', () => {
    assert.deepEqual(workspacePatterns(app({ 'package.json': {}, 'pnpm-workspace.yaml': "packages: ['apps/*', \"packages/*\"]\n" })), ['apps/*', 'packages/*']);
    assert.deepEqual(workspacePatterns(app({ 'package.json': {}, 'pnpm-workspace.yaml': "packages:\n  - 'apps/*'\n  - packages/* # libs\n" })), ['apps/*', 'packages/*']);
  });
});


describe('a module cache shared by the apps of a workspace', () => {
  const files = {
    'package.json': { name: 'root', private: true, workspaces: ['apps/*', 'packages/*'] },
    'packages/ui/package.json': { name: 'ui' },
    'packages/ui/src/index.tsx': "import { type Size, size } from './size';\nexport const Box = (p: { s: Size }) => <div>{size(p.s)}</div>;\nexport const Unused = () => <i />;\n",
    'packages/ui/src/size.ts': "console.log('size loaded');\nexport type Size = 1 | 2;\nexport const size = (s: Size) => s * 2;\n",
    'packages/ui/src/broken.ts': 'export const = ;\n',
    // One app compiles JSX with the classic runtime and keeps `import { type X }`, the other does neither.
    'apps/a/package.json': { name: 'a' },
    'apps/a/byakugan.json': { entry: ['main.tsx'] },
    'apps/a/tsconfig.json': { compilerOptions: { jsx: 'react', verbatimModuleSyntax: true } },
    'apps/a/main.tsx': "import { Box } from '../../packages/ui/src/index';\nimport '../../packages/ui/src/broken';\nconsole.log(Box);\n",
    'apps/b/package.json': { name: 'b' },
    'apps/b/byakugan.json': { entry: ['main.tsx'] },
    'apps/b/tsconfig.json': { compilerOptions: { jsx: 'react-jsx' } },
    'apps/b/main.tsx': "import { Box } from '../../packages/ui/src/index';\nimport '../../packages/ui/src/broken';\nconsole.log(Box);\n",
  };

  test('gives every app the graph it gets alone, warnings included', () => {
    const dir = app(files, { repo: true });
    const cache: ModuleCache = new Map();
    for (const name of ['a', 'b', 'a']) {
      const alone = analyze({ cwd: join(dir, 'apps', name) });
      const shared = new UsageGraph(loadProject({ cwd: join(dir, 'apps', name) }), undefined, cache).build();
      assert.equal(shared.fingerprint(), alone.fingerprint(), name);
      assert.deepEqual([...shared.live.keys()].sort(), [...alone.live.keys()].sort(), name);
      assert.deepEqual(shared.warnings, alone.warnings, name);
      assert.ok(alone.warnings.some(w => w.includes('broken.ts: parse error')), alone.warnings.join('\n'));
    }
  });

  test('keeps apps with different compiler settings apart', () => {
    const dir = app(files, { repo: true });
    const cache: ModuleCache = new Map();
    const [a, b] = ['a', 'b'].map(name => new UsageGraph(loadProject({ cwd: join(dir, 'apps', name) }), undefined, cache).build());
    // Under `verbatimModuleSyntax`, `import { type Size, size }` is the same; the JSX runtime differs.
    assert.notDeepEqual([...a.live.keys()].sort(), [...b.live.keys()].sort());
  });

  test('parses a shared file once', () => {
    const dir = app({ ...files, 'apps/b/tsconfig.json': files['apps/a/tsconfig.json'] }, { repo: true });
    const cache: ModuleCache = new Map();
    new UsageGraph(loadProject({ cwd: join(dir, 'apps/a') }), undefined, cache).build();
    const size = cache.size;
    new UsageGraph(loadProject({ cwd: join(dir, 'apps/b') }), undefined, cache).build();
    // Only app b's own entry is new.
    assert.equal(cache.size, size + 1);
  });
});
