import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { describe, test } from 'node:test';
import {
  affected,
  affectedSinceCommit,
  affectedSinceManifest,
  analyze,
  createManifest,
  formatAffected,
  formatDot,
  formatGraph,
  formatMermaid,
  formatWhy,
  readManifest,
  summarize,
  why,
} from '../src/index.ts';
import { wildcardMatcher } from '../src/graph.ts';
import { globMatcher } from '../src/glob.ts';
import picomatch from 'picomatch';
import { app, commitAll, edit, git, pkg, write } from './helpers.ts';

const CLI = join(import.meta.dirname, '../src/cli.ts');
const UP = '../'.repeat(24);

const tempDir = (name: string) => realpathSync(mkdtempSync(join(tmpdir(), `byakugan-${name}-`)));

/**
 * Runs the CLI in a child process killed after `ms`. A hang or a runaway read then fails the
 * test instead of stalling the whole run. With `hash`, `keys` lists the manifest's fragment keys.
 */
const cli = (args: string[], ms = 20_000) => {
  const manifest = join(tempDir('manifest'), 'm.json');
  const withManifest = args[0] === 'hash' ? [...args, '--manifest', manifest] : args;
  const result = spawnSync(process.execPath, [CLI, ...withManifest], {
    encoding: 'utf8',
    timeout: ms,
    killSignal: 'SIGKILL',
    env: { ...process.env, GITHUB_OUTPUT: '' },
  });
  let keys: string[] = [];
  if (args[0] === 'hash' && result.status === 0) keys = Object.keys(JSON.parse(readFileSync(manifest, 'utf8')).fragments);
  return { code: result.status, signal: result.signal, stdout: result.stdout, stderr: result.stderr, keys };
};

const finished = (run: { code: number | null; signal: NodeJS.Signals | null; stderr: string }) => {
  assert.equal(run.signal, null, 'killed: the run did not finish in time');
  assert.equal(run.code, 0, run.stderr);
};

/** Moves a file out of the project: git sees it as deleted. */
const remove = (dir: string, path: string) => renameSync(join(dir, path), join(tempDir('trash'), 'removed'));

const keysOf = (dir: string) => [...analyze({ cwd: dir }).live.keys()];
const outsideKeys = (keys: string[]) => keys.filter(k => k.startsWith('../') || k.startsWith('/'));
const mkfifo = (path: string) => execFileSync('mkfifo', [path]);
const project = { 'package.json': { name: 'app', private: true } };
const next = { 'package.json': { name: 'web', private: true, dependencies: { next: '15.0.0' } }, 'app/page.tsx': 'export default function Page() {\n  return null;\n}\n' };
/** A Next.js app with an empty public/ directory. */
const nextApp = (files: Record<string, string | object> = {}, options: { repo?: boolean } = {}) => {
  const dir = app({ ...next, ...files }, options);
  mkdirSync(join(dir, 'public'), { recursive: true });
  return dir;
};

describe('computed imports and globs match in linear time', () => {
  test('an import() pattern with twelve wildcards finishes', () => {
    const dir = app({
      ...project,
      'src/index.ts': `const x = String(Math.random());\nexport const load = () => import(\`./l/${'${x}a'.repeat(12)}\${x}b.js\`);\n`,
      [`src/l/${'a'.repeat(60)}.txt`]: 'x\n',
    });
    finished(cli(['hash', '-C', dir]));
  });

  test('an import() pattern includes the files it matches', () => {
    const dir = app({
      ...project,
      'src/index.ts': 'const x = String(Math.random());\nexport const load = () => import(`./l/${x}a${x}a${x}b.js`);\n',
      'src/l/1a2a3b.js': 'export const hit = 1;\n',
    });
    assert.ok(keysOf(dir).some(k => k.startsWith('src/l/1a2a3b.js')));
  });

  test('an import() pattern leaves out files it does not match', () => {
    const dir = app({
      ...project,
      'src/index.ts': 'const x = String(Math.random());\nexport const load = () => import(`./l/${x}a${x}a${x}b.js`);\n',
      'src/l/1a2b.js': 'export const miss = 1;\n',
      'src/l/1a2a3b.ts': 'export const miss = 1;\n',
    });
    assert.ok(!keysOf(dir).some(k => k.startsWith('src/l/')));
  });

  const contextRepo = () =>
    app(
      {
        ...project,
        'src/index.ts': 'const x = String(Math.random());\nexport const load = () => import(`./l/${x}a${x}b.js`);\n',
        'src/l/1a2b.js': 'export const hit = 1;\n',
        'src/l/zzz.js': 'export const miss = 1;\n',
      },
      { repo: true }
    );

  test('git mode: deleting a file an import() pattern matches is affected', () => {
    const dir = contextRepo();
    remove(dir, 'src/l/1a2b.js');
    assert.equal(affected({ cwd: dir, base: 'main' }).affected, true);
  });

  test('git mode: deleting a file the import() pattern does not match is not affected', () => {
    const dir = contextRepo();
    remove(dir, 'src/l/zzz.js');
    assert.equal(affected({ cwd: dir, base: 'main' }).affected, false);
  });

  test('wildcardMatcher agrees with the regex a bundler builds', () => {
    const cases: Array<[string, string]> = [
      ['a*b*c', 'abc'],
      ['a*b*c', 'acb'],
      ['a*b*c', 'axxbyyc'],
      ['*aa', 'aaa'],
      ['a*a', 'a'],
      ['ab*ba', 'aba'],
      ['ab*ba', 'abba'],
      ['*x*x*', 'x'],
      ['*x*x*', 'xx'],
      ['plain', 'plain'],
      ['plain', 'plainer'],
    ];
    for (const [pattern, text] of cases) {
      const regex = new RegExp(`^${pattern.split('*').map(p => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`, 's');
      assert.equal(wildcardMatcher(pattern, '*')(text), regex.test(text), `${pattern} vs ${text}`);
    }
  });

  test('wildcardMatcher takes linear time on a long name', () => {
    const matches = wildcardMatcher(`${'*a'.repeat(40)}*b`, '*');
    const start = Date.now();
    assert.equal(matches('a'.repeat(200_000)), false);
    assert.ok(Date.now() - start < 1000);
  });

  test('an import.meta.glob with twelve wildcards finishes', () => {
    const dir = app({
      ...project,
      'src/index.ts': `export const pages = import.meta.glob('./l/${'*a'.repeat(12)}*b');\n`,
      [`src/l/${'a'.repeat(40)}`]: 'x\n',
    });
    finished(cli(['hash', '-C', dir]));
  });

  test('a glob with many wildcards still includes the files it matches', () => {
    const dir = app({
      ...project,
      'src/index.ts': `export const pages = import.meta.glob('./l/${'*a'.repeat(12)}*b.ts');\n`,
      [`src/l/${'a'.repeat(12)}b.ts`]: 'export const page = 1;\n',
    });
    assert.ok(keysOf(dir).some(k => k.startsWith(`src/l/${'a'.repeat(12)}b.ts`)));
  });

  test('a glob with many wildcards stays inside its directory', () => {
    const dir = app({
      ...project,
      'src/index.ts': `export const pages = import.meta.glob('./l/${'*a'.repeat(12)}*b.ts');\n`,
      [`src/other/${'a'.repeat(12)}b.ts`]: 'export const page = 1;\n',
    });
    assert.ok(!keysOf(dir).some(k => k.startsWith('src/other/')));
  });
  test('an import.meta.glob with three-star segments at four levels finishes', () => {
    const a = 'a'.repeat(40);
    const dir = app({
      ...project,
      'src/index.ts': "export const pages = import.meta.glob('./l/*a*a*a/*a*a*a/*a*a*a/*a*a*ab');\n",
      [`src/l/${a}/${a}/${a}/${a}`]: 'x\n',
    });
    finished(cli(['hash', '-C', dir]));
  });

  test('a glob with more than 256 brace expansions finishes', () => {
    const a = 'a'.repeat(40);
    const braces = '{a,b}'.repeat(9);
    const dir = app({
      ...project,
      'src/index.ts': `export const pages = import.meta.glob('./l/${braces}*a*a/*a*a/*a*a/*a*a/*a*a/*a*ab');\n`,
      [`src/l/aaaaaaaaa${a}/${a}/${a}/${a}/${a}/${a}`]: 'x\n',
    });
    finished(cli(['hash', '-C', dir], 10_000));
  });

  // 512 expansions: past the limit, the braces are widened to `*`.
  const braceApp = (file: string) =>
    app({ ...project, 'src/index.ts': `export const pages = import.meta.glob('./l/${'{a,b}'.repeat(9)}.ts');\n`, [file]: 'export const page = 1;\n' });

  test('a glob with more than 256 brace expansions still includes the files it matches', () => {
    assert.ok(keysOf(braceApp('src/l/ababababa.ts')).some(k => k.startsWith('src/l/ababababa.ts')));
  });

  test('a glob with more than 256 brace expansions stays inside its directory', () => {
    assert.ok(!keysOf(braceApp('src/other/ababababa.ts')).some(k => k.startsWith('src/other/')));
  });

  test('a sideEffects pattern with many wildcards finishes', () => {
    const a = 'a'.repeat(40);
    const dir = app({
      ...project,
      'src/lib/package.json': { name: 'lib', sideEffects: [`${'*a'.repeat(12)}*b`] },
      'src/index.ts': `import { y } from './lib/${a}';\nimport { z } from './lib/b';\nexport const x = y + z;\n`,
      [`src/lib/${a}.ts`]: 'export const y = 1;\n',
      'src/lib/b.ts': 'export const z = 1;\n',
    });
    finished(cli(['hash', '-C', dir]));
  });

  test('byakugan.json inputs with many wildcards finish', () => {
    const dir = app({
      ...project,
      'byakugan.json': { inputs: [`data/${'*a'.repeat(14)}*b`] },
      'src/index.ts': 'export const x = 1;\n',
      [`data/${'a'.repeat(40)}`]: 'x\n',
    });
    finished(cli(['hash', '-C', dir]));
  });

  // Unused bindings: the import runs the module only when sideEffects says it has effects.
  const sideEffectsApp = () =>
    app({
      ...project,
      'src/lib/package.json': { name: 'lib', sideEffects: ['effect.ts'] },
      'src/index.ts': "import { e } from './lib/effect';\nimport { p } from './lib/pure';\nexport const x = 1;\n",
      'src/lib/effect.ts': "console.log('effect');\nexport const e = 1;\n",
      'src/lib/pure.ts': "console.log('pure');\nexport const p = 1;\n",
    });

  test('a module a sideEffects glob names still runs', () => {
    assert.ok(keysOf(sideEffectsApp()).includes('src/lib/effect.ts#<module>'));
  });

  test('a module a sideEffects glob leaves out is dropped', () => {
    assert.ok(!keysOf(sideEffectsApp()).includes('src/lib/pure.ts#<module>'));
  });

  test('byakugan.json inputs match the files picomatch would, and only those', () => {
    const dir = app({
      ...project,
      'byakugan.json': { inputs: ['data/**/*.{json,yml}', '!data/skip/**', '.env*'] },
      'src/index.ts': 'export const x = 1;\n',
      'data/a.json': '{}\n',
      'data/deep/b.yml': 'x: 1\n',
      'data/c.txt': 'x\n',
      'data/skip/d.json': '{}\n',
      '.env.production': 'X=1\n',
    });
    const keys = keysOf(dir);
    assert.deepEqual(
      ['data/a.json', 'data/deep/b.yml', 'data/c.txt', 'data/skip/d.json', '.env.production'].filter(k => keys.includes(k)),
      ['data/a.json', 'data/deep/b.yml', '.env.production']
    );
  });

  test('globMatcher agrees with picomatch on patterns that need no widening', () => {
    const patterns = ['src/**/*.ts', '**/*.{ts,tsx}', 'app/**/{page,layout}.{ts,tsx}', '*.md', '.env*', 'a/?.ts', 'a/[bc].ts', '**', 'src/**', 'l/*a*a*a*b.ts', 'x/**/y/*'];
    const paths = [
      'src/a.ts',
      'src/deep/b.ts',
      'src/.hidden/c.ts',
      'src/.d.ts',
      'a.tsx',
      'app/page.ts',
      'app/x/layout.tsx',
      'app/x/other.tsx',
      'README.md',
      'docs/README.md',
      '.env',
      '.env.local',
      'a/b.ts',
      'a/bb.ts',
      'a/d.ts',
      'l/aaab.ts',
      'l/xaxaxaxb.ts',
      'l/aab.ts',
      'x/y/z',
      'x/q/r/y/z',
      'x/y',
    ];
    for (const dot of [false, true]) {
      for (const pattern of patterns) {
        const ours = globMatcher([pattern], { dot });
        const theirs = picomatch(pattern, { dot });
        for (const path of paths) assert.equal(ours(path), theirs(path), `${pattern} vs ${path} (dot: ${dot})`);
      }
    }
  });

  test('a widened glob segment still matches everything the original does', () => {
    const pattern = 'l/*a?*a?*a?b.ts';
    const ours = globMatcher([pattern]);
    const theirs = picomatch(pattern);
    for (const path of ['l/xaxaxaxb.ts', 'l/aaaaaab.ts', 'l/a1a2a3b.ts']) if (theirs(path)) assert.ok(ours(path), path);
    assert.equal(ours('m/aaaaaab.ts'), false);
  });
});

