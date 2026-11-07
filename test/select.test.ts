import assert from 'node:assert/strict';
import { mkdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { affectedSinceCommit, affectedSinceManifest, createManifest } from '../src/affected.ts';
import { UsageGraph } from '../src/graph.ts';
import { loadProject } from '../src/project.ts';
import { eachProject, entriesReaching } from '../src/select.ts';
import { app, pkg, write } from './helpers.ts';

const lock = (version: string) =>
  JSON.stringify({ name: 'app', lockfileVersion: 3, packages: { '': { name: 'app' }, 'node_modules/left-pad': { version } } }, null, 2);

const files = {
  'package.json': { name: 'app', private: true, type: 'module', dependencies: { 'left-pad': '1.0.0' } },
  'package-lock.json': lock('1.0.0'),
  '.gitignore': 'node_modules/\n',
  'vitest.config.ts': "export default { test: { environment: 'node' } };\n",
  'src/math.ts': "export const add = (a: number, b: number) => a + b;\nexport const sub = (a: number, b: number) => a - b;\nexport const unused = () => 0;\n",
  'src/pad.ts': "import pad from 'left-pad';\nexport const padded = (s: string) => pad(s, 4);\n",
  'src/ui/index.ts': "export { Button } from './Button';\nexport { Card } from './Card';\n",
  'src/ui/Button.ts': "export const Button = () => 'button';\n",
  'src/ui/Card.ts': "export const Card = () => 'card';\n",
  'src/add.test.ts': "import { add } from './math';\nconsole.log(add(1, 2));\n",
  'src/sub.test.ts': "import { sub } from './math';\nimport { padded } from './pad';\nconsole.log(sub(1, 2), padded('a'));\n",
  'src/button.test.ts': "import { Button } from './ui';\nconsole.log(Button());\n",
  'src/card.test.ts': "import { Card } from './ui';\nconsole.log(Card());\n",
  ...pkg('left-pad', { main: 'index.js' }, { 'index.js': 'module.exports = (s, n) => s.padStart(n);\n' }),
};

/** Commits `files`, applies `edits` (null moves the file out), and returns the test files a change reaches. */
const select = (edits: Record<string, string | null>, base: Record<string, string | object> = files) => {
  const dir = app(base, { repo: true });
  for (const [path, content] of Object.entries(edits)) {
    if (content !== null) write(dir, path, content);
    else {
      mkdirSync(join(dir, '..', 'trash'), { recursive: true });
      renameSync(join(dir, path), join(dir, '..', 'trash', path.replaceAll('/', '_')));
    }
  }
  const patterns = ['src/**/*.test.ts'];
  const selection = eachProject(loadProject({ cwd: dir }), patterns);
  const graph = new UsageGraph(selection.project).build();
  const result = affectedSinceCommit(graph, 'main');
  return entriesReaching(graph, result.reasons, selection.each, patterns);
};

describe('affected --each', () => {
  test('a change to add reaches the test that imports add, not the one that imports sub', () => {
    assert.deepEqual(select({ 'src/math.ts': files['src/math.ts'].replace('a + b', 'a + b + 0') }), { all: false, files: ['src/add.test.ts'] });
  });

  test('a change to an export no test uses reaches none', () => {
    assert.deepEqual(select({ 'src/math.ts': files['src/math.ts'].replace('=> 0', '=> 1') }), { all: false, files: [] });
  });

  test('a barrel splits by export: Card reaches only the Card test', () => {
    assert.deepEqual(select({ 'src/ui/Card.ts': "export const Card = () => 'card!';\n" }), { all: false, files: ['src/card.test.ts'] });
  });

  test('a package bump reaches the tests that use the package', () => {
    assert.deepEqual(select({ 'package-lock.json': lock('1.0.1') }), { all: false, files: ['src/sub.test.ts'] });
  });

  test('a test runner config reaches every test', () => {
    const result = select({ 'vitest.config.ts': "export default { test: { environment: 'jsdom' } };\n" });
    assert.equal(result.all, true);
    assert.equal(result.files.length, 4);
  });

  test('package.json reaches every test', () => {
    const result = select({ 'package.json': JSON.stringify({ ...files['package.json'], type: 'commonjs' }) });
    assert.equal(result.all, true);
  });

  test('a new test file reaches itself, a deleted one nothing', () => {
    assert.deepEqual(select({ 'src/new.test.ts': "import { add } from './math';\nconsole.log(add);\n" }), { all: false, files: ['src/new.test.ts'] });
    assert.deepEqual(select({ 'src/card.test.ts': null }), { all: false, files: [] });
  });

  test('editing a test reaches only that test', () => {
    assert.deepEqual(select({ 'src/add.test.ts': "import { add } from './math';\nconsole.log(add(2, 2));\n" }), { all: false, files: ['src/add.test.ts'] });
  });

  test('a test that imports another test is reached through it', () => {
    const base = {
      ...files,
      'src/shared.test.ts': "import { add } from './math';\nexport const check = () => add(1, 1);\nconsole.log(check());\n",
      'src/uses.test.ts': "import { check } from './shared.test';\nconsole.log(check());\n",
    };
    const edit = { 'src/math.ts': files['src/math.ts'].replace('a + b', 'a + b + 0') };
    assert.deepEqual(select(edit, base), { all: false, files: ['src/add.test.ts', 'src/shared.test.ts', 'src/uses.test.ts'] });
    assert.deepEqual(select({ 'src/math.ts': files['src/math.ts'].replace('a - b', 'a - b - 0') }, base), { all: false, files: ['src/sub.test.ts'] });
  });

  test('a file two tests import with ?raw reaches both', () => {
    const base = {
      ...files,
      'src/snippet.ts': 'export const snippet = 1;\n',
      'src/one.test.ts': "import text from './snippet.ts?raw';\nconsole.log(text);\n",
      'src/two.test.ts': "import text from './snippet.ts?raw';\nconsole.log(text.length);\n",
    };
    assert.deepEqual(select({ 'src/snippet.ts': 'export const snippet = 1; // edited\n' }, base), { all: false, files: ['src/one.test.ts', 'src/two.test.ts'] });
  });

  test('an env value two tests read reaches both, not a third', () => {
    const base = {
      ...files,
      'byakugan.json': { env: ['API_*'] },
      'src/url.ts': 'export const url = process.env.API_URL;\n',
      'src/one.test.ts': "import { url } from './url';\nconsole.log(url);\n",
      'src/two.test.ts': "import { url } from './url';\nconsole.log(url, 2);\n",
    };
    const dir = app(base);
    const patterns = ['src/**/*.test.ts'];
    const build = (value: string) => {
      const saved = process.env.API_URL;
      process.env.API_URL = value;
      try {
        const selection = eachProject(loadProject({ cwd: dir }), patterns);
        return { selection, graph: new UsageGraph(selection.project).build() };
      } finally {
        if (saved === undefined) delete process.env.API_URL;
        else process.env.API_URL = saved;
      }
    };
    const manifest = createManifest(build('a').graph);
    const { selection, graph } = build('b');
    const result = affectedSinceManifest(graph, manifest);
    assert.deepEqual(entriesReaching(graph, result.reasons, selection.each, patterns), { all: false, files: ['src/one.test.ts', 'src/two.test.ts'] });
  });
});
