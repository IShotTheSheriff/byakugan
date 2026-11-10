import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { analyze } from '../src/index.ts';
import { app, edit, fixture, initRepo, write } from './helpers.ts';

const CLI = join(import.meta.dirname, '../src/cli.ts');

const run = (args: string[], env: Record<string, string> = {}) => {
  const result = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env: { ...process.env, ...env, GITHUB_OUTPUT: env.GITHUB_OUTPUT ?? '' } });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
};

describe('cli', () => {
  test('graph prints used exports and package imports', () => {
    const dir = fixture('basic');
    const { code, stdout } = run(['-C', dir]);
    assert.equal(code, 0);
    assert.match(stdout, /src\/utils\.ts\s+cn, formatDate {2}\(2 of 3 exports\)/);
    assert.match(stdout, /lodash@4\.17\.21\s+3 files\s+partition/);
    assert.match(stdout, /src\/components\/Modal\.tsx\s+runs, nothing used/);
  });

  test('graph --json and --mermaid', () => {
    const dir = fixture('basic');
    const summary = JSON.parse(run(['graph', '--json', '-C', dir]).stdout);
    assert.equal(summary.fingerprint, analyze({ cwd: dir }).fingerprint());
    assert.deepEqual(summary.packages.find((p: { name: string }) => p.name === 'lodash').files, [
      '_arrayAggregator.js',
      '_createAggregator.js',
      'partition.js',
    ]);
    assert.match(run(['graph', '--mermaid', '-C', dir]).stdout, /-->\|"partition"\| n\d+/);
  });

  test('hash prints the fingerprint, writes a manifest and GitHub output', () => {
    const dir = fixture('basic');
    const output = join(dir, 'github-output');
    write(dir, 'github-output', '');
    const { stdout } = run(['hash', '-C', dir, '--manifest', join(dir, '.byakugan/manifest.json')], { GITHUB_OUTPUT: output });
    const fingerprint = stdout.trim();
    assert.match(fingerprint, /^[0-9a-f]{64}$/);
    assert.equal(JSON.parse(readFileSync(join(dir, '.byakugan/manifest.json'), 'utf8')).fingerprint, fingerprint);
    assert.equal(readFileSync(output, 'utf8'), `fingerprint=${fingerprint}\n`);
  });

  test('affected --exit-code: 0 when unaffected, 1 when affected', () => {
    const dir = fixture('basic');
    initRepo(dir);
    edit(dir, 'src/utils.ts', s => s.replace('toFixed(2)', 'toFixed(3)'));
    assert.equal(run(['affected', '-C', dir, '--base', 'main', '--exit-code']).code, 0);
    edit(dir, 'src/utils.ts', s => s.replace("padStart(2, '0')", "padStart(3, '0')"));
    const output = join(dir, 'github-output');
    write(dir, 'github-output', '');
    const { code, stdout } = run(['affected', '-C', dir, '--base', 'main', '--exit-code'], { GITHUB_OUTPUT: output });
    assert.equal(code, 1);
    assert.match(stdout, /^affected since [0-9a-f]{12}: 1 change reaches the app/);
    assert.match(stdout, /source: src\/utils\.ts#pad changed/);
    assert.match(readFileSync(output, 'utf8'), /^affected=true\nfingerprint=[0-9a-f]{64}\n$/);
  });

  test('affected --base-manifest', () => {
    const dir = fixture('basic');
    const manifest = join(dir, 'base.json');
    run(['hash', '-C', dir, '--manifest', manifest]);
    edit(dir, 'node_modules/lodash/filter.js', s => `${s}// patched\n`);
    const result = JSON.parse(run(['affected', '-C', dir, '--base-manifest', manifest, '--json']).stdout);
    assert.equal(result.affected, false);
  });

  test('why explains a used symbol and says when something is unused', () => {
    const dir = fixture('basic');
    const used = run(['why', 'src/utils.ts#pad', '-C', dir]).stdout;
    assert.match(used, /src\/main\.tsx \(entry\)/);
    assert.match(used, /src\/main\.tsx#formatDate \(import from "\.\/utils"\)/);
    assert.match(run(['why', 'npm:lodash/filter.js', '-C', dir]).stdout, /not used by the app/);
    assert.match(run(['why', 'src/components/Modal.tsx', '-C', dir]).stdout, /none of its code is used/);
  });

  test('usage errors exit with 2', () => {
    const dir = fixture('basic');
    assert.equal(run(['affected', '-C', dir]).code, 2);
    assert.equal(run(['nope', '-C', dir]).code, 2);
    assert.equal(run(['why', '-C', dir]).code, 2);
    write(dir, 'byakugan.json', '{ "entry": ["missing/*.ts"] }');
    const { code, stderr } = run(['-C', dir]);
    assert.equal(code, 2);
    assert.match(stderr, /No entry files found/);
  });

  test('warns when a workspace package resolves to build output', () => {
    const dir = fixture('basic');
    write(dir, 'packages/lib/package.json', '{ "name": "lib", "exports": { ".": "./dist/index.js" } }');
    write(dir, 'packages/lib/dist/index.js', 'export const x = 1;\n');
    symlinkSync('../packages/lib', join(dir, 'node_modules/lib'));
    edit(dir, 'src/main.tsx', s => `import { x } from 'lib';\nconsole.log(x);\n${s}`);
    assert.match(run(['-C', dir]).stdout, /lib resolves to build output \(packages\/lib\/dist\/index\.js\)/);
  });
});

describe('cli --workspace', () => {
  /** The monorepo fixture plus a second app, apps/docs, that uses nothing from @acme/ui. */
  const workspace = () => {
    const dir = fixture('monorepo');
    mkdirSync(join(dir, 'node_modules/@acme'), { recursive: true });
    symlinkSync('../../packages/ui', join(dir, 'node_modules/@acme/ui'));
    write(dir, '.gitignore', 'node_modules/\n');
    write(dir, 'apps/docs/package.json', JSON.stringify({ name: 'docs', private: true, type: 'module' }));
    write(dir, 'apps/docs/src/index.ts', "export const title = 'docs';\n");
    initRepo(dir);
    return dir;
  };

  test('affected lists only the apps a change reaches, and skips the library they use', () => {
    const dir = workspace();
    edit(dir, 'packages/ui/src/cx.ts', s => `${s}\nexport const extra = 1;\n`);
    edit(dir, 'apps/web/components/Hero.tsx', s => s.replace('</', ' !</'));
    const output = join(dir, 'github-output');
    const summary = join(dir, 'step-summary.md');
    const { code, stdout } = run(['affected', '--workspace', '--base', 'main', '--json', '-C', dir], { GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: summary });
    assert.equal(code, 0);
    const result = JSON.parse(stdout);
    assert.deepEqual(result.apps.map((a: { app: string }) => a.app), ['apps/docs', 'apps/web']);
    assert.deepEqual(result.affected, ['apps/web']);
    assert.match(readFileSync(output, 'utf8'), /^apps=\["apps\/web"\]$/m);
    assert.match(readFileSync(summary, 'utf8'), /\| apps\/docs \| unaffected \|/);
  });

  test('with no change, no app is affected and --exit-code exits 0', () => {
    const dir = workspace();
    const { code, stdout } = run(['affected', '--workspace', '--base', 'main', '--exit-code', '-C', dir]);
    assert.equal(code, 0);
    assert.match(stdout, /apps\/docs\s+unaffected/);
    assert.match(stdout, /apps\/web\s+unaffected/);
  });

  test('hash writes one manifest per app that affected --base-manifest reads back', () => {
    const dir = workspace();
    const manifests = join(dir, 'manifests');
    assert.equal(run(['hash', '--workspace', '--manifest', manifests, '-C', dir]).code, 0);
    assert.ok(readFileSync(join(manifests, 'apps__web.json'), 'utf8').includes('"fragments"'));
    edit(dir, 'apps/docs/src/index.ts', s => s.replace('docs', 'handbook'));
    const { code, stdout } = run(['affected', '--workspace', '--base-manifest', manifests, '--exit-code', '-C', dir]);
    assert.equal(code, 1);
    assert.match(stdout, /apps\/docs\s+affected/);
    assert.match(stdout, /apps\/web\s+unaffected/);
  });

  test('an app whose graph fails counts as affected', () => {
    const dir = workspace();
    write(dir, 'apps/docs/byakugan.json', '{ "entry": "src/index.ts" }');
    const { stdout } = run(['affected', '--workspace', '--base', 'main', '-C', dir]);
    assert.match(stdout, /apps\/docs\s+affected\s+error: /);
  });
});

describe('cli --json', () => {
  test('affected and why print chains as keys, without absolute paths or NUL bytes', () => {
    const dir = fixture('basic');
    initRepo(dir);
    edit(dir, 'src/utils.ts', s => s.replace('export const cn', 'export const cn2 = 1;\nexport const cn'));
    const affectedJson = run(['affected', '--base', 'main', '--json', '-C', dir]).stdout;
    const whyJson = run(['why', 'lodash', '--json', '-C', dir]).stdout;
    for (const out of [affectedJson, whyJson]) {
      assert.ok(!out.includes(dir), 'no absolute path');
      assert.ok(!out.includes('\\u0000'), 'no NUL');
    }
    assert.ok(JSON.parse(whyJson).matches[0].chain[0].endsWith('(entry)'));
  });
});

describe('cli --strict', () => {
  const widget = (text: string) => `'use client';\nexport const Used = () => <b>used</b>;\nexport const Unused = () => <i>${text}</i>;\n`;
  const project = () =>
    app({
      'package.json': { name: 'shop', dependencies: { next: '16.0.0', react: '19.0.0' } },
      'node_modules/next/package.json': { name: 'next', version: '16.0.0' },
      'node_modules/react/package.json': { name: 'react', version: '19.0.0' },
      'node_modules/react/jsx-runtime.js': 'exports.jsx = function () {};\n',
      'app/page.tsx': "import { Used } from '../ui/widget';\nexport default function Page() { return <Used />; }\n",
      'ui/widget.tsx': widget('one'),
    });
  const hash = (dir: string, ...flags: string[]) => run(['hash', '-C', dir, ...flags]).stdout.trim();

  test('counts an unused export of a client module a server component imports', () => {
    const dir = project();
    const before = hash(dir, '--strict');
    write(dir, 'ui/widget.tsx', widget('two'));
    assert.notEqual(hash(dir, '--strict'), before);
  });

  test('without it, the same edit keeps the fingerprint', () => {
    const dir = project();
    const before = hash(dir);
    write(dir, 'ui/widget.tsx', widget('two'));
    assert.equal(hash(dir), before);
  });
});

describe('cli --each with a manifest', () => {
  const project = () =>
    app({
      'package.json': { name: 'app', private: true, type: 'module' },
      'byakugan.json': { entry: ['src/math.ts'] },
      'src/math.ts': 'export const add = (a: number, b: number) => a + b;\nexport const sub = (a: number, b: number) => a - b;\n',
      'src/add.test.ts': "import { add } from './math';\nconsole.log(add(1, 2));\n",
      'src/sub.test.ts': "import { sub } from './math';\nconsole.log(sub(1, 2));\n",
    });
  const each = ['--each', 'src/**/*.test.ts'];

  test('hash --each saves a fingerprint per file, and affected --each compares with it', () => {
    const dir = project();
    const file = join(dir, 'out/tests.json');
    assert.equal(run(['hash', '-C', dir, ...each, '--manifest', file]).code, 0);
    assert.deepEqual(Object.keys(JSON.parse(readFileSync(file, 'utf8')).each), ['src/add.test.ts', 'src/sub.test.ts']);
    assert.equal(run(['affected', '-C', dir, ...each, '--base-manifest', file]).stdout, '');
    write(dir, 'src/sub.test.ts', 'console.log(1);\n');
    const { code, stdout } = run(['affected', '-C', dir, ...each, '--base-manifest', file, '--exit-code']);
    assert.equal(stdout, 'src/sub.test.ts\n');
    assert.equal(code, 1);
  });

  test('a manifest written without --each is refused', () => {
    const dir = project();
    const file = join(dir, 'out/app.json');
    assert.equal(run(['hash', '-C', dir, '--manifest', file]).code, 0);
    const { code, stderr } = run(['affected', '-C', dir, ...each, '--base-manifest', file]);
    assert.equal(code, 2);
    assert.match(stderr, /has no per-file fingerprints/);
  });
});