describe('MDX imports and bun.lock parse in linear time', () => {
  const mdx = (before: number, after: number) =>
    app({
      ...project,
      'src/index.ts': "import Post from './post.mdx';\nexport default Post;\n",
      'src/post.mdx': `${'\n'.repeat(before)}import { Note } from './note'\n${'\n'.repeat(after)}<Note />\n`,
      'src/note.ts': 'export const Note = () => null;\n',
      'src/other.ts': 'export const Other = () => null;\n',
    });

  // Blank lines after the last import: `^\s*` used to retry from every one of them.
  test('an MDX file with 400,000 blank lines finishes', () => {
    finished(cli(['hash', '-C', mdx(0, 400_000)]));
  });

  test('an MDX import after blank lines makes the component used', () => {
    assert.ok(keysOf(mdx(1000, 0)).includes('src/note.ts#Note'));
  });

  test('a component no MDX file imports stays unused', () => {
    assert.ok(!keysOf(mdx(1000, 0)).some(k => k.startsWith('src/other.ts')));
  });

  const bunLock = (versions: Record<string, string>) =>
    `{\n  "lockfileVersion": 1,\n  "packages": {\n${Object.entries(versions)
      .map(([name, v]) => `    "${name}": ["${name}@${v}", "", {}, "sha512-${name}${v}"],`)
      .join('\n')}\n  }\n}\n`;

  const bunApp = () =>
    app(
      {
        'package.json': { name: 'app', private: true, dependencies: { 'left-pad': '^1.0.0', 'is-odd': '^1.0.0' } },
        'bun.lock': bunLock({ 'left-pad': '1.3.0', 'is-odd': '1.0.0' }),
        'src/index.ts': "import pad from 'left-pad';\nexport const padded = pad('x');\n",
        ...pkg('left-pad', { main: 'index.js' }, { 'index.js': 'module.exports = s => s;\n' }),
        ...pkg('is-odd', { main: 'index.js' }, { 'index.js': 'module.exports = n => n % 2 === 1;\n' }),
      },
      { repo: true }
    );

  test('a bun.lock of 300,000 blank lines finishes in git mode and counts as changed', () => {
    const dir = bunApp();
    write(dir, 'bun.lock', `{${'\n'.repeat(300_000)}}\n`);
    const run = cli(['affected', '-C', dir, '--base', 'main', '--json']);
    finished(run);
    assert.equal(JSON.parse(run.stdout).affected, true);
  });

  test('a bun.lock bump of a used package is affected', () => {
    const dir = bunApp();
    write(dir, 'bun.lock', bunLock({ 'left-pad': '1.3.1', 'is-odd': '1.0.0' }));
    const result = affected({ cwd: dir, base: 'main' });
    assert.equal(result.affected, true);
    assert.deepEqual(result.reasons.map(r => r.key), ['left-pad']);
  });

  test('a bun.lock bump of an unused package is not affected', () => {
    const dir = bunApp();
    write(dir, 'bun.lock', bunLock({ 'left-pad': '1.3.0', 'is-odd': '1.0.1' }));
    assert.equal(affected({ cwd: dir, base: 'main' }).affected, false);
  });
});

