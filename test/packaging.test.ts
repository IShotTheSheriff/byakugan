import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, cpSync, mkdtempSync, readFileSync, realpathSync, renameSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { affected, affectedSinceCommit, analyze, createManifest, formatWhy, why } from '../src/index.ts';
import { showFiles } from '../src/git.ts';
import { app, edit, git, initRepo, pkg, write } from './helpers.ts';

const CLI = join(import.meta.dirname, '../src/cli.ts');

const run = (args: string[], options: { cwd?: string; env?: Record<string, string> } = {}) => {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd: options.cwd,
    encoding: 'utf8',
    env: { ...process.env, GITHUB_OUTPUT: '', ...options.env },
  });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
};

const fingerprint = (cwd: string) => analyze({ cwd }).fingerprint();

const tempDir = (name: string) => realpathSync(mkdtempSync(join(tmpdir(), `byakugan-${name}-`)));

/** `src/m0.ts` imports `f1` from `src/m1.ts`, and so on down to the last module. */
const importChain = (n: number): Record<string, string> => {
  const files: Record<string, string> = { 'package.json': '{ "name": "chain" }\n', 'byakugan.json': '{ "entry": ["src/m0.ts"] }\n' };
  for (let i = 0; i < n; i++) {
    files[`src/m${i}.ts`] =
      i === n - 1
        ? `export const f${i} = () => 1;\nexport const spare = 'spare';\n`
        : `import { f${i + 1} } from './m${i + 1}';\nexport const f${i} = () => f${i + 1}() + 1;\n`;
  }
  return files;
};

describe('deeply nested code', () => {
  const depth = 5000;
  const nested = (value: string) => `export const big = ${'['.repeat(depth)}'${value}'${']'.repeat(depth)};\nexport const spare = 'spare';\n`;
  const deep = () =>
    app(
      {
        'package.json': { name: 'deep' },
        'src/index.ts': "import { big } from './big';\nconsole.log(big);\n",
        'src/big.ts': nested('one'),
      },
      { repo: true }
    );

  test('an edit 5,000 levels deep in a used export counts', () => {
    const dir = deep();
    const graph = analyze({ cwd: dir });
    assert.deepEqual(graph.warnings, []);
    assert.ok(graph.live.has('src/big.ts#big'));
    const before = graph.fingerprint();
    write(dir, 'src/big.ts', nested('two'));
    assert.notEqual(fingerprint(dir), before);
    assert.equal(affected({ cwd: dir, base: 'main' }).affected, true);
  });

  test('an unused export next to the deep one stays out', () => {
    const dir = deep();
    assert.ok(!analyze({ cwd: dir }).live.has('src/big.ts#spare'));
    const before = fingerprint(dir);
    edit(dir, 'src/big.ts', s => s.replace("spare = 'spare'", "spare = 'other'"));
    assert.equal(fingerprint(dir), before);
    assert.equal(affected({ cwd: dir, base: 'main' }).affected, false);
  });

  test('deep JSX is read declaration by declaration', () => {
    const jsx = (value: string) => `export const Big = () => ${'<div>'.repeat(depth)}${value}${'</div>'.repeat(depth)};\nexport const Spare = () => 'spare';\n`;
    const dir = app({
      'package.json': { name: 'deep' },
      'src/index.tsx': "import { Big } from './big';\nconsole.log(Big);\n",
      'src/big.tsx': jsx('one'),
    });
    const before = fingerprint(dir);
    edit(dir, 'src/big.tsx', s => s.replace("'spare'", "'other'"));
    assert.equal(fingerprint(dir), before);
    write(dir, 'src/big.tsx', jsx('two'));
    assert.notEqual(fingerprint(dir), before);
  });

  test('code the analyzer gives up on is hashed whole, not as an empty file', () => {
    // 20,000 terms in an import() specifier: whatever the analyzer does with it, edits must count.
    const terms = Array(20_000).fill('a').join(' + ');
    const dir = app({
      'package.json': { name: 'deep' },
      'src/index.ts': "import { load } from './big';\nconsole.log(load);\n",
      'src/big.ts': `export const load = (a: string) => import('./x/' + ${terms});\nexport const word = 'one';\n`,
      'src/unused.ts': "export const word = 'one';\n",
    });
    const before = fingerprint(dir);
    edit(dir, 'src/unused.ts', s => s.replace("'one'", "'two'"));
    assert.equal(fingerprint(dir), before);
    edit(dir, 'src/big.ts', s => s.replace("import('./x/'", "import('./y/'"));
    assert.notEqual(fingerprint(dir), before);
  });
});

