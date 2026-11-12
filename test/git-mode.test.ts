import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, realpathSync, renameSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { describe, test } from 'node:test';
import { affected, affectedSinceManifest, analyze, createManifest, loadProject, readManifest, type AffectedResult } from '../src/index.ts';
import { app, edit, fixture, git, pkg, write } from './helpers.ts';

const CLI = join(import.meta.dirname, '../src/cli.ts');

const run = (args: string[]) => {
  const result = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env: { ...process.env, GITHUB_OUTPUT: '' } });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
};

const configure = (dir: string) => {
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'user.name', 'test');
  git(dir, 'config', 'commit.gpgsign', 'false');
};

/** Commits what git does not ignore. `initRepo` force-adds, which would track ignored files. */
const commit = (dir: string, message = 'base') => {
  if (!existsSync(join(dir, '.git'))) {
    git(dir, 'init', '-q', '-b', 'main');
    configure(dir);
  }
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', message);
  return dir;
};

/** Moves a file or link out of the project. The tests never delete anything. */
const remove = (dir: string, path: string) => {
  renameSync(join(dir, path), join(mkdtempSync(join(tmpdir(), 'byakugan-moved-')), basename(path)));
};

const since = (cwd: string, base = 'main') => affected({ cwd, base });
const reasons = (result: AffectedResult) => result.reasons.map(r => [r.kind, r.key]);

/** src/main.ts runs and calls greet() from src/greet.ts. */
const web = (files: Record<string, string | object> = {}) =>
  app({
    'package.json': { name: 'web', type: 'module' },
    'byakugan.json': { entry: ['src/main.ts'] },
    'src/main.ts': "import { greet } from './greet';\n\nconsole.log(greet());\n",
    'src/greet.ts': "export const greet = () => 'hi';\n",
    ...files,
  });

/** The monorepo fixture with @acme/ui linked (or copied) into an untracked node_modules. */
const monorepo = (options: { copy?: boolean } = {}) => {
  const dir = fixture('monorepo');
  mkdirSync(join(dir, 'node_modules/@acme'), { recursive: true });
  if (options.copy) cpSync(join(dir, 'packages/ui'), join(dir, 'node_modules/@acme/ui'), { recursive: true });
  else symlinkSync('../../packages/ui', join(dir, 'node_modules/@acme/ui'));
  write(dir, '.gitignore', 'node_modules/\n');
  commit(dir);
  return { dir, web: join(dir, 'apps/web') };
};

const caseInsensitive = (() => {
  const dir = mkdtempSync(join(tmpdir(), 'byakugan-case-'));
  write(dir, 'a.txt', '');
  return existsSync(join(dir, 'A.txt'));
})();