describe('files that are not regular are never read', () => {
  // Globs list a symlink to a FIFO as a file. Reading it would wait for a writer forever.
  test('a FIFO linked from public/ does not block, and the files next to it still count', () => {
    const dir = app({ ...next, 'public/logo.svg': '<svg/>\n', 'fifo/.keep': '' });
    mkfifo(join(dir, 'fifo/pipe'));
    symlinkSync('../fifo/pipe', join(dir, 'public/feed'));
    const run = cli(['hash', '-C', dir], 15_000);
    finished(run);
    assert.ok(run.keys.includes('public/logo.svg'));
    assert.ok(!run.keys.includes('public/feed'));
  });

  test('public/zero linked to /dev/zero is skipped with a warning', () => {
    const dir = app({ ...next, 'public/logo.svg': '<svg/>\n' });
    symlinkSync('/dev/zero', join(dir, 'public/zero'));
    const run = cli(['hash', '-C', dir], 15_000);
    finished(run);
    assert.ok(!run.keys.includes('public/zero'));
    assert.match(run.stderr, /public\/zero: points outside the repository/);
  });

  test('a path in code that names a FIFO does not block', () => {
    const dir = app({
      ...project,
      'src/index.ts': "import { readFileSync } from 'node:fs';\nimport { join } from 'node:path';\nexport const feed = () => readFileSync(join(process.cwd(), 'data/feed'));\n",
      'data/.keep': '',
    });
    mkfifo(join(dir, 'data/feed'));
    finished(cli(['hash', '-C', dir], 15_000));
  });

  test('a directory read in code that holds a FIFO does not block, and its files still count', () => {
    const dir = app({
      ...project,
      'src/index.ts': "import { readFileSync } from 'node:fs';\nimport { join } from 'node:path';\nexport const post = (slug: string) => readFileSync(join(process.cwd(), 'content', slug));\n",
      'content/a.md': '# a\n',
      'fifo/.keep': '',
    });
    mkfifo(join(dir, 'fifo/pipe'));
    symlinkSync('../fifo/pipe', join(dir, 'content/feed'));
    const run = cli(['hash', '-C', dir], 15_000);
    finished(run);
    assert.ok(run.keys.includes('content/a.md'));
    assert.match(run.stderr, /content\/feed: cannot read it/);
  });

  /** A project with `fifo/pipe`, a FIFO inside the repository, for links to point at. */
  const withFifo = (files: Record<string, string | object>, options: { repo?: boolean } = {}) => {
    const dir = app({ ...files, 'fifo/.keep': '' }, options);
    mkfifo(join(dir, 'fifo/pipe'));
    return dir;
  };

  test('a byakugan.json that is a FIFO is refused, not read', () => {
    const dir = withFifo({ ...project, 'src/index.ts': 'export const x = 1;\n' });
    symlinkSync('fifo/pipe', join(dir, 'byakugan.json'));
    const run = cli(['hash', '-C', dir], 15_000);
    assert.equal(run.signal, null, 'killed: the run did not finish in time');
    assert.equal(run.code, 2);
    assert.match(run.stderr, /byakugan\.json is not a regular file/);
  });

  test('framework and wrangler configs that are FIFOs do not block', () => {
    const dir = withFifo({ ...next });
    symlinkSync('fifo/pipe', join(dir, 'next.config.js'));
    symlinkSync('fifo/pipe', join(dir, 'wrangler.toml'));
    const run = cli(['hash', '-C', dir], 15_000);
    finished(run);
    assert.ok(run.keys.includes('app/page.tsx#Page'), run.keys.join('\n'));
  });

  test('git mode: a lockfile that is a FIFO does not block and counts as changed', () => {
    const dir = withFifo({ ...project, 'src/index.ts': 'export const x = 1;\n' }, { repo: true });
    write(dir, 'docs/.keep', '');
    symlinkSync('../fifo/pipe', join(dir, 'docs/yarn.lock'));
    const run = cli(['affected', '-C', dir, '--base', 'main', '--json'], 15_000);
    finished(run);
    assert.deepEqual(JSON.parse(run.stdout).reasons.map((r: { key: string }) => r.key), ['docs/yarn.lock']);
  });

  test('a workspace package.json that is a FIFO stops the run instead of blocking it', () => {
    const dir = withFifo({
      ...project,
      'src/index.ts': "import { y } from './lib/y';\nexport const x = y;\n",
      'src/lib/y.ts': 'export const y = 1;\n',
    });
    symlinkSync('../../fifo/pipe', join(dir, 'src/lib/package.json'));
    const run = cli(['hash', '-C', dir], 10_000);
    assert.equal(run.signal, null, 'killed: the run did not finish in time');
    assert.equal(run.code, 2);
    assert.match(run.stderr, /src\/lib\/package\.json is not a regular file/);
  });

  // oxc-resolver reads it through a tsconfig alias, a path byakugan does not see before resolving.
  const aliasedLib = (target: string) => {
    const dir = app(
      {
        ...project,
        'tsconfig.json': { compilerOptions: { baseUrl: '.', paths: { '@/*': ['./src/*'] } } },
        'src/index.ts': "import { y } from '@/lib/y';\nexport const x = y;\n",
        'src/lib/y.ts': 'export const y = 1;\n',
        'src/lib/real.json': '{ "name": "lib" }\n',
      },
      { repo: true }
    );
    symlinkSync(target, join(dir, 'src/lib/package.json'));
    commitAll(dir, 'link');
    return dir;
  };

  test('a committed package.json link to /dev/zero stops the run', () => {
    const run = cli(['hash', '-C', aliasedLib('/dev/zero')], 10_000);
    assert.equal(run.signal, null, 'killed: the run did not finish in time');
    assert.equal(run.code, 2);
    assert.match(run.stderr, /src\/lib\/package\.json is not a regular file/);
  });

  test('a committed package.json link to a regular file is read', () => {
    const run = cli(['hash', '-C', aliasedLib('real.json')], 10_000);
    finished(run);
    assert.ok(run.keys.includes('src/lib/y.ts#y'), run.keys.join('\n'));
  });

  // 17 MB, past the 16 MB limit above which inputs are hashed in chunks.
  const big = () => Buffer.alloc(17 * 1024 * 1024, 'byakugan ');

  test('an input over 16 MB hashes to the sha256 of its bytes, like a small one', () => {
    const content = big();
    const dir = nextApp();
    writeFileSync(join(dir, 'public/big.bin'), content);
    const hash = analyze({ cwd: dir }).live.get('public/big.bin')?.hash;
    assert.equal(hash, createHash('sha256').update(content).digest('hex').slice(0, 20));
  });

  test('git mode: a big input whose mode changed but not its bytes is not affected', () => {
    const dir = nextApp({}, { repo: true });
    writeFileSync(join(dir, 'public/big.bin'), big());
    commitAll(dir, 'big');
    chmodSync(join(dir, 'public/big.bin'), 0o755);
    assert.equal(affected({ cwd: dir, base: 'HEAD' }).affected, false);
  });

  test('git mode: changing the last byte of a big input is affected', () => {
    const content = big();
    const dir = nextApp({}, { repo: true });
    writeFileSync(join(dir, 'public/big.bin'), content);
    commitAll(dir, 'big');
    content[content.length - 1] = 0x21;
    writeFileSync(join(dir, 'public/big.bin'), content);
    const result = affected({ cwd: dir, base: 'HEAD' });
    assert.deepEqual(result.reasons.map(r => r.key), ['public/big.bin']);
  });
});