describe('long chains', () => {
  test('a 3,000-deep export * chain reaches the leaf export', () => {
    const files: Record<string, string> = {
      'package.json': '{ "name": "stars" }\n',
      'src/index.ts': "import { leaf } from './m0';\nconsole.log(leaf);\n",
    };
    const n = 3000;
    for (let i = 0; i < n - 1; i++) files[`src/m${i}.ts`] = `export * from './m${i + 1}';\nexport const v${i} = ${i};\n`;
    files[`src/m${n - 1}.ts`] = "export const leaf = 'one';\n";
    const dir = app(files);
    const graph = analyze({ cwd: dir });
    assert.ok(graph.live.has(`src/m${n - 1}.ts#leaf`));
    assert.ok(!graph.live.has('src/m5.ts#v5'));
    const before = graph.fingerprint();
    edit(dir, 'src/m5.ts', s => s.replace('v5 = 5', 'v5 = 6'));
    assert.equal(fingerprint(dir), before);
    edit(dir, `src/m${n - 1}.ts`, s => s.replace("'one'", "'two'"));
    assert.notEqual(fingerprint(dir), before);
  });

  test('a 10,000-module import chain counts an edit at the far end', () => {
    const n = 10_000;
    const dir = app(importChain(n));
    const before = fingerprint(dir);
    edit(dir, `src/m${n - 1}.ts`, s => s.replace("spare = 'spare'", "spare = 'other'"));
    assert.equal(fingerprint(dir), before);
    edit(dir, `src/m${n - 1}.ts`, s => s.replace('() => 1', '() => 2'));
    assert.notEqual(fingerprint(dir), before);
  });

  test('why prints the whole chain from the entry, past 10,000 links', () => {
    const n = 6000;
    const dir = app(importChain(n));
    const graph = analyze({ cwd: dir });
    const result = why(graph, `src/m${n - 1}.ts#f${n - 1}`, dir);
    assert.equal(result.matches.length, 1);
    const chain = result.matches[0].chain;
    assert.ok(chain.length > 10_000);
    const lines = formatWhy(graph, result).split('\n');
    assert.equal(lines[1], '  src/m0.ts (entry)');
    assert.equal(lines.at(-1), `  └ src/m${n - 1}.ts#f${n - 1}`);
  });

  test('why says a module outside the chain is not used', () => {
    const files = importChain(50);
    files['src/other.ts'] = 'export const other = 1;\n';
    const dir = app(files);
    const graph = analyze({ cwd: dir });
    assert.match(formatWhy(graph, why(graph, 'src/other.ts', dir)), /not used by the app/);
  });

  // The iterative exportNames caches a partial name set for the inner module of an `export *` cycle.
  // The recursive version found `b` here.
  test('a name reached through an export * cycle counts', () => {
    const dir = app({
      'package.json': { name: 'cycle' },
      'src/index.ts': "import { b } from './d';\nimport { a } from './c';\nconsole.log(a, b);\n",
      'src/c.ts': "export * from './b';\n",
      'src/d.ts': "export * from './a';\n",
      'src/a.ts': "export const a = 1;\nexport * from './b';\n",
      'src/b.ts': "export const b = 2;\nexport * from './a';\n",
    });
    assert.ok(analyze({ cwd: dir }).live.has('src/b.ts#b'));
  });

  /** A 200-deep `export *` chain into a 10-module cycle. `x.ts` and `y.ts` enter the cycle at different members. */
  const chainIntoCycle = () => {
    const files: Record<string, string> = {
      'package.json': '{ "name": "cycle" }\n',
      'src/index.ts': "import { v0, v9 } from './chain0';\nimport { v4 } from './x';\nimport { v6 } from './y';\nconsole.log(v0, v9, v4, v6);\n",
      'src/x.ts': "export * from './c7';\n",
      'src/y.ts': "export * from './c2';\n",
    };
    for (let i = 0; i < 200; i++) files[`src/chain${i}.ts`] = `export * from './${i === 199 ? 'c0' : `chain${i + 1}`}';\n`;
    for (let i = 0; i < 10; i++) files[`src/c${i}.ts`] = `export const v${i} = 'v${i}';\nexport * from './c${(i + 1) % 10}';\n`;
    return app(files);
  };

  test('names from every member of an export * cycle count, however the cycle is entered', () => {
    const graph = analyze({ cwd: chainIntoCycle() });
    assert.deepEqual(graph.warnings, []);
    for (const i of [0, 9, 4, 6]) assert.ok(graph.live.has(`src/c${i}.ts#v${i}`), `v${i}`);
  });

  test('a name nobody imports from the cycle stays out', () => {
    const dir = chainIntoCycle();
    const graph = analyze({ cwd: dir });
    for (const i of [1, 2, 3, 5, 7, 8]) assert.ok(!graph.live.has(`src/c${i}.ts#v${i}`), `v${i}`);
    const before = graph.fingerprint();
    edit(dir, 'src/c3.ts', s => s.replace("'v3'", "'changed'"));
    assert.equal(fingerprint(dir), before);
    edit(dir, 'src/c6.ts', s => s.replace("'v6'", "'changed'"));
    assert.notEqual(fingerprint(dir), before);
  });

  // The app never imports these files, so the graph has not cached them before the calls below.
  const cycleFiles = (effect: boolean) => ({
    'package.json': { name: 'effects' },
    'src/index.ts': 'export const x = 1;\n',
    'src/a.ts': "import { b } from './b';\nexport const a = () => b;\n",
    'src/b.ts': "import { a } from './a';\nimport { c } from './c';\nexport const b = () => [a, c];\n",
    'src/c.ts': effect ? "console.log('runs');\nexport const c = 1;\n" : 'export const c = 1;\n',
  });

  test('every member of an import cycle runs code when one import out of it does', () => {
    const dir = app(cycleFiles(true));
    const graph = analyze({ cwd: dir });
    // b first: a sits inside the cycle b enters.
    assert.equal(graph.effectful(join(dir, 'src/b.ts')), true);
    assert.equal(graph.effectful(join(dir, 'src/a.ts')), true);
  });

  test('an import cycle with no code that runs has no effects', () => {
    const dir = app(cycleFiles(false));
    const graph = analyze({ cwd: dir });
    assert.equal(graph.effectful(join(dir, 'src/b.ts')), false);
    assert.equal(graph.effectful(join(dir, 'src/a.ts')), false);
  });
});