describe('git mode: files git ignores', () => {
  /** src/gen/ is ignored, and main.ts imports src/gen/label.ts. */
  const generated = (config: object = {}) =>
    commit(
      web({
        '.gitignore': 'src/gen/\n',
        'byakugan.json': { entry: ['src/main.ts'], ...config },
        'src/main.ts': "import { label } from './gen/label';\n\nconsole.log(label);\n",
        'src/gen/label.ts': "export const label = 'a';\n",
      })
    );

  test('an ignored file the app imports is affected', () => {
    const result = since(generated());
    assert.deepEqual(reasons(result), [['source', 'src/gen/label.ts']]);
    assert.match(result.reasons[0].detail, /ignored by git/);
  });

  test('an ignored file nobody imports is not affected', () => {
    const dir = commit(web({ '.gitignore': 'src/gen/\n', 'src/gen/label.ts': "export const label = 'a';\n" }));
    assert.equal(since(dir).affected, false);
  });

  test('a tracked file that matches .gitignore is compared like any other', () => {
    const dir = generated();
    git(dir, 'add', '-f', 'src/gen/label.ts');
    commit(dir, 'track it');
    assert.equal(since(dir).affected, false);
    edit(dir, 'src/gen/label.ts', s => s.replace("'a'", "'b'"));
    assert.deepEqual(reasons(since(dir)), [['source', 'src/gen/label.ts#label']]);
  });

  test('an ignored file matched by "generated" is not affected', () => {
    assert.equal(since(generated({ generated: ['src/gen/**'] })).affected, false);
  });

  test('"generated" excuses only the files it matches', () => {
    assert.deepEqual(reasons(since(generated({ generated: ['src/other/**'] }))), [['source', 'src/gen/label.ts']]);
  });

  /** packages/ui/src/gen/ is ignored, and cx.ts imports gen/tone.ts from it. */
  const generatedInPackage = (pattern: string) => {
    const { dir, web } = monorepo();
    write(dir, '.gitignore', 'node_modules/\npackages/ui/src/gen/\n');
    write(dir, 'packages/ui/src/gen/tone.ts', "export const tone = 'blue';\n");
    edit(dir, 'packages/ui/src/cx.ts', s => `import { tone } from './gen/tone';\n${s.replace('filter(Boolean)', 'concat(tone).filter(Boolean)')}`);
    write(dir, 'apps/web/byakugan.json', `{ "generated": ["${pattern}"] }\n`);
    commit(dir, 'generated tone');
    return web;
  };

  test('"generated" can excuse an ignored file in a workspace package', () => {
    assert.equal(since(generatedInPackage('../../packages/ui/src/gen/**')).affected, false);
  });

  test('a "generated" pattern outside the app excuses only the files it matches', () => {
    assert.deepEqual(reasons(since(generatedInPackage('../../packages/ui/src/other/**'))), [['source', 'packages/ui/src/gen/tone.ts']]);
  });

  test('an ignored file the app imports still counts when the app also reads a submodule', () => {
    const lib = commit(app({ 'label.ts': "export const label = 'v1';\n" }));
    const dir = commit(
      web({
        '.gitignore': 'src/gen/\n',
        'src/main.ts': "import { label } from '../vendor/lib/label';\nimport { text } from './gen/text';\n\nconsole.log(label, text);\n",
        'src/gen/text.ts': "export const text = 'a';\n",
      })
    );
    git(dir, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', lib, 'vendor/lib');
    commit(dir, 'submodule');
    assert.deepEqual(reasons(since(dir)), [['source', 'src/gen/text.ts']]);
  });

  /** config/ is ignored, and byakugan.json lists config/*.json as inputs. */
  const ignoredInput = (config: object = {}) =>
    commit(
      web({ '.gitignore': 'config/\n', 'byakugan.json': { entry: ['src/main.ts'], inputs: ['config/*.json'], ...config }, 'config/flags.json': '{}\n' })
    );

  test('an ignored input is affected', () => {
    const result = since(ignoredInput());
    assert.deepEqual(reasons(result), [['input', 'config/flags.json']]);
    assert.match(result.reasons[0].detail, /ignored by git/);
  });

  test('an ignored .DS_Store next to the inputs is not an input', () => {
    const dir = commit(web({ '.gitignore': '.DS_Store\n', 'byakugan.json': { entry: ['src/main.ts'], inputs: ['config/**'] }, 'config/flags.json': '{}\n' }));
    const before = analyze({ cwd: dir }).fingerprint();
    write(dir, 'config/.DS_Store', 'Bud1');
    assert.equal(since(dir).affected, false);
    assert.equal(analyze({ cwd: dir }).fingerprint(), before);
  });

  test('an ignored .env file is a warning, not a reason', () => {
    const dir = commit(web({ '.gitignore': '.env*\n' }));
    write(dir, '.env.local', 'SECRET=1\n');
    const result = since(dir);
    assert.equal(result.affected, false);
    assert.ok(result.warnings.some(w => w.startsWith('.env.local: ignored by git')), result.warnings.join('\n'));
  });

  test('an ignored input under "generated" is not affected', () => {
    assert.equal(since(ignoredInput({ generated: ['config/**'] })).affected, false);
  });

  /** real/a.ts, reached as linked/a.ts through a symlinked directory or as real/a.ts. */
  const linkedDir = (entry: string) => {
    const dir = web({ 'byakugan.json': { entry: [entry] }, 'real/a.ts': 'export const a = 1;\n' });
    symlinkSync('real', join(dir, 'linked'));
    return commit(dir);
  };

  // git check-ignore refuses a path beyond a symbolic link, so git mode asks with the real path.
  test('a file reached through a symlinked directory is checked by its real path', () => {
    assert.equal(since(linkedDir('linked/*.ts')).affected, false);
  });

  test('an edit behind a symlinked directory an entry glob follows is affected', () => {
    const dir = linkedDir('linked/*.ts');
    edit(dir, 'real/a.ts', s => s.replace('1', '2'));
    assert.deepEqual(reasons(since(dir)), [['source', 'linked/a.ts#a']]);
  });

  test('the same file reached by its real path gives git nothing to refuse', () => {
    assert.equal(since(linkedDir('real/*.ts')).affected, false);
  });

  test('a change behind a symlinked directory an entry glob follows is not listed as unused', () => {
    const dir = linkedDir('linked/*.ts');
    edit(dir, 'real/a.ts', s => s.replace('1', '2'));
    assert.deepEqual(since(dir).ignored.map(i => i.path), []);
  });
});

describe('git mode: deleted files the app still refers to', () => {
  /** tsconfig baseUrl is the project, and main.ts imports `lib/greet` as a bare specifier. */
  const baseUrl = () =>
    commit(
      web({
        'tsconfig.json': { compilerOptions: { baseUrl: '.' } },
        'src/main.ts': "import { greet } from 'lib/greet';\n\nconsole.log(greet());\n",
        'lib/greet.ts': "export const greet = () => 'hi';\n",
        'lib/other.ts': 'export const other = 1;\n',
      })
    );

  test('deleting a file a baseUrl import names is affected', () => {
    const dir = baseUrl();
    remove(dir, 'lib/greet.ts');
    assert.deepEqual(reasons(since(dir)), [['unresolved', 'src/main.ts -> lib/greet']]);
  });

  test('deleting a file next to it that nothing imports is not affected', () => {
    const dir = baseUrl();
    remove(dir, 'lib/other.ts');
    assert.equal(since(dir).affected, false);
  });

  test('an import of a declared package that is not installed is not a project import', () => {
    const dir = commit(
      web({
        'package.json': { name: 'web', type: 'module', dependencies: { 'left-pad': '1.3.0' } },
        'src/main.ts': "import pad from 'left-pad';\n\nconsole.log(pad);\n",
      })
    );
    const result = since(dir);
    assert.equal(result.affected, false);
    assert.deepEqual(result.warnings, []);
  });

  // No package.json declares it and nothing is installed: most likely a bundler alias byakugan does not read.
  test('an import of an undeclared name that does not resolve is affected', () => {
    const dir = commit(web({ 'src/main.ts': "import pad from 'left-pad';\n\nconsole.log(pad);\n" }));
    assert.deepEqual(reasons(since(dir)), [['unresolved', 'src/main.ts -> left-pad']]);
  });

  test('an undeclared name listed under "virtual" is not affected', () => {
    const dir = commit(
      web({ 'byakugan.json': { entry: ['src/main.ts'], virtual: ['left-*'] }, 'src/main.ts': "import pad from 'left-pad';\n\nconsole.log(pad);\n" })
    );
    const result = since(dir);
    assert.equal(result.affected, false);
    assert.deepEqual(result.warnings, []);
  });

  test('deleting the last file of a baseUrl directory is affected', () => {
    const dir = baseUrl();
    remove(dir, 'lib/greet.ts');
    remove(dir, 'lib/other.ts');
    remove(dir, 'lib');
    assert.equal(since(dir).affected, true);
  });

  test('deleting the target of a tsconfig paths alias shaped like a scoped package is affected', () => {
    const dir = commit(
      web({
        'tsconfig.json': { compilerOptions: { paths: { '@components/*': ['./src/components/*'] } } },
        'src/main.ts': "import { Hero } from '@components/Hero';\n\nconsole.log(Hero);\n",
        'src/components/Hero.ts': 'export const Hero = 1;\n',
        'src/components/Other.ts': 'export const Other = 1;\n',
      })
    );
    remove(dir, 'src/components/Hero.ts');
    assert.equal(since(dir).affected, true);
  });

  test('deleting the file a workspace package exports is affected', () => {
    const { dir, web } = monorepo();
    remove(dir, 'packages/ui/src/index.ts');
    assert.deepEqual(reasons(since(web)), [['unresolved', 'apps/web/app/page.tsx -> @acme/ui']]);
  });

  test('deleting a workspace file nothing reaches is not affected', () => {
    const { dir, web } = monorepo();
    write(dir, 'packages/ui/src/Legacy.tsx', 'export const Legacy = () => null;\n');
    commit(dir, 'legacy');
    remove(dir, 'packages/ui/src/Legacy.tsx');
    const result = since(web);
    assert.equal(result.affected, false);
    assert.deepEqual(result.ignored.map(i => i.path), ['packages/ui/src/Legacy.tsx']);
  });

  test('deleting a whole workspace package the app imports is affected', () => {
    const { dir, web } = monorepo();
    remove(dir, 'packages/ui');
    assert.equal(since(web).affected, true);
  });

  /** main.ts imports style.css, which loads bg.png with url(). */
  const styled = () =>
    commit(
      web({
        'src/main.ts': "import './style.css';\n",
        'src/style.css': 'body { background: url("./bg.png"); }\n',
        'src/bg.png': 'png',
        'src/unused.png': 'png',
      })
    );

  test('deleting an image a stylesheet loads with url() is affected', () => {
    const dir = styled();
    remove(dir, 'src/bg.png');
    const result = since(dir);
    assert.deepEqual(reasons(result), [['source', 'src/bg.png']]);
    assert.equal(result.reasons[0].detail, 'deleted (the code refers to this path)');
  });

  test('deleting an image no stylesheet loads is not affected', () => {
    const dir = styled();
    remove(dir, 'src/unused.png');
    assert.equal(since(dir).affected, false);
  });

  /** main.ts reads data.txt through new URL(..., import.meta.url). */
  const located = () =>
    commit(
      web({
        'src/main.ts': "const data = new URL('./data.txt', import.meta.url);\n\nconsole.log(data);\n",
        'src/data.txt': 'a',
        'src/other.txt': 'b',
      })
    );

  test('deleting a file the code names by path is affected', () => {
    const dir = located();
    remove(dir, 'src/data.txt');
    assert.deepEqual(reasons(since(dir)), [['source', 'src/data.txt']]);
  });

  test('deleting a file the code does not name is not affected', () => {
    const dir = located();
    remove(dir, 'src/other.txt');
    assert.equal(since(dir).affected, false);
  });

  /** `./util` resolves to util.ts, and util/index.ts would answer it too. Nothing imports `./helper`. */
  const shadowed = () =>
    commit(
      web({
        'src/main.ts': "import { greet } from './util';\n\nconsole.log(greet());\n",
        'src/util.ts': "export const greet = () => 'file';\n",
        'src/util/index.ts': "export const greet = () => 'dir';\n",
        'src/helper.ts': 'export const help = 1;\n',
        'src/helper/index.ts': 'export const help = 2;\n',
      })
    );

  test('deleting util.ts so that ./util resolves to util/index.ts is affected', () => {
    const dir = shadowed();
    remove(dir, 'src/util.ts');
    const result = since(dir);
    assert.deepEqual(reasons(result), [['source', 'src/util.ts']]);
    assert.match(result.reasons[0].detail, /now resolves to another file/);
  });

  test('deleting helper.ts when nothing imports ./helper is not affected', () => {
    const dir = shadowed();
    remove(dir, 'src/helper.ts');
    assert.equal(since(dir).affected, false);
  });
});

describe('byakugan.json', () => {
  test('a byakugan.json that is not valid JSON throws', () => {
    const dir = web({ 'byakugan.json': '{ "entry": ["src/main.ts"]\n' });
    assert.throws(() => loadProject({ cwd: dir }), /byakugan\.json is not valid JSON/);
    const { code, stderr } = run(['hash', '-C', dir]);
    assert.equal(code, 2);
    assert.match(stderr, /byakugan\.json is not valid JSON/);
  });

  test('comments and trailing commas are fine', () => {
    const dir = web({
      'byakugan.json': '{\n  // the app\n  "entry": ["src/main.ts"],\n  "inputs": ["messages/*.json",],\n}\n',
      'messages/en.json': '{}\n',
    });
    assert.ok(loadProject({ cwd: dir }).inputs.includes(join(dir, 'messages/en.json')));
  });

  test('a byakugan.json with a string where a list belongs throws', () => {
    const dir = web({ 'byakugan.json': { entry: ['src/main.ts'], inputs: 'en.json' } });
    assert.throws(() => loadProject({ cwd: dir }), /"inputs" must be a list of strings/);
  });

  for (const [config, message] of [
    ['null', /byakugan\.json must hold a JSON object/],
    ['[1]', /byakugan\.json must hold a JSON object/],
    ['{ "entry": "src/main.ts" }', /"entry" must be a list of strings/],
    ['{ "inputs": [""] }', /"inputs" must be a list of strings/],
    ['{ "generated": [5] }', /"generated" must be a list of strings/],
    ['{ "virtual": "virtual:*" }', /"virtual" must be a list of strings/],
    ['{ "entry": ["/src/**"] }', /"entry" holds "\/src\/\*\*"; patterns are relative to the project directory/],
    ['{ "inputs": ["!/tmp/**"] }', /"inputs" holds "!\/tmp\/\*\*"/],
    ['{ "framework": "gatsby" }', /"framework" must be one of next, vite, react-router, nuxt, sveltekit, astro, react-native, none/],
    ['{ "jsxImportSource": 5 }', /"jsxImportSource" must be a string/],
    ['{ "modularizeImports": [] }', /"modularizeImports" must be an object/],
    ['{ "tailwind": "no" }', /"tailwind" must be true or false/],
    ['{ "postcssFromStylesheet": 1 }', /"postcssFromStylesheet" must be true or false/],
    ['{ "tailwindDir": "/etc" }', /"tailwindDir" must be a directory relative to the project/],
    ['{ "tailwindDir": "../../../.." }', /"tailwindDir" names \.\.\/\.\.\/\.\.\/\.\., which is not a directory inside the repository/],
    ['{ "tailwindDir": "missing" }', /"tailwindDir" names missing, which is not a directory inside the repository/],
  ] as const) {
    test(`byakugan.json ${config} is rejected`, () => {
      assert.throws(() => loadProject({ cwd: web({ 'byakugan.json': config }) }), message);
    });
  }

  test('a byakugan.json with every field set loads, ../ patterns included', () => {
    const dir = web({
      'byakugan.json': {
        entry: ['src/main.ts'],
        inputs: ['messages/*.json', '../shared/*.json'],
        packages: ['sharp'],
        conditions: ['source'],
        generated: ['../shared/gen/**'],
        virtual: ['virtual:*'],
        framework: 'none',
        jsxImportSource: 'preact',
        modularizeImports: {},
      },
      'messages/en.json': '{}\n',
    });
    const project = loadProject({ cwd: dir });
    assert.equal(project.jsxImportSource, 'preact');
    assert.ok(project.inputs.includes(join(dir, 'messages/en.json')));
  });

  test('the CLI exits 2 on a malformed field', () => {
    const { code, stderr } = run(['affected', '-C', commit(web({ 'byakugan.json': '{ "entry": "src/main.ts" }' })), '--base', 'main']);
    assert.equal(code, 2);
    assert.match(stderr, /"entry" must be a list of strings/);
  });
});

describe('git mode: unresolved imports', () => {
  test('an unresolved import only types ask for warns but is not affected', () => {
    const dir = commit(web({ 'src/main.ts': "import type { Route } from './+types/home';\n\nexport const props: Route = {};\n" }));
    const result = since(dir);
    assert.equal(result.affected, false);
    assert.match(result.warnings.join('\n'), /src\/main\.ts: cannot resolve "\.\/\+types\/home"/);
  });

  test('an unresolved import of a value is affected', () => {
    const dir = commit(web({ 'src/main.ts': "import { helper } from './missing';\n\nconsole.log(helper);\n" }));
    assert.deepEqual(reasons(since(dir)), [['unresolved', 'src/main.ts -> ./missing']]);
  });

  test('an undeclared server-only import in a Next.js app is not affected', () => {
    const { dir, web } = monorepo();
    edit(dir, 'apps/web/app/api/health/route.ts', s => `import 'server-only';\n${s}`);
    commit(dir, 'server-only');
    assert.equal(since(web).affected, false);
  });

  test("an import of Bun's runtime module is not affected", () => {
    const dir = commit(web({ 'src/main.ts': "import { serve } from 'bun';\n\nserve({});\n" }));
    assert.equal(since(dir).affected, false);
  });

  /** main.ts uses `a` from src/mid.ts, which also imports `x` from `from` for a function nothing calls. */
  const unusedImport = (from: string) =>
    commit(
      web({
        'src/main.ts': "import { a } from './mid';\n\nconsole.log(a);\n",
        'src/mid.ts': `import { x } from '${from}';\nexport const a = 1;\nexport const unused = () => x;\n`,
        'src/effect.ts': "console.log('effect');\nexport const x = 1;\n",
      })
    );

  // The runtime provides `bun` and `cloudflare:workers`, so the bundle never ran their code.
  test('removing an unused import of a runtime module is not affected', () => {
    for (const from of ['bun', 'cloudflare:workers']) {
      const dir = unusedImport(from);
      write(dir, 'src/mid.ts', 'export const a = 1;\n');
      assert.equal(since(dir).affected, false, from);
    }
  });

  test('removing an unused import of a project module with a side effect is affected', () => {
    const dir = unusedImport('./effect');
    write(dir, 'src/mid.ts', 'export const a = 1;\n');
    assert.equal(since(dir).affected, true);
  });
});

describe('git mode: warnings', () => {
  const computed = () => commit(web({ 'src/main.ts': "export const load = (name: string) => import(name);\n" }));

  test('affected returns what the graph could not follow', () => {
    const result = since(computed());
    assert.equal(result.affected, false);
    assert.deepEqual(result.warnings, ['src/main.ts: cannot follow an import with a computed specifier; list its targets in "entry" or "inputs"']);
  });

  test('a project the graph follows fully has no warnings', () => {
    assert.deepEqual(since(commit(web())).warnings, []);
  });

  test('manifest mode returns them too', () => {
    const graph = analyze({ cwd: computed() });
    assert.equal(affectedSinceManifest(graph, createManifest(graph)).warnings.length, 1);
  });

  test('the CLI prints them for affected and hash, and keeps stdout readable', () => {
    const dir = computed();
    const text = run(['affected', '-C', dir, '--base', 'main']);
    assert.match(text.stdout, /\nwarnings\n {2}src\/main\.ts: cannot follow an import/);
    const json = run(['affected', '-C', dir, '--base', 'main', '--json']);
    assert.equal(JSON.parse(json.stdout).warnings.length, 1);
    assert.equal(JSON.parse(run(['hash', '-C', dir, '--json']).stdout).warnings.length, 1);
    const hash = run(['hash', '-C', dir]);
    assert.match(hash.stdout, /^[0-9a-f]{64}\n$/);
    assert.match(hash.stderr, /^byakugan: warning: src\/main\.ts: cannot follow an import/);
    assert.equal(run(['hash', '-C', commit(web())]).stderr, '');
  });
});

describe('git mode: submodules', () => {
  /** vendor/lib is a submodule. Branch `bump` moves it to a new commit. */
  const vendored = (imported: boolean) => {
    const lib = commit(app({ 'label.ts': "export const label = 'v1';\n" }));
    const main = imported ? "import { label } from '../vendor/lib/label';\n\nconsole.log(label);\n" : "console.log('no vendor');\n";
    const dir = commit(web({ 'src/main.ts': main }));
    git(dir, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', lib, 'vendor/lib');
    commit(dir, 'submodule');
    git(dir, 'checkout', '-q', '-b', 'bump');
    const inner = join(dir, 'vendor/lib');
    configure(inner);
    write(inner, 'label.ts', "export const label = 'v2';\n");
    commit(inner, 'v2');
    commit(dir, 'bump');
    return dir;
  };

  test('a submodule bump is affected when the app reads a file inside it', () => {
    const result = since(vendored(true));
    assert.deepEqual(result.reasons.map(r => [r.key, r.detail]), [['vendor/lib', 'submodule changed']]);
  });

  test('a submodule bump is not affected when the app reads nothing inside it', () => {
    const result = since(vendored(false));
    assert.equal(result.affected, false);
    assert.deepEqual(result.ignored.map(i => i.path), ['vendor/lib']);
  });

  test('a submodule bump counts with ignore = all in .gitmodules', () => {
    const dir = vendored(true);
    git(dir, 'config', '-f', '.gitmodules', 'submodule.vendor/lib.ignore', 'all');
    commit(dir, 'ignore all');
    assert.equal(since(dir).affected, true);
  });
});

describe('git mode: symlinks', () => {
  /** src/theme.ts links to themes/dark.ts and main.ts imports it. src/old.ts links to a file nothing imports. */
  const linked = () => {
    const dir = web({
      'src/main.ts': "import { theme } from './theme';\n\nconsole.log(theme);\n",
      'src/themes/dark.ts': "export const theme = 'dark';\n",
      'src/themes/light.ts': "export const theme = 'light';\n",
      'src/themes/old.ts': "export const theme = 'old';\n",
      'src/themes/older.ts': "export const theme = 'older';\n",
    });
    symlinkSync('themes/dark.ts', join(dir, 'src/theme.ts'));
    symlinkSync('themes/old.ts', join(dir, 'src/old.ts'));
    return commit(dir);
  };
  const retarget = (dir: string, link: string, target: string) => {
    remove(dir, link);
    symlinkSync(target, join(dir, link));
  };

  test('retargeting a symlink the app imports through is affected', () => {
    const dir = linked();
    retarget(dir, 'src/theme.ts', 'themes/light.ts');
    assert.deepEqual(since(dir).reasons.map(r => [r.key, r.detail]), [['src/theme.ts', 'symlink changed']]);
  });

  test('retargeting a symlink nothing imports through is not affected', () => {
    const dir = linked();
    retarget(dir, 'src/old.ts', 'themes/older.ts');
    assert.equal(since(dir).affected, false);
  });
});

// An entry or input glob that follows a symlink keys files by the link's path. Git reports
// changes under the target's path, and the link itself as one blob.

describe('git mode: entries and inputs behind a symlink', () => {
  /** linked -> real, and the entry glob linked/*.ts lists real/a.ts and real/b.ts. */
  const linkedDir = (entry = 'linked/*.ts') => {
    const dir = web({
      'byakugan.json': { entry: ['src/main.ts', entry] },
      'real/a.ts': "console.log('a');\n",
      'real/b.ts': "console.log('b');\n",
      'real/notes.md': 'notes\n',
      'real2/a.ts': "console.log('other a');\n",
    });
    symlinkSync('real', join(dir, 'linked'));
    return commit(dir);
  };

  test('deleting a file an entry glob lists through the link is affected', () => {
    const dir = linkedDir();
    remove(dir, 'real/b.ts');
    assert.equal(since(dir).affected, true);
  });

  test('deleting the directory the link points at is affected', () => {
    const dir = linkedDir();
    remove(dir, 'real');
    assert.equal(since(dir).affected, true);
  });

  test('deleting a file behind the link that no entry glob lists is not affected', () => {
    const dir = linkedDir();
    remove(dir, 'real/notes.md');
    assert.equal(since(dir).affected, false);
  });

  test('retargeting the link an entry glob follows is affected', () => {
    const dir = linkedDir();
    remove(dir, 'linked');
    symlinkSync('real2', join(dir, 'linked'));
    assert.equal(since(dir).affected, true);
  });

  test('removing the link an entry glob follows is affected', () => {
    const dir = linkedDir();
    remove(dir, 'linked');
    assert.equal(since(dir).affected, true);
  });

  test('adding a link an entry glob follows is affected', () => {
    const dir = linkedDir('linked*/*.ts');
    symlinkSync('real2', join(dir, 'linked2'));
    assert.equal(since(dir).affected, true);
  });

  test('adding, retargeting and removing a link no glob lists is not affected', () => {
    const dir = linkedDir();
    symlinkSync('real2', join(dir, 'spare'));
    assert.equal(since(dir).affected, false, 'added');
    commit(dir, 'spare link');
    remove(dir, 'spare');
    symlinkSync('real', join(dir, 'spare'));
    assert.equal(since(dir).affected, false, 'retargeted');
    remove(dir, 'spare');
    assert.equal(since(dir).affected, false, 'removed');
  });

  /** entries/page.ts links to lib/page.ts, and the entry glob is entries/*.ts. */
  const fileLink = () => {
    const dir = web({ 'byakugan.json': { entry: ['entries/*.ts'] }, 'lib/page.ts': "console.log('page');\n", 'lib/spare.ts': "console.log('spare');\n" });
    mkdirSync(join(dir, 'entries'));
    symlinkSync('../lib/page.ts', join(dir, 'entries/page.ts'));
    return commit(dir);
  };

  test('editing the target of a file symlink an entry glob lists is affected', () => {
    const dir = fileLink();
    edit(dir, 'lib/page.ts', s => s.replace("'page'", "'Page'"));
    assert.equal(since(dir).affected, true);
  });

  test('editing a file next to that target is not affected', () => {
    const dir = fileLink();
    edit(dir, 'lib/spare.ts', s => s.replace("'spare'", "'Spare'"));
    assert.equal(since(dir).affected, false);
  });

  /** public/logo.svg links to assets/logo.svg, and public/** is an input. */
  const inputLink = () => {
    const dir = web({ 'byakugan.json': { entry: ['src/main.ts'], inputs: ['public/**'] }, 'assets/logo.svg': '<svg>1</svg>\n', 'assets/spare.svg': '<svg>1</svg>\n' });
    mkdirSync(join(dir, 'public'));
    symlinkSync('../assets/logo.svg', join(dir, 'public/logo.svg'));
    return commit(dir);
  };

  test('editing the target of a symlinked input is affected', () => {
    const dir = inputLink();
    edit(dir, 'assets/logo.svg', s => s.replace('1', '2'));
    assert.equal(since(dir).affected, true);
  });

  test('editing a file next to the target of a symlinked input is not affected', () => {
    const dir = inputLink();
    edit(dir, 'assets/spare.svg', s => s.replace('1', '2'));
    assert.equal(since(dir).affected, false);
  });

  // The link is ignored and untracked, so CI has no such entry. The coarse side is
  // 'a file reached through a symlinked directory is checked by its real path'.
  test('an entry behind a git-ignored symlink is affected', () => {
    const dir = commit(web({ '.gitignore': 'linked\n', 'byakugan.json': { entry: ['src/main.ts', 'linked/*.ts'] }, 'real/a.ts': "console.log('a');\n" }));
    symlinkSync('real', join(dir, 'linked'));
    assert.equal(since(dir).affected, true);
  });
});

describe('git mode: workspace packages installed as copies', () => {
  const both = (dir: string, path: string, change: (s: string) => string) => {
    for (const root of ['packages/ui', 'node_modules/@acme/ui']) edit(dir, `${root}/${path}`, change);
  };

  test('a change to a used component maps to the node_modules copy', () => {
    const { dir, web } = monorepo({ copy: true });
    both(dir, 'src/Button.tsx', s => s.replace("cx('btn')", "cx('btn', 'primary')"));
    assert.deepEqual(reasons(since(web)), [['source', 'npm:@acme/ui/src/Button.tsx#Button']]);
  });

  test('a change to an unused component is not affected', () => {
    const { dir, web } = monorepo({ copy: true });
    both(dir, 'src/Modal.tsx', s => s.replace("cx('modal')", "cx('modal', 'open')"));
    const result = since(web);
    assert.equal(result.affected, false);
    assert.deepEqual(result.ignored.map(i => i.path), ['packages/ui/src/Modal.tsx']);
  });
});

describe('git mode: JSX pragmas', () => {
  const prepend = (dir: string, text: string) => edit(dir, 'packages/ui/src/Button.tsx', s => `${text}\n${s}`);

  test('adding @jsxImportSource to a used component is affected', () => {
    const { dir, web } = monorepo();
    const before = analyze({ cwd: web }).fingerprint();
    prepend(dir, '/** @jsxImportSource @emotion/react */');
    assert.deepEqual(reasons(since(web)), [['source', 'packages/ui/src/Button.tsx#<module>']]);
    assert.notEqual(analyze({ cwd: web }).fingerprint(), before);
  });

  test('adding a plain comment to it is not affected', () => {
    const { dir, web } = monorepo();
    prepend(dir, '/** a button */');
    assert.equal(since(web).affected, false);
  });
});

describe('git mode: case-only renames', () => {
  const skip = !caseInsensitive && 'needs a case-insensitive file system';
  const cased = () =>
    commit(
      web({
        'src/main.ts': "import { hello } from './Hello';\n\nconsole.log(hello());\n",
        'src/Hello.ts': "export const hello = () => 'hi';\n",
        'src/Unused.ts': 'export const unused = 1;\n',
      })
    );

  test('renaming Hello.ts to hello.ts under an import of ./Hello is affected', { skip }, () => {
    const dir = cased();
    git(dir, 'mv', 'src/Hello.ts', 'src/hello.ts');
    const result = since(dir);
    assert.deepEqual(reasons(result), [['source', 'src/Hello.ts']]);
    assert.match(result.reasons[0].detail, /renamed by case only/);
  });

  test('renaming a file nothing imports by case only is not affected', { skip }, () => {
    const dir = cased();
    git(dir, 'mv', 'src/Unused.ts', 'src/unused.ts');
    assert.equal(since(dir).affected, false);
  });

  test('renaming a directory by case only is affected', { skip }, () => {
    const dir = commit(
      web({
        'src/main.ts': "import { greet } from './lib/greet';\n\nconsole.log(greet());\n",
        'src/lib/greet.ts': "export const greet = () => 'hi';\n",
      })
    );
    renameSync(join(dir, 'src/lib'), join(dir, 'src/tmp'));
    renameSync(join(dir, 'src/tmp'), join(dir, 'src/Lib'));
    git(dir, 'mv', 'src/lib/greet.ts', 'src/Lib/greet.ts');
    assert.equal(since(dir).affected, true);
  });
});

describe('git mode: lockfiles and patches', () => {
  /** main.ts uses lodash. left-pad is installed and locked, but nothing imports it. */
  const locked = (files: Record<string, string>) =>
    commit(
      web({
        '.gitignore': 'node_modules/\n',
        'src/main.ts': "import partition from 'lodash/partition';\n\nconsole.log(partition);\n",
        ...pkg('lodash', { version: '4.17.21' }, { 'partition.js': 'module.exports = function partition() {};\n' }),
        ...pkg('left-pad', { version: '1.3.0' }, { 'index.js': 'module.exports = 1;\n' }),
        ...files,
      })
    );

  /** Each case: a lockfile, then an edit that keeps versions but changes lodash or left-pad. */
  const npmLock = (lodash: string, leftPad: string) =>
    `${JSON.stringify(
      {
        name: 'web',
        lockfileVersion: 3,
        packages: {
          '': { name: 'web' },
          'node_modules/lodash': { version: '4.17.21', resolved: `git+ssh://git@github.com/lodash/lodash.git#${lodash}` },
          'node_modules/left-pad': { version: '1.3.0', resolved: 'https://registry.npmjs.org/left-pad/-/left-pad-1.3.0.tgz', integrity: `sha512-${leftPad}` },
        },
      },
      null,
      2
    )}\n`;

  const pnpm9 = (lodash: string, leftPad: string) => `lockfileVersion: '9.0'

