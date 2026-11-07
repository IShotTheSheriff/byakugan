import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
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

describe('workspace patterns', () => {
  test('pnpm-workspace.yaml lists in block and flow style', () => {
    assert.deepEqual(workspacePatterns(app({ 'package.json': {}, 'pnpm-workspace.yaml': "packages: ['apps/*', \"packages/*\"]\n" })), ['apps/*', 'packages/*']);
    assert.deepEqual(workspacePatterns(app({ 'package.json': {}, 'pnpm-workspace.yaml': "packages:\n  - 'apps/*'\n  - packages/* # libs\n" })), ['apps/*', 'packages/*']);
  });
});