describe('git mode with many changed files', () => {
  /** `src/index.ts` uses `f<i>` from each module. Each module also has an unused `g<i>`. */
  const many = (n: number) => {
    const files: Record<string, string | object> = { 'package.json': { name: 'many' }, '.gitignore': 'node_modules/\n' };
    const names = Array.from({ length: n }, (_, i) => i);
    // Odd names exercise the cat-file batch parser: spaces, non-ASCII, a leading dash.
    const fileOf = (i: number) => (i === 1 ? 'src/with space.ts' : i === 2 ? 'src/zażółć.ts' : i === 3 ? 'src/-dash.ts' : `src/m${i}.ts`);
    files['src/index.ts'] = `${names.map(i => `import { f${i} } from './${fileOf(i).slice(4, -3)}';`).join('\n')}\nconsole.log(${names.map(i => `f${i}`).join(', ')});\n`;
    for (const i of names) files[fileOf(i)] = `export const f${i} = () => ${i};\nexport const g${i} = () => 'g${i}';\n`;
    files['src/logo.png'] = 'png-bytes';
    return { dir: app(files, { repo: true }), fileOf };
  };

  test('unused edits in 300 files are unaffected', () => {
    const { dir, fileOf } = many(300);
    for (let i = 0; i < 300; i++) edit(dir, fileOf(i), s => s.replace(`'g${i}'`, `'changed ${i}'`));
    const result = affected({ cwd: dir, base: 'main' });
    assert.deepEqual(result.reasons, []);
    assert.equal(result.ignored.length, 300);
  });

  test('one used edit among 300 changed files is found', () => {
    const { dir, fileOf } = many(300);
    for (let i = 0; i < 300; i++) edit(dir, fileOf(i), s => s.replace(`'g${i}'`, `'changed ${i}'`));
    edit(dir, fileOf(2), s => s.replace('() => 2;', '() => 22;'));
    edit(dir, fileOf(299), s => s.replace('() => 299;', '() => 0;'));
    const result = affected({ cwd: dir, base: 'main' });
    assert.deepEqual(result.reasons.map(r => r.key).sort(), ['src/m299.ts#f299', 'src/zażółć.ts#f2']);
  });

  test('base contents come from one git cat-file, not one git show per file', () => {
    const { dir, fileOf } = many(40);
    for (let i = 0; i < 40; i++) edit(dir, fileOf(i), s => s.replace(`'g${i}'`, `'changed ${i}'`));
    // A git on PATH that logs its arguments, then runs the real one.
    const bin = tempDir('fake-git');
    const log = join(bin, 'log');
    const real = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
    write(bin, 'git', `#!/bin/sh\necho "$*" >> "${log}"\nexec "${real}" "$@"\n`);
    chmodSync(join(bin, 'git'), 0o755);
    const { code, stdout } = run(['affected', '-C', dir, '--base', 'main'], { env: { PATH: `${bin}:${process.env.PATH}` } });
    assert.equal(code, 0);
    assert.match(stdout, /^unaffected/);
    const calls = readFileSync(log, 'utf8').trim().split('\n');
    assert.equal(calls.filter(c => / cat-file --batch$/.test(c)).length, 1);
    assert.deepEqual(calls.filter(c => / show /.test(c)), []);
  });

  test('removing half of every barrel line stays fast', () => {
    const files: Record<string, string | object> = { 'package.json': { name: 'barrels' }, 'src/index.ts': "export * from './barrels';\n" };
    const groups: string[][] = [];
    for (let b = 0; b < 60; b++) {
      const lines: string[] = [];
      for (let i = b * 50; i < (b + 1) * 50; i++) {
        files[`src/b${b}/m${i}.ts`] = `export const v${i} = ${i};\n`;
        lines.push(`export * from './m${i}';`);
      }
      files[`src/b${b}/index.ts`] = `${lines.join('\n')}\n`;
      groups.push(lines);
    }
    files['src/barrels.ts'] = `${groups.map((_, b) => `export * from './b${b}';`).join('\n')}\n`;
    const dir = app(files, { repo: true });
    groups.forEach((lines, b) => write(dir, `src/b${b}/index.ts`, `${lines.filter((_, i) => i % 2 === 0).join('\n')}\n`));
    let start = performance.now();
    const graph = analyze({ cwd: dir });
    const build = performance.now() - start;
    start = performance.now();
    const result = affectedSinceCommit(graph, 'main');
    const compare = performance.now() - start;
    assert.equal(result.reasons.length, 1500);
    // One scan of every graph node per removed line took over ten times the build here.
    assert.ok(compare < 4 * build + 200, `comparing took ${compare.toFixed(0)} ms, building ${build.toFixed(0)} ms`);
  });

  test('a removed export * line counts only in a barrel the app loads', () => {
    const dir = app(
      {
        'package.json': { name: 'barrels' },
        'src/index.ts': "import { a } from './used';\nconsole.log(a);\n",
        'src/used.ts': "export * from './a';\nexport * from './b';\n",
        'src/unused.ts': "export * from './a';\nexport * from './b';\n",
        'src/a.ts': 'export const a = 1;\n',
        'src/b.ts': 'export const b = 2;\n',
      },
      { repo: true }
    );
    edit(dir, 'src/unused.ts', s => s.replace("export * from './b';\n", ''));
    assert.equal(affected({ cwd: dir, base: 'main' }).affected, false);
    edit(dir, 'src/used.ts', s => s.replace("export * from './b';\n", ''));
    assert.deepEqual(
      affected({ cwd: dir, base: 'main' }).reasons.map(r => r.key),
      ['src/used.ts#export*:./b']
    );
  });
});

