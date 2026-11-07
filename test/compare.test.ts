import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { compareBuilds } from '../src/compare.ts';
import { app } from './helpers.ts';

/** A `.next`-like build directory. `id` is the build ID, `root` the checkout path Next.js records. */
const build = (id: string, root: string, page: string, extra: Record<string, string> = {}) =>
  app({
    BUILD_ID: `${id}\n`,
    'required-server-files.json': { config: { outputFileTracingRoot: root } },
    [`static/${id}/_buildManifest.js`]: `self.__BUILD_MANIFEST = { id: "${id}" };\n`,
    'server/app/page.js': `${page}\n// built in ${root}/apps/web\n`,
    'server/server-reference-manifest.json': `{"encryptionKey":"${id}-secret"}`,
    'cache/webpack/x.pack': id,
    'trace': `${Math.random()}`,
    ...extra,
  });

describe('compare', () => {
  test('two builds of the same code match once the build ID, secrets, checkout path and caches are gone', () => {
    const a = build('aaaaaaaa1', '/home/ci/one', 'render(1)');
    const b = build('bbbbbbbb2', '/runner/two', 'render(1)');
    assert.deepEqual(compareBuilds(a, b), []);
  });

  test('a change in the code is a difference', () => {
    const a = build('aaaaaaaa1', '/home/ci/one', 'render(1)');
    const b = build('bbbbbbbb2', '/runner/two', 'render(2)');
    assert.deepEqual(compareBuilds(a, b).map(d => d.path), ['server/app/page.js']);
  });

  test('a file only one build has is a difference', () => {
    const a = build('aaaaaaaa1', '/home/ci/one', 'render(1)');
    const b = build('bbbbbbbb2', '/runner/two', 'render(1)', { 'server/app/extra.js': 'x' });
    assert.deepEqual(compareBuilds(a, b), [{ path: 'server/app/extra.js', detail: 'only in the fresh build' }]);
  });

  test('source maps count only with maps', () => {
    const a = build('aaaaaaaa1', '/home/ci/one', 'render(1)', { 'server/app/page.js.map': '{"sourcesContent":["a"]}' });
    const b = build('bbbbbbbb2', '/runner/two', 'render(1)', { 'server/app/page.js.map': '{"sourcesContent":["a "]}' });
    assert.deepEqual(compareBuilds(a, b), []);
    assert.deepEqual(compareBuilds(a, b, { maps: true }).map(d => d.path), ['server/app/page.js.map']);
  });
});

describe('compare outside Next.js', () => {
  test('a cache or trace folder in other build output counts', () => {
    const a = app({ 'index.html': '<p>1</p>', 'cache/data.js': 'one', trace: 'a' });
    const b = app({ 'index.html': '<p>1</p>', 'cache/data.js': 'two', trace: 'b' });
    assert.deepEqual(compareBuilds(a, b).map(d => d.path), ['cache/data.js', 'trace']);
  });
});