describe('nothing outside the repository is read', () => {
  test('import() that climbs above the file system root is not walked', () => {
    const dir = app({ ...project, 'src/index.ts': `const n = String(Date.now());\nexport const load = () => import(\`${UP}\${n}.never-matches\`);\n` });
    const run = cli(['hash', '-C', dir]);
    finished(run);
    assert.match(run.stderr, /points outside the repository/);
  });

  test('import() into /etc leaves no key outside the repository', () => {
    const dir = app({ ...project, 'src/index.ts': `const name = process.argv[2];\nexport const load = () => import(\`${UP}etc/\${name}\`);\n` });
    const graph = analyze({ cwd: dir });
    assert.deepEqual(outsideKeys([...graph.live.keys()]), []);
    assert.deepEqual(outsideKeys(Object.keys(createManifest(graph).fragments)), []);
    assert.ok(graph.warnings.some(w => w.includes('points outside the repository')));
  });

  test('import() inside the repository is still followed', () => {
    const dir = app({
      ...project,
      'src/index.ts': 'const locale = process.argv[2];\nexport const load = () => import(`./locales/${locale}.json`);\n',
      'src/locales/en.json': '{}\n',
    });
    assert.ok(keysOf(dir).includes('src/locales/en.json'));
  });

  test('join(process.cwd(), "../../etc/hosts") is not read', () => {
    const dir = app({
      ...project,
      'src/index.ts': `import { readFileSync } from 'node:fs';\nimport { join } from 'node:path';\nexport const hosts = () => readFileSync(join(process.cwd(), '${UP}etc/hosts'));\n`,
    });
    const graph = analyze({ cwd: dir });
    assert.deepEqual(outsideKeys([...graph.live.keys()]), []);
    assert.ok(graph.warnings.some(w => w.includes('outside the repository')));
  });

  test('join(process.cwd(), "content/a.md") inside the repository is read', () => {
    const dir = app({
      ...project,
      'src/index.ts': "import { readFileSync } from 'node:fs';\nimport { join } from 'node:path';\nexport const post = () => readFileSync(join(process.cwd(), 'content/a.md'));\n",
      'content/a.md': '# a\n',
    });
    assert.ok(keysOf(dir).includes('content/a.md'));
  });

  test('import.meta.glob above the root is not followed', () => {
    const dir = app({ ...project, 'src/index.ts': `export const files = import.meta.glob('${UP}etc/host*');\n` });
    const graph = analyze({ cwd: dir });
    assert.deepEqual(outsideKeys([...graph.live.keys()]), []);
    assert.ok(graph.warnings.some(w => w.includes('points outside the repository')));
  });

  test('require.context above the root is not followed', () => {
    const dir = app({ ...project, 'src/index.ts': `export const files = require.context('${UP}etc', false, /hosts$/);\n` });
    const graph = analyze({ cwd: dir });
    assert.deepEqual(outsideKeys([...graph.live.keys()]), []);
    assert.ok(graph.warnings.some(w => w.includes('outside the repository')));
  });

  test('a symlink in public/ to a directory outside the repository is not read', () => {
    const outside = tempDir('outside');
    write(outside, 'secret.txt', 'token\n');
    const dir = nextApp();
    symlinkSync(outside, join(dir, 'public/cfg'));
    const graph = analyze({ cwd: dir });
    assert.ok(![...graph.live.keys()].some(k => k.includes('secret.txt')));
    assert.ok(graph.warnings.includes('public/cfg: points outside the repository, so it is not read'), graph.warnings.join('\n'));
  });

  test('a symlink in public/ to a directory inside the repository is read', () => {
    const dir = nextApp({ 'assets/logo.svg': '<svg/>\n' });
    symlinkSync('../assets', join(dir, 'public/shared'));
    assert.ok(keysOf(dir).includes('public/shared/logo.svg'));
  });

  test('a node_modules symlink in the repository does not reach outside it', () => {
    const outside = tempDir('outside');
    write(outside, 'secret.txt', 'token\n');
    const dir = app({
      ...project,
      'src/index.ts': "import { readFileSync } from 'node:fs';\nimport { join } from 'node:path';\nexport const cfg = (name: string) => readFileSync(join(process.cwd(), 'vendor/node_modules/cfg', name));\n",
      'vendor/node_modules/.keep': '',
    });
    symlinkSync(outside, join(dir, 'vendor/node_modules/cfg'));
    assert.ok(!keysOf(dir).some(k => k.includes('secret.txt')));
  });

  test('an import outside the repository is skipped', () => {
    const dir = app({ ...project, 'src/index.ts': `import hosts from '${UP}etc/hosts?raw';\nexport const x = hosts;\n` });
    assert.deepEqual(outsideKeys(keysOf(dir)), []);
  });

  test('an absolute import specifier outside the repository is skipped with a warning', () => {
    const graph = analyze({ cwd: app({ ...project, 'src/index.ts': "import hosts from '/etc/hosts?raw';\nexport const x = hosts;\n" }) });
    assert.deepEqual(outsideKeys([...graph.live.keys()]), []);
    assert.ok(graph.warnings.some(w => w.endsWith('etc/hosts: outside the repository, so it is not read')), graph.warnings.join('\n'));
  });

  test('package.json "main" outside the repository is not an entry', () => {
    const graph = analyze({ cwd: app({ 'package.json': { name: 'app', private: true, main: '/etc/hosts' }, 'src/index.ts': 'export const x = 1;\n' }) });
    assert.deepEqual(outsideKeys([...graph.live.keys()]), []);
    assert.ok(graph.live.has('src/index.ts#x'));
  });

  test('a ?raw import inside the repository is read', () => {
    const dir = app({ ...project, 'src/index.ts': "import text from './notes.txt?raw';\nexport const x = text;\n", 'src/notes.txt': 'hi\n' });
    assert.ok(keysOf(dir).includes('src/notes.txt'));
  });

  test('an installed package whose real path is a node_modules outside the repository is read', () => {
    const store = tempDir('store');
    write(store, 'node_modules/left-pad/package.json', '{ "name": "left-pad", "version": "1.3.0", "main": "index.js" }\n');
    write(store, 'node_modules/left-pad/index.js', 'module.exports = s => s;\n');
    const dir = app({ ...project, 'src/index.ts': "import pad from 'left-pad';\nexport const x = pad('a');\n", 'node_modules/.keep': '' });
    symlinkSync(join(store, 'node_modules/left-pad'), join(dir, 'node_modules/left-pad'));
    assert.ok(keysOf(dir).includes('npm:left-pad/index.js'));
  });

  test('a symlink to / in public/ is not walked', () => {
    const dir = nextApp({ 'public/logo.svg': '<svg/>\n' });
    symlinkSync('/', join(dir, 'public/root'));
    const run = cli(['hash', '-C', dir]);
    finished(run);
    assert.ok(run.keys.includes('public/logo.svg'));
    assert.match(run.stderr, /public\/root: points outside the repository/);
  });

  test('a symlink to / inside an import() directory is not walked', () => {
    const dir = app({
      ...project,
      'src/index.ts': 'const x = String(Math.random());\nexport const load = () => import(`./l/${x}.json`);\n',
      'src/l/en.json': '{}\n',
    });
    symlinkSync('/', join(dir, 'src/l/root'));
    const run = cli(['hash', '-C', dir]);
    finished(run);
    assert.ok(run.keys.includes('src/l/en.json'));
  });

  test('a symlink to / under an "inputs" glob is not walked', () => {
    const dir = app({ ...project, 'byakugan.json': { inputs: ['data/**'] }, 'src/index.ts': 'export const x = 1;\n', 'data/a.json': '{}\n' });
    symlinkSync('/', join(dir, 'data/root'));
    const run = cli(['hash', '-C', dir]);
    finished(run);
    assert.ok(run.keys.includes('data/a.json'));
  });

  test('an import() directory linked from inside the repository is followed', () => {
    const dir = app({
      ...project,
      'src/index.ts': 'const x = String(Math.random());\nexport const load = () => import(`./l/${x}.json`);\n',
      'shared/locales/en.json': '{}\n',
    });
    symlinkSync('../shared/locales', join(dir, 'src/l'));
    assert.ok(keysOf(dir).includes('src/l/en.json'));
  });

  const loop = () => {
    const dir = nextApp({ 'public/a/x.txt': 'x\n' });
    symlinkSync('..', join(dir, 'public/a/up'));
    symlinkSync('.', join(dir, 'public/a/self'));
    return dir;
  };

  // public/b.txt -> a.txt serves /b.txt as well as /a.txt, so the link is part of the build.
  const aliases = (options: { repo?: boolean } = {}) => {
    const dir = nextApp({ 'public/a.txt': 'a\n', 'public/img/x.png': 'x\n' }, options);
    symlinkSync('a.txt', join(dir, 'public/b.txt'));
    symlinkSync('img', join(dir, 'public/img2'));
    if (options.repo) commitAll(dir, 'aliases');
    return dir;
  };

  test('removing a symlink alias in public/ changes the fingerprint', () => {
    const dir = aliases();
    const before = analyze({ cwd: dir }).fingerprint();
    remove(dir, 'public/b.txt');
    assert.notEqual(analyze({ cwd: dir }).fingerprint(), before);
  });

  test('git mode: adding a symlink alias in public/ is affected', () => {
    const dir = aliases({ repo: true });
    symlinkSync('a.txt', join(dir, 'public/c.txt'));
    assert.equal(affected({ cwd: dir, base: 'main' }).affected, true);
  });

  test('git mode: removing a symlink alias in public/ is affected', () => {
    const dir = aliases({ repo: true });
    remove(dir, 'public/img2');
    assert.equal(affected({ cwd: dir, base: 'main' }).affected, true);
  });

  test('a symlink loop inside the repository ends', () => {
    const run = cli(['hash', '-C', loop()]);
    finished(run);
    assert.ok(run.keys.includes('public/a/x.txt'));
  });

  // A link to each level of a nested directory lists every file once per link above it: 1,000
  // files under 200 such links became 101,506 inputs and took 105 s.
  test('links to nested directories do not multiply the files crawled', () => {
    const dir = nextApp();
    let path = 'public/n';
    for (let i = 0; i < 30; i++) {
      path += '/d';
      write(dir, `${path}/f.txt`, `${i}\n`);
      symlinkSync(path.slice('public/'.length), join(dir, `public/l${i}`));
    }
    const run = cli(['hash', '-C', dir]);
    finished(run);
    assert.ok(run.keys.filter(k => k.endsWith('f.txt')).length <= 60, `${run.keys.length} keys for 30 files`);
  });
});