describe('warnings from the CLI', () => {
  const warned = () =>
    app(
      {
        'package.json': { name: 'warn' },
        'tsconfig.json': { compilerOptions: { paths: { '@/*': ['./src/*'] } } },
        'src/index.ts': 'export const load = (l: string) => import(`@/messages/${l}.json`);\n',
        'src/messages/de.json': '{ "hi": "hallo" }\n',
      },
      { repo: true }
    );
  const quiet = () => app({ 'package.json': { name: 'quiet' }, 'src/index.ts': 'console.log(1);\n' }, { repo: true });
  const warning = /cannot follow import\(`@\/messages\/\$\{…\}\.json`\)/;

  test('hash prints warnings to stderr and only the fingerprint to stdout', () => {
    const { code, stdout, stderr } = run(['hash', '-C', warned()]);
    assert.equal(code, 0);
    assert.match(stdout, /^[0-9a-f]{64}\n$/);
    assert.match(stderr, /^byakugan: warning: src\/index\.ts: /);
    assert.match(stderr, warning);
  });

  test('hash prints nothing to stderr when there is nothing to warn about', () => {
    const { code, stdout, stderr } = run(['hash', '-C', quiet()]);
    assert.equal(code, 0);
    assert.match(stdout, /^[0-9a-f]{64}\n$/);
    assert.equal(stderr, '');
    assert.deepEqual(JSON.parse(run(['hash', '--json', '-C', quiet()]).stdout).warnings, []);
  });

  test('hash --json carries the warnings and keeps stderr clean', () => {
    const { stdout, stderr } = run(['hash', '--json', '-C', warned()]);
    const json = JSON.parse(stdout);
    assert.match(json.fingerprint, /^[0-9a-f]{64}$/);
    assert.equal(json.warnings.length, 1);
    assert.match(json.warnings[0], warning);
    assert.equal(stderr, '');
  });

  test('why prints warnings to stderr, and --json carries them', () => {
    const dir = warned();
    const text = run(['why', 'src/index.ts', '-C', dir]);
    assert.match(text.stderr, warning);
    assert.doesNotMatch(text.stdout, warning);
    assert.match(JSON.parse(run(['why', 'src/index.ts', '--json', '-C', dir]).stdout).warnings[0], warning);
  });

  test('affected shows warnings even when unaffected, and --json carries them', () => {
    const dir = warned();
    write(dir, 'src/messages/de.json', '{ "hi": "Hallo" }\n');
    const text = run(['affected', '--base', 'main', '-C', dir]);
    assert.equal(text.code, 0);
    assert.match(text.stdout, /^unaffected/);
    assert.match(text.stdout + text.stderr, warning);
    const json = JSON.parse(run(['affected', '--base', 'main', '--json', '-C', dir]).stdout);
    assert.equal(json.affected, false);
    assert.match(json.warnings[0], warning);
  });

  test('affected prints no warnings section when there is nothing to warn about', () => {
    const dir = quiet();
    write(dir, 'README.md', '# quiet\n');
    const text = run(['affected', '--base', 'main', '-C', dir]);
    assert.doesNotMatch(text.stdout, /warning/);
    assert.equal(text.stderr, '');
  });
});