patchedDependencies:
  lodash@4.17.21:
    hash: ${lodash}
    path: patches/lodash@4.17.21.patch
  left-pad@1.3.0:
    hash: ${leftPad}
    path: patches/left-pad@1.3.0.patch

importers:

  .:
    dependencies:
      left-pad:
        specifier: 1.3.0
        version: 1.3.0(patch_hash=${leftPad})
      lodash:
        specifier: 4.17.21
        version: 4.17.21(patch_hash=${lodash})

packages:

  left-pad@1.3.0:
    resolution: {integrity: sha512-b}

  lodash@4.17.21:
    resolution: {integrity: sha512-a}

snapshots:

  left-pad@1.3.0(patch_hash=${leftPad}): {}

  lodash@4.17.21(patch_hash=${lodash}): {}
`;

  const tarball = (lodash: string, leftPad: string) => `lockfileVersion: '9.0'

packages:

  left-pad@https://codeload.github.com/stevemao/left-pad/tar.gz/${leftPad}:
    resolution: {tarball: https://codeload.github.com/stevemao/left-pad/tar.gz/${leftPad}}
    version: 1.3.0

  lodash@https://codeload.github.com/lodash/lodash/tar.gz/${lodash}:
    resolution: {tarball: https://codeload.github.com/lodash/lodash/tar.gz/${lodash}}
    version: 4.17.21

snapshots:

  left-pad@https://codeload.github.com/stevemao/left-pad/tar.gz/${leftPad}: {}

  lodash@https://codeload.github.com/lodash/lodash/tar.gz/${lodash}: {}
`;

  const berry = (lodash: string, leftPad: string) => `__metadata:
  version: 8
  cacheKey: 10c0

"left-pad@patch:left-pad@npm%3A1.3.0#~/.yarn/patches/left-pad-npm-1.3.0-${leftPad}.patch":
  version: 1.3.0
  resolution: "left-pad@patch:left-pad@npm%3A1.3.0#~/.yarn/patches/left-pad-npm-1.3.0-${leftPad}.patch::version=1.3.0&hash=${leftPad}"
  checksum: 10c0/${leftPad}
  languageName: node
  linkType: hard

"lodash@patch:lodash@npm%3A4.17.21#~/.yarn/patches/lodash-npm-4.17.21-${lodash}.patch":
  version: 4.17.21
  resolution: "lodash@patch:lodash@npm%3A4.17.21#~/.yarn/patches/lodash-npm-4.17.21-${lodash}.patch::version=4.17.21&hash=${lodash}"
  checksum: 10c0/${lodash}
  languageName: node
  linkType: hard
`;

  const pnpm5 = (lodash: string, leftPad: string) => `lockfileVersion: 5.4

specifiers:
  left-pad: ${leftPad}
  lodash: ${lodash}

dependencies:
  left-pad: ${leftPad}
  lodash: ${lodash}

packages:

  /left-pad/${leftPad}:
    resolution: {integrity: sha512-b}
    dev: false

  /lodash/${lodash}:
    resolution: {integrity: sha512-a}
    dev: false
`;

  const cases = [
    { name: 'a package-lock git dependency moved to another commit', file: 'package-lock.json', lock: npmLock, from: ['1111', 'aaa'], used: ['2222', 'aaa'], unused: ['1111', 'bbb'] },
    { name: 'a pnpm v9 patch hash', file: 'pnpm-lock.yaml', lock: pnpm9, from: ['aaa', 'aaa'], used: ['bbb', 'aaa'], unused: ['aaa', 'bbb'] },
    { name: 'a pnpm tarball from another commit', file: 'pnpm-lock.yaml', lock: tarball, from: ['1111', '1111'], used: ['2222', '1111'], unused: ['1111', '2222'] },
    { name: 'a yarn berry patch hash', file: 'yarn.lock', lock: berry, from: ['111', '111'], used: ['222', '111'], unused: ['111', '222'] },
    { name: 'a version bump in a pnpm v5 lockfile', file: 'pnpm-lock.yaml', lock: pnpm5, from: ['4.17.21', '1.3.0'], used: ['4.17.22', '1.3.0'], unused: ['4.17.21', '1.3.1'] },
  ];

  for (const c of cases) {
    test(`${c.name} affects the app when the package is used`, () => {
      const dir = locked({ [c.file]: c.lock(c.from[0], c.from[1]) });
      write(dir, c.file, c.lock(c.used[0], c.used[1]));
      assert.deepEqual(reasons(since(dir)), [['dependency', 'lodash']]);
    });

    test(`${c.name} does not affect the app when the package is unused`, () => {
      const dir = locked({ [c.file]: c.lock(c.from[0], c.from[1]) });
      write(dir, c.file, c.lock(c.unused[0], c.unused[1]));
      const result = since(dir);
      assert.equal(result.affected, false);
      assert.deepEqual(result.ignored.map(i => i.path), [c.file]);
    });
  }

  test('a lockfile git mode cannot read is affected', () => {
    const dir = locked({ 'pnpm-lock.yaml': 'lockfileVersion: 99\nlayout: new\n' });
    write(dir, 'pnpm-lock.yaml', 'lockfileVersion: 99\nlayout: newer\n');
    assert.deepEqual(since(dir).reasons.map(r => r.detail), ['lockfile changed and could not be parsed']);
  });

  /** Patch files with the lockfile untouched: patch-package names, then pnpm names. */
  for (const [tool, used, unused] of [
    ['patch-package', 'patches/lodash+4.17.21.patch', 'patches/left-pad+1.3.0.patch'],
    ['pnpm', 'patches/lodash@4.17.21.patch', 'patches/left-pad@1.3.0.patch'],
  ]) {
    const patched = () => locked({ 'package-lock.json': npmLock('1111', 'aaa'), [used]: '+// v1\n', [unused]: '+// v1\n' });

    test(`editing the ${tool} patch of a used package is affected`, () => {
      const dir = patched();
      write(dir, used, '+// v2\n');
      assert.deepEqual(reasons(since(dir)), [['dependency', 'lodash']]);
    });

    test(`editing the ${tool} patch of an unused package is not affected`, () => {
      const dir = patched();
      write(dir, unused, '+// v2\n');
      assert.equal(since(dir).affected, false);
    });
  }
});

describe('git mode: build settings outside the app directory', () => {
  /** apps/web extends @acme/tsconfig/nextjs.json, a workspace package. base.json is not extended. */
  const extended = () => {
    const { dir, web } = monorepo();
    write(dir, 'packages/tsconfig/package.json', '{ "name": "@acme/tsconfig", "version": "0.0.0" }\n');
    write(dir, 'packages/tsconfig/nextjs.json', '{ "compilerOptions": { "strict": true } }\n');
    write(dir, 'packages/tsconfig/base.json', '{ "compilerOptions": { "strict": true } }\n');
    symlinkSync('../../packages/tsconfig', join(dir, 'node_modules/@acme/tsconfig'));
    edit(dir, 'apps/web/tsconfig.json', s => s.replace('{', '{\n  "extends": "@acme/tsconfig/nextjs.json",'));
    commit(dir, 'tsconfig package');
    return { dir, web };
  };

  test('editing a tsconfig the app extends through a package is affected', () => {
    const { dir, web } = extended();
    edit(dir, 'packages/tsconfig/nextjs.json', s => s.replace('true', 'false'));
    assert.deepEqual(reasons(since(web)), [['input', 'packages/tsconfig/nextjs.json']]);
  });

  test('editing a tsconfig in that package the app does not extend is not affected', () => {
    const { dir, web } = extended();
    edit(dir, 'packages/tsconfig/base.json', s => s.replace('true', 'false'));
    assert.equal(since(web).affected, false);
  });

  /** PostCSS configs at the root, in apps/web as JSON, and in a sibling app. */
  const postcss = () => {
    const { dir, web } = monorepo();
    write(dir, 'postcss.config.mjs', 'export default { plugins: {} };\n');
    write(dir, 'apps/web/postcss.config.json', '{ "plugins": {} }\n');
    write(dir, 'apps/docs/postcss.config.mjs', 'export default { plugins: {} };\n');
    commit(dir, 'postcss');
    return { dir, web };
  };

  test('editing a PostCSS config in a parent directory or as JSON is affected', () => {
    const { dir, web } = postcss();
    edit(dir, 'postcss.config.mjs', s => s.replace('{}', '{ autoprefixer: {} }'));
    edit(dir, 'apps/web/postcss.config.json', s => s.replace('{}', '{ "autoprefixer": {} }'));
    assert.deepEqual(reasons(since(web)).sort(), [
      ['input', 'apps/web/postcss.config.json'],
      ['input', 'postcss.config.mjs'],
    ]);
  });

  test('editing the PostCSS config of a sibling app is not affected', () => {
    const { dir, web } = postcss();
    edit(dir, 'apps/docs/postcss.config.mjs', s => s.replace('{}', '{ autoprefixer: {} }'));
    assert.equal(since(web).affected, false);
  });
});

describe('git mode: package.json of workspace packages', () => {
  /** packages/ui/src/alt.ts could be the export target. packages/unused is a workspace package the app never imports. */
  const workspace = () => {
    const { dir, web } = monorepo();
    write(dir, 'packages/ui/src/alt.ts', "export * from './Button';\n");
    write(dir, 'packages/unused/package.json', '{ "name": "@acme/unused", "version": "0.0.0", "exports": { ".": "./index.ts" } }\n');
    write(dir, 'packages/unused/index.ts', 'export const unused = 1;\n');
    commit(dir, 'more packages');
    return { dir, web };
  };

  test('repointing exports to another existing file is affected', () => {
    const { dir, web } = workspace();
    edit(dir, 'packages/ui/package.json', s => s.replace('./src/index.ts', './src/alt.ts'));
    assert.deepEqual(reasons(since(web)), [['input', 'packages/ui/package.json']]);
  });

  test('adding "sideEffects": false is affected', () => {
    const { dir, web } = workspace();
    edit(dir, 'packages/ui/package.json', s => s.replace('"private": true,', '"private": true,\n  "sideEffects": false,'));
    assert.deepEqual(reasons(since(web)), [['input', 'packages/ui/package.json']]);
  });

  test('a new exports key no import names is not affected, and the fingerprint stays', () => {
    const { dir, web } = workspace();
    const before = analyze({ cwd: web }).fingerprint();
    edit(dir, 'packages/ui/package.json', s => s.replace('".": "./src/index.ts"', '".": "./src/index.ts", "./alt": "./src/alt.ts"'));
    assert.equal(since(web).affected, false);
    assert.equal(analyze({ cwd: web }).fingerprint(), before);
  });

  test('a new exports key with a star is affected, since it can match any import', () => {
    const { dir, web } = workspace();
    edit(dir, 'packages/ui/package.json', s => s.replace('".": "./src/index.ts"', '".": "./src/index.ts", "./*": "./src/*.ts"'));
    assert.deepEqual(reasons(since(web)), [['input', 'packages/ui/package.json']]);
  });

  test('a script of a workspace package the app imports is not affected', () => {
    const { dir, web } = workspace();
    edit(dir, 'packages/ui/package.json', s => s.replace('"private": true,', '"private": true,\n  "scripts": { "lint": "eslint ." },'));
    assert.equal(since(web).affected, false);
  });

  test("a script of the app's own package.json still is", () => {
    const { dir, web } = workspace();
    edit(dir, 'apps/web/package.json', s => s.replace(/\{/, '{\n  "scripts": { "prebuild": "node gen.js" },'));
    assert.deepEqual(reasons(since(web)), [['input', 'apps/web/package.json']]);
  });

  test('editing the package.json of a workspace package the app does not import is not affected', () => {
    const { dir, web } = workspace();
    edit(dir, 'packages/unused/package.json', s => s.replace('./index.ts', './other.ts'));
    assert.equal(since(web).affected, false);
  });
});

describe('git mode: refs and history', () => {
  test('a base that starts with a dash is not a ref', () => {
    const dir = commit(web());
    assert.throws(() => since(dir, '--output=/tmp/x'), /"--output=\/tmp\/x" is not a git ref/);
    const { code, stderr } = run(['affected', '-C', dir, '--base=--independent']);
    assert.equal(code, 2);
    assert.match(stderr, /is not a git ref/);
    assert.equal(since(dir, 'main').affected, false);
  });

  /** main changes greet.ts after the branch point. feature edits a file nothing uses. */
  const diverged = () => {
    const origin = commit(web({ 'src/unused.ts': 'export const unused = 1;\n' }));
    git(origin, 'checkout', '-q', '-b', 'feature');
    edit(origin, 'src/unused.ts', s => s.replace('1', '2'));
    commit(origin, 'feature');
    git(origin, 'checkout', '-q', 'main');
    edit(origin, 'src/greet.ts', s => s.replace("'hi'", "'hello'"));
    commit(origin, 'main moves on');
    git(origin, 'checkout', '-q', 'feature');
    return origin;
  };

  test('with history, changes on the base branch itself do not count', () => {
    const result = since(diverged());
    assert.equal(result.affected, false);
    assert.deepEqual(result.warnings, []);
  });

  test('in a shallow clone without a merge base, the base tip is used and a warning says so', () => {
    const origin = diverged();
    const clone = join(realpathSync(mkdtempSync(join(tmpdir(), 'byakugan-shallow-'))), 'clone');
    git(origin, 'clone', '-q', '--depth', '1', '--branch', 'feature', `file://${origin}`, clone);
    git(clone, 'fetch', '-q', '--depth', '1', 'origin', 'main:main');
    const result = since(clone);
    assert.equal(result.base, git(origin, 'rev-parse', 'main').trim());
    assert.deepEqual(reasons(result), [['source', 'src/greet.ts#greet']]);
    assert.match(result.warnings.join('\n'), /main and HEAD have no merge base/);
  });
});