describe('deep code does not overflow the stack', () => {
  const nested = `export const x = ${'['.repeat(3000)}${']'.repeat(3000)};\n`;
  const payloadApp = () =>
    app(
      {
        ...project,
        'src/index.ts': "import { run } from './payload';\nexport const main = () => run();\n",
        'src/payload.ts': `${nested}export const run = () => console.log('v1');\n`,
      },
      { repo: true }
    );

  test('an edit next to a 3000-deep array changes the fingerprint', () => {
    const dir = payloadApp();
    const before = analyze({ cwd: dir }).fingerprint();
    edit(dir, 'src/payload.ts', s => s.replace("'v1'", "'v2'"));
    assert.notEqual(analyze({ cwd: dir }).fingerprint(), before);
  });

  test('an edit to the unused deep array leaves the fingerprint alone', () => {
    const dir = payloadApp();
    const before = analyze({ cwd: dir }).fingerprint();
    edit(dir, 'src/payload.ts', s => s.replace('[]', '[1]'));
    assert.equal(analyze({ cwd: dir }).fingerprint(), before);
  });

  test('manifest mode sees an edit next to a 3000-deep array', () => {
    const dir = payloadApp();
    const base = createManifest(analyze({ cwd: dir }));
    edit(dir, 'src/payload.ts', s => s.replace("'v1'", "'v2-evil'"));
    assert.equal(affected({ cwd: dir, baseManifest: base }).affected, true);
  });

  test('git mode compares a 3000-deep file by declaration', () => {
    const used = payloadApp();
    edit(used, 'src/payload.ts', s => s.replace("'v1'", "'v2'"));
    assert.equal(affected({ cwd: used, base: 'main' }).affected, true);
    const unused = payloadApp();
    edit(unused, 'src/payload.ts', s => s.replace('[]', '[1]'));
    assert.equal(affected({ cwd: unused, base: 'main' }).affected, false);
  });

  test('code too deep to analyze is hashed whole', () => {
    const terms = Array(20_000).fill('a').join(' + ');
    const dir = app({
      ...project,
      'src/index.ts': `const a = String(Math.random());\nexport const load = () => import('./x/' + ${terms});\nexport const unused = 1;\n`,
    });
    const graph = analyze({ cwd: dir });
    assert.ok(graph.warnings.some(w => w.startsWith('src/index.ts:') && w.includes('cannot analyze')));
    const before = graph.fingerprint();
    edit(dir, 'src/index.ts', s => s.replace('unused = 1', 'unused = 2'));
    assert.notEqual(analyze({ cwd: dir }).fingerprint(), before);
  });

  const chain = (n: number, link: (i: number) => string, last: string) => {
    const files: Record<string, string | object> = { ...project };
    for (let i = 0; i < n - 1; i++) files[`src/m${i}.ts`] = link(i + 1);
    files[`src/m${n - 1}.ts`] = last;
    return files;
  };

  test('a 3000-module export * chain reaches the export at its end', () => {
    const dir = app({
      ...chain(3000, i => `export * from './m${i}';\n`, 'export const leaf = 1;\nexport const other = 2;\n'),
      'src/index.ts': "import { leaf } from './m0';\nexport const x = leaf;\n",
    });
    const keys = keysOf(dir);
    assert.ok(keys.includes('src/m2999.ts#leaf'));
    assert.ok(!keys.includes('src/m2999.ts#other'));
  });

  test('a 5000-module chain of side-effect imports builds', () => {
    const dir = app({
      ...chain(5000, i => `import './m${i}';\n`, "console.log('end');\n"),
      'src/index.ts': "import './m0';\nimport './side';\nexport const x = 1;\n",
      'src/side.ts': "console.log('side');\n",
    });
    const keys = keysOf(dir);
    assert.ok(keys.includes('src/m4999.ts'));
    assert.ok(keys.includes('src/index.ts#<imports>'));
  });

  const declarations = (n: number) => {
    let source = 'const a0 = 1;\n';
    for (let i = 1; i < n; i++) source += `const a${i} = a${i - 1};\n`;
    return app({ ...project, 'src/index.ts': `${source}export const x = a${n - 1};\n` });
  };

  test('why prints a 20,000-step chain from its entry', () => {
    const dir = declarations(20_000);
    const graph = analyze({ cwd: dir });
    const lines = formatWhy(graph, why(graph, 'src/index.ts#a0', dir)).split('\n');
    assert.equal(lines[0], 'src/index.ts#a0');
    assert.equal(lines[1].trim(), 'src/index.ts (entry)');
  });

  test('why prints a 200,000-step chain', () => {
    const dir = declarations(200_000);
    const graph = analyze({ cwd: dir });
    assert.doesNotThrow(() => formatWhy(graph, why(graph, 'src/index.ts#a0', dir)));
  });

  test('affected text output prints a 200,000-step chain', () => {
    let source = 'const a0 = 1;\n';
    for (let i = 1; i < 200_000; i++) source += `const a${i} = a${i - 1};\n`;
    const dir = app({ ...project, 'src/index.ts': `${source}export const x = a199999;\n` }, { repo: true });
    edit(dir, 'src/index.ts', s => s.replace('const a0 = 1;', 'const a0 = 2;'));
    const graph = analyze({ cwd: dir });
    const result = affectedSinceCommit(graph, 'main');
    let text = '';
    assert.doesNotThrow(() => {
      text = formatAffected(graph, result, true);
    });
    assert.ok(text.includes('src/index.ts#a0 changed'), text.slice(0, 500));
  });
});

describe('git cannot run code from the repository', () => {
  /** apps/web committed as a git dir: HEAD, objects/, refs/ and a config whose fsmonitor runs a command. */
  const planted = () => {
    const marker = join(tempDir('marker'), 'PWNED');
    const dir = app({ 'package.json': { name: 'mono', private: true } }, { repo: true });
    const web = join(dir, 'apps/web');
    write(dir, 'apps/web/package.json', '{ "name": "web", "private": true }\n');
    write(dir, 'apps/web/src/index.ts', 'export const a = 1;\n');
    git(dir, 'init', '-q', '--bare', 'apps/web');
    const inner = (...args: string[]) => git(web, '--git-dir=.', '--work-tree=.', ...args);
    inner('config', 'core.bare', 'false');
    inner('config', 'core.worktree', '.');
    inner('add', 'package.json', 'src/index.ts');
    inner('-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-q', '-m', 'planted');
    inner('config', 'core.fsmonitor', `touch '${marker}'; false`);
    write(dir, 'apps/web/src/index.ts', 'export const a = 2;\n');
    return { web, marker };
  };

  test('a committed git dir does not run its core.fsmonitor', () => {
    const { web, marker } = planted();
    // Plain git must run the planted command, or the test proves nothing.
    git(web, 'status', '--short');
    assert.ok(existsSync(marker), 'plain git did not run the planted fsmonitor');
    const fresh = planted();
    try {
      affected({ cwd: fresh.web, base: 'HEAD' });
    } catch {}
    assert.equal(existsSync(fresh.marker), false);
  });

  test('a committed git dir is not used as the base', () => {
    const { web } = planted();
    assert.throws(() => affected({ cwd: web, base: 'HEAD' }), /not inside a git repository/);
  });

  test('a normal repository still works', () => {
    const dir = app({ ...project, 'src/index.ts': 'export const a = 1;\n' }, { repo: true });
    edit(dir, 'src/index.ts', s => s.replace('1', '2'));
    assert.equal(affected({ cwd: dir, base: 'main' }).affected, true);
  });
});

describe('arguments and manifests from outside are checked', () => {
  const repo = () => {
    const dir = app({ ...project, 'src/index.ts': 'export const a = 1;\n' }, { repo: true });
    edit(dir, 'src/index.ts', s => s.replace('1', '2'));
    return dir;
  };

  test('a base that looks like a git option is rejected', () => {
    assert.throws(() => affected({ cwd: repo(), base: '--independent' }), /is not a git ref/);
  });

  test('a base that is a ref is compared', () => {
    assert.equal(affected({ cwd: repo(), base: 'main' }).affected, true);
  });

  const manifestFile = (content: string) => {
    const file = join(tempDir('manifest'), 'm.json');
    writeFileSync(file, content);
    return file;
  };

  test('a manifest with "fragments": null is rejected', () => {
    assert.throws(() => readManifest(manifestFile('{"version":1,"fragments":null}')), /is not a byakugan manifest/);
  });

  test('a manifest with an object under __proto__ is rejected', () => {
    assert.throws(() => readManifest(manifestFile('{"version":1,"fragments":{"__proto__":{"x":1}}}')), /is not a byakugan manifest/);
  });

  test('a manifest with a __proto__ string key is harmless', () => {
    const dir = app({ ...project, 'src/index.ts': 'export const a = 1;\n' });
    const graph = analyze({ cwd: dir });
    const fragments = { ...createManifest(graph).fragments };
    const text = JSON.stringify({ ...createManifest(graph), fragments }).replace('"fragments":{', '"fragments":{"__proto__":"x",');
    const result = affectedSinceManifest(graph, readManifest(manifestFile(text)));
    assert.equal(({} as Record<string, unknown>).x, undefined);
    assert.equal(Object.getPrototypeOf(readManifest(manifestFile(text)).fragments), Object.prototype);
    assert.deepEqual(result.reasons.map(r => `${r.key}: ${r.detail}`), ['__proto__: no longer used']);
  });

  test('a manifest whose per-file fingerprints or version are not strings is rejected', () => {
    for (const extra of ['"each":{"a.test.ts":{"x":1}}', '"each":["a"]', '"byakugan":{"x":1}', '"mode":1']) {
      assert.throws(() => readManifest(manifestFile(`{"version":2,"fingerprint":"","fragments":{},${extra}}`)), /is not a byakugan manifest/, extra);
    }
  });

  test('a manifest the tool wrote reads back as unaffected', () => {
    const dir = app({ ...project, 'src/index.ts': 'export const a = 1;\n' });
    const graph = analyze({ cwd: dir });
    const file = manifestFile(JSON.stringify(createManifest(graph)));
    assert.equal(affectedSinceManifest(graph, readManifest(file)).affected, false);
  });
});