describe('type-only packages with several installed copies', () => {
  const zod = (version: string) => ({ version, types: 'index.d.ts' });
  const copies = () =>
    app({
      'package.json': { name: 'tv' },
      'src/index.ts': "import type { A } from 'zod';\nimport type { B } from '../lib/x';\nexport const f = (a: A, b: B) => [a, b];\n",
      'lib/package.json': { name: 'lib' },
      'lib/x.ts': "import type { Z } from 'zod';\nexport type B = Z;\n",
      'other/package.json': { name: 'other' },
      'other/y.ts': "import type { Z } from 'zod';\nexport type C = Z;\n",
      ...pkg('zod', zod('3.0.1'), { 'index.d.ts': 'export type A = string;\nexport type Z = number;\n' }),
      ...Object.fromEntries(
        Object.entries(pkg('zod', zod('4.1.0'), { 'index.d.ts': 'export type A = string;\nexport type Z = boolean;\n' })).map(([k, v]) => [`lib/${k}`, v])
      ),
      ...Object.fromEntries(
        Object.entries(pkg('zod', zod('5.0.0'), { 'index.d.ts': 'export type A = string;\nexport type Z = bigint;\n' })).map(([k, v]) => [`other/${k}`, v])
      ),
    });
  const bump = (dir: string, where: string, from: string, to: string) => edit(dir, `${where}node_modules/zod/package.json`, s => s.replace(from, to));

  test('bumping the second copy counts, in the fingerprint and in manifest mode', () => {
    const dir = copies();
    const base = createManifest(analyze({ cwd: dir }));
    bump(dir, 'lib/', '4.1.0', '4.2.0');
    assert.notEqual(fingerprint(dir), base.fingerprint);
    const result = affected({ cwd: dir, baseManifest: base });
    assert.deepEqual(result.reasons.map(r => r.key), ['npm:zod#<types>']);
  });

  test('bumping the first copy counts too', () => {
    const dir = copies();
    const before = fingerprint(dir);
    bump(dir, '', '3.0.1', '3.0.2');
    assert.notEqual(fingerprint(dir), before);
  });

  test('bumping a copy no used code imports does not count', () => {
    const dir = copies();
    const before = fingerprint(dir);
    bump(dir, 'other/', '5.0.0', '5.1.0');
    assert.equal(fingerprint(dir), before);
  });
});