describe('manifests', () => {
  const file = (content: string) => {
    const dir = mkdtempSync(join(tmpdir(), 'byakugan-manifest-'));
    write(dir, 'm.json', content);
    return join(dir, 'm.json');
  };

  for (const [name, fragments] of [
    ['null', 'null'],
    ['an array', '["a"]'],
    ['a number value', '{ "a": 1 }'],
  ]) {
    test(`fragments that are ${name} are rejected`, () => {
      assert.throws(() => readManifest(file(`{ "version": 1, "fingerprint": "x", "fragments": ${fragments} }`)), /is not a byakugan manifest/);
    });
  }

  test('a manifest createManifest wrote reads back', () => {
    const graph = analyze({ cwd: web() });
    const manifest = readManifest(file(JSON.stringify(createManifest(graph))));
    assert.equal(affectedSinceManifest(graph, manifest).affected, false);
  });
});

describe('git invocation', () => {
  test('base contents come back for the right paths when many files with odd names change', () => {
    const odd = ['src/a b.ts', 'src/zażółć.ts', 'src/quote"s.ts', 'src/tab\tname.ts', 'src/new\nline.ts'];
    const files: Record<string, string> = {};
    const imports: string[] = [];
    odd.forEach((path, i) => {
      files[path] = `export const used${i} = ${i};\nexport const unused${i} = ${i};\n`;
      imports.push(`import { used${i} } from ${JSON.stringify(`./${path.slice(4, -3)}`)};`);
    });
    const dir = commit(
      web({ ...files, 'src/main.ts': `${imports.join('\n')}\n\nconsole.log(${odd.map((_, i) => `used${i}`).join(', ')});\n` })
    );
    // Even indexes change a used export, odd ones an unused one.
    odd.forEach((path, i) => edit(dir, path, s => s.replace(i % 2 === 0 ? `used${i} = ${i}` : `unused${i} = ${i}`, `$& + 1`)));
    const result = since(dir);
    assert.deepEqual(result.reasons.map(r => r.key).sort(), [`${odd[0]}#used0`, `${odd[2]}#used2`, `${odd[4]}#used4`].sort());
    assert.deepEqual(result.ignored.map(i => i.path).sort(), [odd[1], odd[3]].sort());
  });

  /** data/* are inputs. `name` changes from "one" to "two", and its neighbour data/a b already holds "two". */
  const carriageReturn = (name: string) => {
    const dir = commit(web({ 'byakugan.json': { entry: ['src/main.ts'], inputs: ['data/*'] }, [name]: 'one', 'data/a b': 'two' }));
    write(dir, name, 'two');
    return since(dir);
  };

  test('a file with a space and a CR inside its name reads its own base content', () => {
    assert.deepEqual(reasons(carriageReturn('data/a\r b')), [['input', 'data/a\r b']]);
  });

  test('a file whose name ends in a CR reads its own base content', () => {
    assert.deepEqual(reasons(carriageReturn('data/a b\r')), [['input', 'data/a b\r']]);
  });

  test("git ignores the repository's core.fsmonitor", () => {
    const dir = commit(web());
    const marker = join(dir, 'fsmonitor-ran');
    git(dir, 'config', 'core.fsmonitor', `touch '${marker}'; false`);
    edit(dir, 'src/greet.ts', s => s.replace("'hi'", "'hello'"));
    assert.equal(since(dir).affected, true);
    assert.equal(existsSync(marker), false);
  });

  test('a project directory laid out as a bare repository is not used as one', () => {
    const dir = commit(web());
    const fake = join(dir, 'fake');
    write(fake, 'package.json', '{ "name": "fake" }\n');
    git(dir, 'init', '-q', '--bare', '-b', 'main', join(dir, 'fake'));
    assert.ok(existsSync(join(fake, 'HEAD')));
    assert.throws(() => since(fake), /not inside a git repository/);
  });
});