describe('output escapes file names', () => {
  const RAW_CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/;
  const mermaidName = 'q"]\n  click n0 href "javascript:alert(1)"\n  x["y';
  const dotName = 'd" [URL="javascript:alert(2)" image="secret.png"] "e';
  const injected = () =>
    app({
      ...project,
      'src/index.ts': `import { q } from ${JSON.stringify(`./${mermaidName}`)};\nimport { d } from ${JSON.stringify(`./${dotName}`)};\nexport const z = q + d;\n`,
      [`src/${mermaidName}.ts`]: 'export const q = 1;\n',
      [`src/${dotName}.ts`]: 'export const d = 1;\n',
    });

  test('Mermaid output holds only node and edge lines', () => {
    const out = formatMermaid(analyze({ cwd: injected() }));
    for (const line of out.split('\n')) {
      assert.match(line, /^(graph LR|  n\d+\[\[?"[^"]*"\]\]?|  n\d+ -->\|"[^"]*"\| n\d+)$/, line);
    }
  });

  test('Mermaid output keeps plain names as they are', () => {
    const dir = app({ ...project, 'src/index.ts': "import { b } from './b';\nexport const a = b;\n", 'src/b.ts': 'export const b = 1;\n' });
    assert.deepEqual(formatMermaid(analyze({ cwd: dir })).split('\n'), ['graph LR', '  n0["src/index.ts"]', '  n1["src/b.ts"]', '  n0 -->|"b"| n1']);
  });

  test('DOT output escapes quotes in names', () => {
    const out = formatDot(analyze({ cwd: injected() }));
    const quoted = '"(?:[^"\\\\]|\\\\.)*"';
    const shape = new RegExp(`^(digraph byakugan \\{|  rankdir=LR;|  node \\[shape=box, fontname="Helvetica"\\];|  ${quoted}( \\[shape=component\\])?;|  ${quoted} -> ${quoted} \\[label=${quoted}\\];|\\})$`);
    for (const line of out.split('\n')) assert.match(line, shape, line);
    assert.ok(out.includes('"src/d\\" [URL=\\"javascript:alert(2)\\"'));
  });

  const escName = 'notes\u001b[1A\u001b[2K\rmore\n::error title=byakugan::spoofed annotation\n.md';
  const titleName = 'x\u001b]0;TITLE-SET\u0007.md';

  test('affected text output escapes ESC sequences and line breaks in file names', () => {
    const dir = app({ ...project, 'src/index.ts': 'export const a = 1;\n' }, { repo: true });
    write(dir, escName, 'x\n');
    write(dir, titleName, 'x\n');
    const graph = analyze({ cwd: dir });
    const out = formatAffected(graph, affectedSinceCommit(graph, 'main'), true);
    assert.ok(!RAW_CONTROL.test(out), JSON.stringify(out));
    assert.ok(!out.split('\n').some(line => /^\s*::/.test(line)));
    assert.ok(out.includes('notes\\u001b[1A\\u001b[2K more ::error'));
    assert.ok(out.includes('x\\u001b]0;TITLE-SET\\u0007.md'));
  });

  const escImport = () =>
    app({
      ...project,
      'src/index.ts': `import { t } from ${JSON.stringify(`./${titleName.replace('.md', '')}`)};\nimport { m } from './missing\\u001b[2J\\n::error::spoofed';\nexport const z = t + m;\n`,
      [`src/${titleName.replace('.md', '.ts')}`]: 'export const t = 1;\n',
    });

  test('graph and why text output escape ESC sequences in file names and warnings', () => {
    const dir = escImport();
    const graph = analyze({ cwd: dir });
    const text = formatGraph(summarize(graph));
    assert.ok(!RAW_CONTROL.test(text), JSON.stringify(text));
    assert.ok(text.includes('src/x\\u001b]0;TITLE-SET\\u0007.ts'));
    const key = `src/${titleName.replace('.md', '.ts')}`;
    const whyText = formatWhy(graph, why(graph, key, dir));
    assert.ok(!RAW_CONTROL.test(whyText), JSON.stringify(whyText));
    assert.ok(whyText.includes('src/x\\u001b]0;TITLE-SET\\u0007.ts#t'));
  });

  test('CLI warnings on stderr escape ESC sequences and cannot start a workflow command', () => {
    const run = cli(['hash', '-C', escImport()]);
    finished(run);
    assert.ok(!RAW_CONTROL.test(run.stderr), JSON.stringify(run.stderr));
    assert.ok(!run.stderr.split('\n').some(line => /^\s*::/.test(line)));
    assert.match(run.stderr, /cannot resolve "\.\/missing\\u001b\[2J ::error::spoofed"/);
    assert.match(run.stdout, /^[0-9a-f]{64}\n$/);
  });

  test('CLI errors escape ESC sequences and line breaks from the repository', () => {
    const dir = app({ ...project, 'src/index.ts': 'export const x = 1;\n', 'byakugan.json': '{"entry": [x\u001b]0;PWN\u0007\n::error::spoof]}' });
    const run = cli(['hash', '-C', dir]);
    assert.equal(run.signal, null);
    assert.equal(run.code, 2);
    assert.match(run.stderr, /is not valid JSON/);
    assert.ok(!RAW_CONTROL.test(run.stderr), JSON.stringify(run.stderr));
    assert.ok(!run.stderr.split('\n').some(line => /^\s*::/.test(line)));
  });
});

describe('comments are stripped in linear time', () => {
  test('a stylesheet of 330,000 unclosed comment openers finishes', () => {
    const dir = app({ ...project, 'src/index.ts': "import './a.css';\nexport const x = 1;\n", 'src/a.css': '/* '.repeat(330_000) });
    finished(cli(['hash', '-C', dir]));
  });

  test('a script whose comment holds 1,000,000 spaces finishes', () => {
    const dir = app({ ...project, 'src/index.ts': `/*\n${' '.repeat(1_000_000)}x */\nexport const x = 1;\n` });
    finished(cli(['hash', '-C', dir]));
  });

  const vite = { 'package.json': { name: 'site', private: true, devDependencies: { vite: '6.0.0' } }, 'src/main.ts': 'export const main = 1;\n', 'src/old.ts': 'export const old = 1;\n' };

  test('an index.html of 250,000 unclosed comment openers finishes', () => {
    const dir = app({ ...vite, 'index.html': `<script type="module" src="/src/main.ts"></script>\n${'<!--'.repeat(250_000)}` });
    const run = cli(['hash', '-C', dir]);
    finished(run);
    assert.ok(run.keys.includes('src/main.ts#main'));
  });

  test('an @import inside a CSS comment is not followed, one outside is', () => {
    const dir = app({
      ...project,
      'src/index.ts': "import './a.css';\nexport const x = 1;\n",
      'src/a.css': "/* @import './old.css'; */\n@import './new.css';\n",
      'src/old.css': '.old {}\n',
      'src/new.css': '.new {}\n',
    });
    const keys = keysOf(dir);
    assert.ok(keys.includes('src/new.css'));
    assert.ok(!keys.includes('src/old.css'));
  });

  test('a script inside an HTML comment is not an entry, one outside is', () => {
    const dir = app({ ...vite, 'index.html': '<!-- <script type="module" src="/src/old.ts"></script> -->\n<script type="module" src="/src/main.ts"></script>\n' });
    const keys = keysOf(dir);
    assert.ok(keys.includes('src/main.ts#main'));
    assert.ok(!keys.some(k => k.startsWith('src/old.ts')));
  });
});

/** Commits the working tree on a `pr` branch, the way CI checks out a pull request. */
const commitOnBranch = (dir: string) => {
  git(dir, 'checkout', '-q', '-b', 'pr');
  commitAll(dir, 'pr');
};

/** Points the link at `path` somewhere else. */
const relink = (dir: string, path: string, target: string) => {
  remove(dir, path);
  symlinkSync(target, join(dir, path));
};

describe('a symlinked directory counts wherever the build reads it', () => {
  // Next.js serves app/media/hero.jpg as /media/hero.jpg through public/media -> ../app/media.
  const mediaApp = (link: boolean, options: { repo?: boolean } = {}) => {
    const dir = nextApp({ 'app/media/hero.jpg': 'v1\n' }, options);
    if (link) symlinkSync('../app/media', join(dir, 'public/media'));
    if (link && options.repo) commitAll(dir, 'link');
    return dir;
  };

  test(
    'an edit under app/media, which public/media links to, changes the fingerprint',
    () => {
      const dir = mediaApp(true);
      const before = analyze({ cwd: dir }).fingerprint();
      write(dir, 'app/media/hero.jpg', 'v2\n');
      assert.notEqual(analyze({ cwd: dir }).fingerprint(), before);
    }
  );

  test('an edit under app/media that no link serves leaves the fingerprint alone', () => {
    const dir = mediaApp(false);
    const before = analyze({ cwd: dir }).fingerprint();
    write(dir, 'app/media/hero.jpg', 'v2\n');
    assert.equal(analyze({ cwd: dir }).fingerprint(), before);
  });

  test(
    'git mode: an edit under app/media, which public/media links to, is affected',
    () => {
      const dir = mediaApp(true, { repo: true });
      write(dir, 'app/media/hero.jpg', 'v2\n');
      assert.equal(affected({ cwd: dir, base: 'main' }).affected, true);
    }
  );

  test('git mode: an edit under app/media that no link serves is not affected', () => {
    const dir = mediaApp(false, { repo: true });
    write(dir, 'app/media/hero.jpg', 'v2\n');
    assert.equal(affected({ cwd: dir, base: 'main' }).affected, false);
  });

  /** brand/ linked from `links`, outside every pattern prefix. */
  const brandApp = (links: string[]) => {
    const dir = nextApp({ 'brand/logo.svg': '<svg>1</svg>\n', 'brand/icon.png': 'png1\n' });
    for (const link of links) symlinkSync('../brand', join(dir, link));
    return dir;
  };

  test(
    'a directory linked from both app/ and public/ counts every file public/ serves',
    () => {
      const dir = brandApp(['app/brand', 'public/brand']);
      const before = analyze({ cwd: dir }).fingerprint();
      write(dir, 'brand/logo.svg', '<svg>2</svg>\n');
      assert.notEqual(analyze({ cwd: dir }).fingerprint(), before);
    }
  );

  test('a directory linked only from app/ counts only the files Next.js reads there', () => {
    const dir = brandApp(['app/brand']);
    const before = analyze({ cwd: dir }).fingerprint();
    write(dir, 'brand/logo.svg', '<svg>2</svg>\n');
    assert.equal(analyze({ cwd: dir }).fingerprint(), before);
    write(dir, 'brand/icon.png', 'png2\n');
    assert.notEqual(analyze({ cwd: dir }).fingerprint(), before);
  });

  // Next.js follows directory links in app/, so app/blog -> docs adds a /blog route.
  const routesApp = (options: { repo?: boolean } = {}) =>
    nextApp({ 'app/docs/page.tsx': 'export default function Docs() {\n  return 1;\n}\n', 'notes/readme.md': '# notes\n' }, options);

  test(
    'adding a route link inside app/ changes the fingerprint',
    () => {
      const dir = routesApp();
      const before = analyze({ cwd: dir }).fingerprint();
      symlinkSync('docs', join(dir, 'app/blog'));
      assert.notEqual(analyze({ cwd: dir }).fingerprint(), before);
    }
  );

  test('git mode: adding a committed route link inside app/ is affected', () => {
    const dir = routesApp({ repo: true });
    symlinkSync('docs', join(dir, 'app/blog'));
    commitOnBranch(dir);
    assert.equal(affected({ cwd: dir, base: 'main' }).affected, true);
  });

  test('adding a link inside app/ to a directory without route files leaves the fingerprint alone', () => {
    const dir = routesApp();
    const before = analyze({ cwd: dir }).fingerprint();
    symlinkSync('../notes', join(dir, 'app/notes'));
    assert.equal(analyze({ cwd: dir }).fingerprint(), before);
  });

  const mdApp = (options: { repo?: boolean } = {}) =>
    app({ ...project, 'byakugan.json': { inputs: ['content/**/*.md'] }, 'src/index.ts': 'export const x = 1;\n', 'content/v1/a.md': '# a\n' }, options);

  test(
    'adding a link under an "inputs" glob that filters by name changes the fingerprint',
    () => {
      const dir = mdApp();
      const before = analyze({ cwd: dir }).fingerprint();
      symlinkSync('v1', join(dir, 'content/v2'));
      assert.notEqual(analyze({ cwd: dir }).fingerprint(), before);
    }
  );

  test(
    'git mode: adding a link under an "inputs" glob that filters by name is affected',
    () => {
      const dir = mdApp({ repo: true });
      symlinkSync('v1', join(dir, 'content/v2'));
      commitOnBranch(dir);
      assert.equal(affected({ cwd: dir, base: 'main' }).affected, true);
    }
  );

  test('git mode: adding a file the "inputs" glob does not match is not affected', () => {
    const dir = mdApp({ repo: true });
    write(dir, 'content/v1/notes.txt', 'n\n');
    commitOnBranch(dir);
    assert.equal(affected({ cwd: dir, base: 'main' }).affected, false);
  });

  /** assets/ and assets2/ outside every pattern prefix, with a committed link at `link` to assets/. */
  const sharedApp = (link: string) => {
    const dir = nextApp({ 'assets/logo.svg': '<svg>1</svg>\n', 'assets2/logo.svg': '<svg>2</svg>\n', 'lib/.keep': '' }, { repo: true });
    symlinkSync('../assets', join(dir, link));
    commitAll(dir, 'link');
    return dir;
  };

  test(
    'git mode: retargeting a public/ link to a directory outside every pattern is affected',
    () => {
      const dir = sharedApp('public/shared');
      relink(dir, 'public/shared', '../assets2');
      commitOnBranch(dir);
      assert.equal(affected({ cwd: dir, base: 'main' }).affected, true);
    }
  );

  test('git mode: retargeting a link that no pattern reaches is not affected', () => {
    const dir = sharedApp('lib/shared');
    relink(dir, 'lib/shared', '../assets2');
    commitOnBranch(dir);
    assert.equal(affected({ cwd: dir, base: 'main' }).affected, false);
  });

  /** `import(\`./l/${l}/messages.json\`)` with src/l/de and src/l/fr linked to shared/. */
  const localeApp = () => {
    const dir = app({
      ...project,
      'src/index.ts': 'export const load = (l: string) => import(`./l/${l}/messages.json`);\n',
      'shared/de/messages.json': '{ "hi": "hallo" }\n',
      'shared/fr/messages.json': '{ "hi": "salut" }\n',
      'src/l/.keep': '',
    });
    symlinkSync('../../shared/de', join(dir, 'src/l/de'));
    symlinkSync('../../shared/fr', join(dir, 'src/l/fr'));
    return dir;
  };

  test(
    'adding a second link to a locale directory an import() pattern reads changes the fingerprint',
    () => {
      const dir = localeApp();
      const before = analyze({ cwd: dir }).fingerprint();
      symlinkSync('../../shared/de', join(dir, 'src/l/at'));
      assert.notEqual(analyze({ cwd: dir }).fingerprint(), before);
    }
  );

  test('adding a link outside the import() directory leaves the fingerprint alone', () => {
    const dir = localeApp();
    const before = analyze({ cwd: dir }).fingerprint();
    symlinkSync('../shared/de', join(dir, 'src/other'));
    assert.equal(analyze({ cwd: dir }).fingerprint(), before);
  });

  /** content/ read through process.cwd(), its entries linked into shared/. content/a is the link the crawl lists. */
  const contentApp = () => {
    const dir = app({
      ...project,
      'src/index.ts':
        "import { readFileSync } from 'node:fs';\nimport { join } from 'node:path';\nexport const post = (slug: string) => readFileSync(join(process.cwd(), 'content', slug));\n",
      'shared/b/x.md': 'b\n',
      'shared/c/x.md': 'c\n',
      'notes.md': 'n\n',
      'content/.keep': '',
    });
    symlinkSync('../shared/b', join(dir, 'content/a'));
    symlinkSync('../shared/b', join(dir, 'content/b'));
    symlinkSync('../shared/c', join(dir, 'content/c'));
    return dir;
  };

  test(
    'retargeting a link under a directory read through process.cwd() changes the fingerprint',
    () => {
      const dir = contentApp();
      const before = analyze({ cwd: dir }).fingerprint();
      relink(dir, 'content/a', '../shared/c');
      assert.notEqual(analyze({ cwd: dir }).fingerprint(), before);
    }
  );

  test('an edit next to a directory read through process.cwd() leaves the fingerprint alone', () => {
    const dir = contentApp();
    const before = analyze({ cwd: dir }).fingerprint();
    write(dir, 'notes.md', 'n2\n');
    assert.equal(analyze({ cwd: dir }).fingerprint(), before);
  });

  /** A Next.js app with `n` links public/l<i> -> ../assets/d<i>, each to its own directory. */
  const manyLinks = (n: number) => {
    const dir = nextApp();
    for (let i = 0; i < n; i++) {
      write(dir, `assets/d${i}/f.txt`, `${i}\n`);
      symlinkSync(`../assets/d${i}`, join(dir, `public/l${i}`));
    }
    return dir;
  };

  // 8,000 such links took 4 s a crawl, 16,000 took 30 s.
  test(
    'twelve thousand links to distinct directories crawl in linear time',
    () => {
      finished(cli(['hash', '-C', manyLinks(12_000)], 8_000));
    }
  );

  test('two thousand links to distinct directories list every linked file', () => {
    const run = cli(['hash', '-C', manyLinks(2_000)]);
    finished(run);
    assert.ok(run.keys.includes('public/l0/f.txt'));
    assert.ok(run.keys.includes('public/l1999/f.txt'));
  });

  /** `n` sibling modules in src/l, each loading the others by a computed name. */
  const siblings = (n: number) => {
    const files: Record<string, string | object> = { ...project, 'src/index.ts': "export { load0 } from './l/m0';\n" };
    for (let i = 0; i < n; i++) files[`src/l/m${i}.ts`] = `export const load${i} = (x: string) => import(\`./\${x}.ts\`);\n`;
    return app(files);
  };

  // 2,000 modules took 20 s; 4,000 ran out of a 4 GB heap.
  test(
    'modules that each import() their siblings by a computed name finish in linear time',
    () => {
      finished(cli(['hash', '-C', siblings(2_500)], 8_000));
    }
  );

  test('a computed import() reaches every sibling module', () => {
    const run = cli(['hash', '-C', siblings(30)]);
    finished(run);
    assert.ok(run.keys.includes('src/l/m29.ts#load29'), run.keys.join('\n'));
  });
});

describe('widened globs never drop a file picomatch keeps', () => {
  const nine = '{a,b}'.repeat(9);
  const inputsApp = (inputs: string[]) =>
    app({ ...project, 'byakugan.json': { inputs }, 'src/index.ts': 'export const x = 1;\n', 'data/x.json': '{}\n', 'data/skip.json': '{}\n' });

  test(
    'byakugan.json inputs keep a file that a negated glob over 256 brace expansions does not match',
    () => {
      assert.ok(keysOf(inputsApp(['data/**', `!data/${nine}.json`])).includes('data/x.json'));
    }
  );

  test('byakugan.json inputs drop a file that a plain negated glob matches', () => {
    const keys = keysOf(inputsApp(['data/**', '!data/skip.json']));
    assert.ok(keys.includes('data/x.json'));
    assert.ok(!keys.includes('data/skip.json'));
  });

  const pagesApp = (exclude: string) =>
    app({
      ...project,
      'src/index.ts': `export const pages = import.meta.glob(['./pages/*.ts', '${exclude}']);\n`,
      'src/pages/home.ts': 'export const home = 1;\n',
      'src/pages/skip.ts': 'export const skip = 1;\n',
    });

  test(
    'import.meta.glob keeps a page that an exclusion with many wildcards does not match',
    () => {
      assert.ok(keysOf(pagesApp('!./pages/*a*a*a?.ts')).some(k => k.startsWith('src/pages/home.ts')));
    }
  );

  test('import.meta.glob drops a page that a plain exclusion matches', () => {
    const keys = keysOf(pagesApp('!./pages/skip.ts'));
    assert.ok(keys.some(k => k.startsWith('src/pages/home.ts')));
    assert.ok(!keys.some(k => k.startsWith('src/pages/skip.ts')));
  });

  const escaped = `data/{a\\},${Array.from({ length: 300 }, (_, i) => `n${i}`).join(',')}}.json`;

  test(
    'a brace group of over 256 alternatives with an escaped brace still matches each alternative',
    () => {
      for (const path of ['data/n7.json', 'data/a}.json']) {
        assert.equal(picomatch(escaped, { dot: true })(path), true);
        assert.equal(globMatcher([escaped], { dot: true })(path), true, path);
      }
    }
  );

  test('a brace group of over 256 alternatives does not match a name outside it', () => {
    assert.equal(picomatch(escaped, { dot: true })('data/zz.json'), false);
    assert.equal(globMatcher([escaped], { dot: true })('data/zz.json'), false);
  });

  const dotNames = `{.env,.envrc}${nine}`;

  test(
    'a widened brace group of dot names still matches them with dot off',
    () => {
      const path = `.env${'a'.repeat(9)}`;
      assert.equal(picomatch(dotNames)(path), true);
      assert.equal(globMatcher([dotNames])(path), true);
    }
  );

  test('a widened brace group of dot names does not match other dot names with dot off', () => {
    const path = `.foo${'a'.repeat(9)}`;
    assert.equal(picomatch(dotNames)(path), false);
    assert.equal(globMatcher([dotNames])(path), false);
  });

  /** import.meta.glob of `k` globstars, over x.ts files nested `depth` levels deep and one y.ts. */
  const globstars = (k: number, depth: number) => {
    const files: Record<string, string | object> = { ...project, 'src/index.ts': `export const all = import.meta.glob('./${'**/'.repeat(k)}x.ts');\n` };
    for (let i = 1; i <= depth; i++) files[`src/${'d/'.repeat(i)}x.ts`] = `export const v = ${i};\n`;
    files['src/d/d/y.ts'] = 'export const y = 1;\n';
    return app(files);
  };

  // 4,000 globstars over a 300-level tree took 166 s.
  test(
    'an import.meta.glob of 2,000 globstars over a 200-level tree finishes',
    () => {
      finished(cli(['hash', '-C', globstars(2_000, 200)], 8_000));
    }
  );

  test('an import.meta.glob of repeated globstars matches the deep files and only those', () => {
    const keys = keysOf(globstars(20, 30));
    assert.ok(keys.includes(`src/${'d/'.repeat(30)}x.ts#v`));
    assert.ok(keys.includes('src/d/x.ts#v'));
    assert.ok(!keys.some(k => k.startsWith('src/d/d/y.ts')));
  });
});

describe('the resolver reads only regular files', () => {
  /** A project that imports src/lib/y.ts, with `fifo/pipe` for links to point at. */
  const fifoApp = (files: Record<string, string | object>, options: { repo?: boolean } = {}) => {
    const dir = app({ ...project, 'src/index.ts': "import { y } from './lib/y';\nexport const x = y;\n", 'src/lib/y.ts': 'export const y = 1;\n', 'fifo/.keep': '', ...files }, options);
    mkfifo(join(dir, 'fifo/pipe'));
    return dir;
  };

  const referenceApp = (target: string) => {
    const dir = fifoApp({ 'tsconfig.json': { references: [{ path: './ref' }] }, 'ref/real.json': '{}\n' }, { repo: true });
    symlinkSync(target, join(dir, 'ref/tsconfig.json'));
    commitAll(dir, 'reference');
    return dir;
  };

  test(
    'a tsconfig reference linked to a FIFO does not block',
    () => {
      const run = cli(['hash', '-C', referenceApp('../fifo/pipe')], 3_000);
      assert.equal(run.signal, null, 'killed: the run did not finish in time');
    }
  );

  test('a tsconfig reference linked to a regular file is read', () => {
    const run = cli(['hash', '-C', referenceApp('real.json')], 10_000);
    finished(run);
    assert.ok(run.keys.includes('src/lib/y.ts#y'), run.keys.join('\n'));
  });

  // A source tarball: no .git, so no committed links to check before resolving.
  const tarball = (target: string) => {
    const dir = fifoApp({
      'tsconfig.json': { compilerOptions: { baseUrl: '.', paths: { '@/*': ['./src/*'] } } },
      'src/index.ts': "import { y } from '@/lib/y';\nexport const x = y;\n",
      'src/lib/real.json': '{ "name": "lib" }\n',
    });
    symlinkSync(target, join(dir, 'src/lib/package.json'));
    return dir;
  };

  test(
    'without .git, a package.json link to a FIFO on an alias path does not block',
    () => {
      const run = cli(['hash', '-C', tarball('../../fifo/pipe')], 3_000);
      assert.equal(run.signal, null, 'killed: the run did not finish in time');
    }
  );

  test('without .git, a package.json link to a regular file on an alias path is read', () => {
    const run = cli(['hash', '-C', tarball('real.json')], 10_000);
    finished(run);
    assert.ok(run.keys.includes('src/lib/y.ts#y'), run.keys.join('\n'));
  });

  /** vendor/ is a submodule holding lib/y.ts and a lib/package.json link to `target`. */
  const withSubmodule = (target: string) => {
    const sub = app({ 'lib/y.ts': 'export const y = 1;\n', 'lib/real.json': '{ "name": "lib" }\n' });
    symlinkSync(target, join(sub, 'lib/package.json'));
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: sub });
    git(sub, 'add', '-A');
    git(sub, '-c', 'user.email=t@example.com', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'sub');
    const dir = fifoApp(
      { 'tsconfig.json': { compilerOptions: { baseUrl: '.', paths: { '@/*': ['./vendor/*'] } } }, 'src/index.ts': "import { y } from '@/lib/y';\nexport const x = y;\n" },
      { repo: true }
    );
    git(dir, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', sub, 'vendor');
    commitAll(dir, 'submodule');
    return dir;
  };

  test(
    'a package.json link to a FIFO inside a submodule does not block',
    () => {
      const run = cli(['hash', '-C', withSubmodule('../../fifo/pipe')], 3_000);
      assert.equal(run.signal, null, 'killed: the run did not finish in time');
    }
  );

  test('a package.json link to a regular file inside a submodule is read', () => {
    const run = cli(['hash', '-C', withSubmodule('real.json')], 10_000);
    finished(run);
    assert.ok(run.keys.includes('vendor/lib/y.ts#y'), run.keys.join('\n'));
  });
});

describe('tsconfig and glob checks stay inside the repository', () => {
  // With verbatimModuleSyntax, `import { type T }` runs src/side.ts; without it, nothing runs.
  const extendsApp = (base: (dir: string) => string) => {
    const dir = app({
      ...project,
      'src/index.ts': "import { type T } from './side';\nexport const x: T | 1 = 1;\n",
      'src/side.ts': "console.log('side effect');\nexport type T = number;\n",
    });
    write(dir, 'tsconfig.json', JSON.stringify({ extends: base(dir) }));
    return dir;
  };

  test(
    'a tsconfig that extends a file outside the repository leaves the graph alone',
    () => {
      const outside = tempDir('outside');
      write(outside, 'base.json', JSON.stringify({ compilerOptions: { verbatimModuleSyntax: true } }));
      const graph = analyze({ cwd: extendsApp(dir => relative(dir, join(outside, 'base.json'))) });
      assert.equal(graph.isLive('src/side.ts#<module>'), false);
    }
  );

  test('a tsconfig that extends a file inside the repository changes the graph', () => {
    const dir = extendsApp(() => './base.json');
    write(dir, 'base.json', JSON.stringify({ compilerOptions: { verbatimModuleSyntax: true } }));
    assert.equal(analyze({ cwd: dir }).isLive('src/side.ts#<module>'), true);
  });

  const linkedGlob = (target: (dir: string) => string) => {
    const dir = app({ ...project, 'src/index.ts': "export const all = import.meta.glob('./cfg/*.ts');\n", 'shared/a.ts': 'export const a = 1;\n' });
    symlinkSync(target(dir), join(dir, 'src/cfg'));
    return dir;
  };

  test(
    'import.meta.glob into a link to a directory outside the repository warns',
    () => {
      const outside = tempDir('outside');
      write(outside, 'secret.ts', 'export const s = 1;\n');
      const graph = analyze({ cwd: linkedGlob(() => outside) });
      assert.ok(![...graph.live.keys()].some(k => k.includes('secret')));
      assert.ok(graph.warnings.some(w => w.includes('points outside the repository')), graph.warnings.join('\n'));
    }
  );

  test('import.meta.glob into a link to a directory inside the repository reads it without a warning', () => {
    const graph = analyze({ cwd: linkedGlob(() => '../shared') });
    assert.ok(graph.live.has('src/cfg/a.ts#a'), [...graph.live.keys()].join('\n'));
    assert.deepEqual(graph.warnings, []);
  });
});