describe('fingerprints across checkouts', () => {
  /** A repository with the app in `frontend/`, next to its own lockfile. */
  const checkout = () => {
    const repo = tempDir('checkout');
    write(repo, 'frontend/package.json', '{ "name": "fe" }\n');
    write(repo, 'frontend/package-lock.json', '{ "lockfileVersion": 3, "packages": { "": { "name": "fe" } } }\n');
    write(repo, 'frontend/src/index.ts', "import { util } from './util';\nconsole.log(util);\n");
    write(repo, 'frontend/src/util.ts', 'export const util = 1;\n');
    initRepo(repo);
    return repo;
  };

  test('the same with .git, without it, and in another directory', () => {
    const repo = checkout();
    const app = join(repo, 'frontend');
    const graph = analyze({ cwd: app });
    const keys = [...graph.live.keys()];
    assert.ok(keys.includes('src/util.ts#util'), keys.join(', '));
    // Out of the way, not deleted: a Docker context or a source tarball has no .git.
    renameSync(join(repo, '.git'), `${repo}-git`);
    assert.equal(fingerprint(app), graph.fingerprint());
    const elsewhere = join(tempDir('elsewhere'), 'a', 'b', 'web');
    cpSync(app, elsewhere, { recursive: true });
    assert.equal(fingerprint(elsewhere), graph.fingerprint());
    assert.deepEqual([...analyze({ cwd: elsewhere }).live.keys()].sort(), keys.sort());
  });

  test('an edit in the other checkout still changes it', () => {
    const repo = checkout();
    const before = fingerprint(join(repo, 'frontend'));
    const elsewhere = join(tempDir('elsewhere'), 'web');
    cpSync(join(repo, 'frontend'), elsewhere, { recursive: true });
    edit(elsewhere, 'src/util.ts', s => s.replace('= 1', '= 2'));
    assert.notEqual(fingerprint(elsewhere), before);
  });

  test('a monorepo keys files from the root lockfile, with or without .git', () => {
    const repo = tempDir('mono');
    write(repo, 'package.json', '{ "name": "mono", "workspaces": ["apps/*"] }\n');
    write(repo, 'package-lock.json', '{ "lockfileVersion": 3, "packages": {} }\n');
    write(repo, 'apps/web/package.json', '{ "name": "web" }\n');
    write(repo, 'apps/web/src/index.ts', 'console.log(1);\n');
    initRepo(repo);
    const web = join(repo, 'apps/web');
    const before = analyze({ cwd: web });
    assert.ok(before.live.has('apps/web/src/index.ts'), [...before.live.keys()].join(', '));
    renameSync(join(repo, '.git'), `${repo}-git`);
    assert.equal(fingerprint(web), before.fingerprint());
  });

  test('keys hold no absolute paths, store paths or versions', () => {
    const files = (layout: 'npm' | 'pnpm'): Record<string, string | object> => {
      const lodash = { 'package.json': { name: 'lodash', version: '4.17.21' }, 'partition.js': 'module.exports = 1;\n' };
      const base = layout === 'npm' ? 'node_modules/lodash' : 'node_modules/.pnpm/lodash@4.17.21/node_modules/lodash';
      const out: Record<string, string | object> = {
        'package.json': { name: 'layout', dependencies: { lodash: '4.17.21' } },
        'src/index.ts': "import partition from 'lodash/partition';\nconsole.log(partition);\n",
      };
      for (const [path, content] of Object.entries(lodash)) out[`${base}/${path}`] = content;
      return out;
    };
    const npm = app(files('npm'));
    const pnpm = app(files('pnpm'));
    symlinkSync('.pnpm/lodash@4.17.21/node_modules/lodash', join(pnpm, 'node_modules/lodash'));
    const graph = analyze({ cwd: pnpm });
    const keys = [...graph.live.keys()];
    assert.ok(keys.includes('npm:lodash/partition.js'), keys.join(', '));
    for (const key of keys) {
      assert.ok(!key.startsWith('/') && !key.includes(tmpdir()) && !key.includes(pnpm), key);
      assert.ok(!key.includes('.pnpm') && !key.includes('4.17.21'), key);
    }
    assert.equal(fingerprint(npm), graph.fingerprint());
  });
});

describe('generated files', () => {
  const next = () =>
    app({
      'package.json': { name: 'n', dependencies: { next: '15.0.0' } },
      'app/page.tsx': 'export default function Page() {\n  return null;\n}\n',
      ...pkg('next', { version: '15.0.0' }, {}),
    });

  test('next-env.d.ts is not an input', () => {
    const dir = next();
    const before = fingerprint(dir);
    write(dir, 'next-env.d.ts', '/// <reference types="next" />\n');
    write(dir, 'src/next-env.d.ts', '/// <reference types="next" />\n');
    assert.equal(fingerprint(dir), before);
  });

  test('other .d.ts files are inputs', () => {
    const dir = next();
    const before = fingerprint(dir);
    write(dir, 'global.d.ts', 'declare const answer: 42;\n');
    assert.notEqual(fingerprint(dir), before);
  });

  const reactRouter = () =>
    app({
      'package.json': { name: 'rr', devDependencies: { '@react-router/dev': '7.0.0' } },
      'app/root.tsx': 'export default function Root() {\n  return null;\n}\n',
      'app/routes/home.tsx': 'export default function Home() {\n  return null;\n}\n',
    });

  test('React Router typegen output is not an input', () => {
    const dir = reactRouter();
    const before = fingerprint(dir);
    write(dir, '.react-router/types/app/+types/root.d.ts', 'export type Info = {};\n');
    write(dir, '.react-router/types/+routes.d.ts', 'export type Pages = {};\n');
    assert.equal(fingerprint(dir), before);
  });

  test('a .d.ts file of the React Router app itself is an input', () => {
    const dir = reactRouter();
    const before = fingerprint(dir);
    write(dir, 'app/env.d.ts', 'declare const answer: 42;\n');
    assert.notEqual(fingerprint(dir), before);
  });
});

describe('git plumbing', () => {
  test('cat-file results stay aligned past a missing path with spaces and a submodule', () => {
    const dir = app({ 'a.ts': 'first\n', 'z.ts': 'last\n' });
    initRepo(dir);
    git(dir, 'update-index', '--add', '--cacheinfo', `160000,${'1'.repeat(40)},vendor lib`);
    git(dir, 'commit', '-q', '-m', 'submodule');
    const commit = git(dir, 'rev-parse', 'HEAD').trim();
    const out = showFiles(dir, commit, ['a.ts', 'no such file.ts', 'vendor lib', 'z.ts']);
    assert.equal(out.get('a.ts')?.toString(), 'first\n');
    assert.equal(out.get('no such file.ts'), undefined);
    assert.equal(out.get('vendor lib'), undefined);
    assert.equal(out.get('z.ts')?.toString(), 'last\n');
  });

  /** The app imports `vendor/lib` (a submodule) and `src/gen.ts`, which git ignores unless `track`. */
  const withSubmodule = (track: boolean) => {
    const lib = app({ 'index.ts': 'export const lib = 1;\n' }, { repo: true });
    const dir = app({
      'package.json': { name: 'sub' },
      '.gitignore': track ? 'node_modules/\n' : 'node_modules/\nsrc/gen.ts\n',
      'src/index.ts': "import { lib } from '../vendor/lib/index';\nimport { gen } from './gen';\nconsole.log(lib, gen);\n",
      'src/gen.ts': 'export const gen = 1;\n',
    });
    git(dir, 'init', '-q', '-b', 'main');
    git(dir, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', lib, 'vendor/lib');
    // Not initRepo: its `add -f` would track the ignored file.
    git(dir, 'add', '-A');
    git(dir, '-c', 'user.email=test@example.com', '-c', 'user.name=test', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'base');
    return dir;
  };

  test('a git-ignored file the app imports counts when the app also reads a submodule', () => {
    const dir = withSubmodule(false);
    write(dir, 'src/gen.ts', 'export const gen = 2;\n');
    const result = affected({ cwd: dir, base: 'main' });
    assert.equal(result.affected, true);
    assert.ok(result.reasons.some(r => r.key === 'src/gen.ts'), result.reasons.map(r => `${r.key}: ${r.detail}`).join('\n'));
  });

  test('with a submodule and nothing ignored, a README edit is unaffected', () => {
    const dir = withSubmodule(true);
    write(dir, 'README.md', '# sub\n');
    assert.deepEqual(affected({ cwd: dir, base: 'main' }).reasons, []);
  });
});

describe('modules the framework provides', () => {
  const next = (dependencies: Record<string, string>) =>
    app(
      {
        'package.json': { name: 'so', dependencies: { next: '15.0.0', ...dependencies } },
        '.gitignore': 'node_modules/\n',
        'app/page.tsx': "import { secret } from '../lib/secret';\nexport default function Page() {\n  return secret();\n}\n",
        'lib/secret.ts': "import 'server-only';\nexport const secret = () => 1;\n",
        ...pkg('next', { version: '15.0.0' }, { 'dist/compiled/server-only/index.js': 'throw new Error();\n' }),
      },
      { repo: true }
    );

  // Next.js aliases `server-only` and `client-only` to its own compiled copies, so apps need not install them.
  test('an uninstalled server-only import in a Next.js app does not make every change affected', () => {
    const dir = next({});
    write(dir, 'README.md', '# so\n');
    assert.deepEqual(affected({ cwd: dir, base: 'main' }).reasons, []);
  });

  test('an undeclared bare import that may be a bundler alias still counts outside Next.js', () => {
    const dir = app(
      {
        'package.json': { name: 'alias', devDependencies: { vite: '5.0.0' } },
        'index.html': '<script type="module" src="/src/main.ts"></script>\n',
        'src/main.ts': "import { x } from 'components/x';\nconsole.log(x);\n",
      },
      { repo: true }
    );
    write(dir, 'README.md', '# alias\n');
    assert.deepEqual(affected({ cwd: dir, base: 'main' }).reasons.map(r => r.kind), ['unresolved']);
  });
});

describe('where the CLI runs', () => {
  const project = () =>
    app({
      'package.json': { name: 'web' },
      'src/index.ts': "import { hero } from '../components/hero';\nconsole.log(hero);\n",
      'components/hero.ts': 'export const hero = 1;\n',
      'components/index.ts': "export * from './hero';\n",
    });

  test('a subdirectory with no package.json is an error, with -C or as cwd', () => {
    const dir = project();
    const flag = run(['hash', '-C', join(dir, 'components')]);
    assert.equal(flag.code, 2);
    assert.equal(flag.stdout, '');
    assert.match(flag.stderr, /components has no package\.json, framework config or byakugan\.json/);
    const cwd = run(['hash'], { cwd: join(dir, 'components') });
    assert.equal(cwd.code, 2);
    assert.match(cwd.stderr, /Run byakugan in the app directory, or pass -C <dir>/);
  });

  test('the app directory itself works, and a subdirectory with its own byakugan.json', () => {
    const dir = project();
    const root = run(['hash'], { cwd: dir });
    assert.equal(root.code, 0);
    assert.equal(root.stdout.trim(), fingerprint(dir));
    write(dir, 'components/byakugan.json', '{ "entry": ["index.ts"] }\n');
    assert.equal(run(['hash', '-C', join(dir, 'components')]).code, 0);
  });

  test('only config files as entries exits 2 with "No entry files found"', () => {
    const dir = app({
      'package.json': { name: 'v', devDependencies: { vite: '5.0.0' } },
      'vite.config.ts': 'export default {};\n',
      'postcss.config.js': 'module.exports = {};\n',
      'src/app.ts': 'console.log(1);\n',
    });
    for (const args of [['hash'], ['graph'], ['why', 'src/app.ts']]) {
      const { code, stdout, stderr } = run([...args, '-C', dir]);
      assert.equal(code, 2, args.join(' '));
      assert.equal(stdout, '');
      assert.match(stderr, /No entry files found/);
    }
  });

  test('a config file plus a real entry works', () => {
    const dir = app({
      'package.json': { name: 'v', devDependencies: { vite: '5.0.0' } },
      'vite.config.ts': 'export default {};\n',
      'index.html': '<script type="module" src="/src/app.ts"></script>\n',
      'src/app.ts': 'console.log(1);\n',
    });
    const { code, stdout } = run(['hash', '-C', dir]);
    assert.equal(code, 0);
    assert.match(stdout, /^[0-9a-f]{64}\n$/);
  });
});
