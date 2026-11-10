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

describe('cli help', () => {
  test('--help lists every command and where to start', () => {
    const { code, stdout } = run(['--help']);
    assert.equal(code, 0);
    for (const name of ['doctor', 'affected', 'hash', 'why', 'graph', 'compare', 'guide']) assert.match(stdout, new RegExp(`^  ${name}\\s+\\S`, 'm'));
    assert.match(stdout, /byakugan <command> --help/);
  });

  test('a command has its own help, as "<command> --help" and "help <command>"', () => {
    const flag = run(['affected', '--help']);
    assert.equal(flag.code, 0);
    assert.match(flag.stdout, /--base-manifest <file>/);
    assert.match(flag.stdout, /Exit codes\n {2}0 /);
    assert.match(flag.stdout, /^JSON$/m);
    assert.doesNotMatch(flag.stdout, /--maps/);
    assert.equal(run(['help', 'affected']).stdout, flag.stdout);
    assert.match(run(['compare', '--help']).stdout, /--maps/);
  });

  test('guide prints the adoption guide', () => {
    const { code, stdout } = run(['guide']);
    assert.equal(code, 0);
    assert.match(stdout, /byakugan doctor/);
  });
});

describe('cli errors', () => {
  test('a mistyped command gets a suggestion', () => {
    const { code, stderr } = run(['affcted']);
    assert.equal(code, 2);
    assert.match(stderr, /Unknown command "affcted"/);
    assert.match(stderr, /Did you mean "affected"\?/);
  });

  test('a mistyped option gets a suggestion and the command to ask for help', () => {
    const { code, stderr } = run(['affected', '--bse', 'main']);
    assert.equal(code, 2);
    assert.match(stderr, /Unknown option --bse/);
    assert.match(stderr, /Did you mean --base\?/);
    assert.match(stderr, /help: byakugan affected --help/);
  });

  test('an option that belongs to another command is named', () => {
    const { code, stderr } = run(['graph', '--maps', '-C', fixture('basic')]);
    assert.equal(code, 2);
    assert.match(stderr, /--maps does not work with graph/);
    assert.match(stderr, /It works with: compare/);
  });

  test('an option without its value says what the value is', () => {
    const { code, stderr } = run(['affected', '--base']);
    assert.equal(code, 2);
    assert.match(stderr, /--base needs a value/);
  });

  test('a base that git does not know comes with the fetch hint', () => {
    const dir = fixture('basic');
    initRepo(dir);
    const { code, stderr } = run(['affected', '--base', 'origin/nope', '-C', dir]);
    assert.equal(code, 2);
    assert.match(stderr, /"origin\/nope" is not a commit in this clone/);
    assert.match(stderr, /fetch-depth: 0/);
  });

  test('with --json an error is one JSON object on stderr and nothing on stdout', () => {
    const { code, stdout, stderr } = run(['affected', '--json', '-C', fixture('basic')]);
    assert.equal(code, 2);
    assert.equal(stdout, '');
    const { error } = JSON.parse(stderr);
    assert.match(error.message, /needs exactly one of/);
    assert.match(error.hint, /--base origin\/main/);
    assert.equal(error.help, 'byakugan affected --help');
  });

  test('a missing manifest says how to write one', () => {
    const { code, stderr } = run(['affected', '--base-manifest', 'nowhere.json', '-C', fixture('basic')]);
    assert.equal(code, 2);
    assert.match(stderr, /byakugan hash --manifest <file>/);
  });
});

describe('cli colors', () => {
  const ESC = String.fromCharCode(27);

  test('output has no escape sequences by default, and FORCE_COLOR adds them', () => {
    const dir = fixture('basic');
    assert.ok(!run(['graph', '-C', dir]).stdout.includes(ESC));
    assert.ok(run(['graph', '-C', dir], { FORCE_COLOR: '1' }).stdout.includes(`${ESC}[1m`));
    assert.ok(!run(['graph', '-C', dir], { FORCE_COLOR: '1', NO_COLOR: '1' }).stdout.includes(ESC));
  });

  test('with color on, the words stay the same', () => {
    const dir = fixture('basic');
    const strip = (text: string) => text.replaceAll(new RegExp(`${ESC}\\[\\d+m`, 'g'), '');
    assert.equal(strip(run(['graph', '-C', dir], { FORCE_COLOR: '1' }).stdout), run(['graph', '-C', dir]).stdout);
  });

  test('with color on, an escape sequence in a file name is still escaped', () => {
    const dir = fixture('basic');
    write(dir, `src/${ESC}[31mred.ts`, 'export const red = 1;\n');
    edit(dir, 'src/main.tsx', s => `import { red } from './${ESC}[31mred';\nconsole.log(red);\n${s}`);
    const { stdout } = run(['graph', '-C', dir], { FORCE_COLOR: '1' });
    assert.match(stdout, /\\u001b\[31mred\.ts/);
    assert.ok(!stdout.includes(`${ESC}[31m`));
  });
});

describe('cli doctor', () => {
  test('a clean app passes and names the next command', () => {
    const { code, stdout } = run(['doctor', '-C', fixture('basic')]);
    assert.equal(code, 0, stdout);
    assert.match(stdout, /no problems found/);
    assert.match(stdout, /byakugan affected --base origin\/main/);
  });

  test('an import that cannot be resolved blocks, with the fix, and exits with 1', () => {
    const dir = fixture('basic');
    edit(dir, 'src/main.tsx', s => `import '@alias/missing';\nimport './gone';\n${s}`);
    const { code, stdout } = run(['doctor', '-C', dir]);
    assert.equal(code, 1);
    assert.match(stdout, /^blocks\s+2 imports of project code cannot be resolved/m);
    assert.match(stdout, /tsconfig\s+"paths"/);
    assert.match(stdout, /- src\/main\.tsx: cannot resolve "\.\/gone"/);
  });

  test('a type-only import that cannot be resolved is a note, and exits with 0', () => {
    const dir = fixture('basic');
    edit(dir, 'src/main.tsx', s => `import type { Route } from './+types/home';\nexport type R = Route;\n${s}`);
    const { code, stdout } = run(['doctor', '-C', dir]);
    assert.equal(code, 0, stdout);
    assert.match(stdout, /^note\s+1 type-only import cannot be resolved/m);
    assert.doesNotMatch(stdout, /^blocks/m);
  });

  test('--json lists findings by severity and kind', () => {
    const dir = fixture('basic');
    edit(dir, 'src/main.tsx', s => `import './gone';\n${s}`);
    const result = JSON.parse(run(['doctor', '--json', '-C', dir]).stdout);
    assert.equal(result.ok, false);
    const [finding] = result.apps[0].findings;
    assert.deepEqual([finding.severity, finding.kind, finding.count], ['blocks', 'unresolved-import', 1]);
    assert.ok(finding.fix && finding.cost);
  });

  test('a computed import can hide a change', () => {
    const dir = fixture('basic');
    edit(dir, 'src/main.tsx', s => `${s}\nexport const load = (name: string) => import(name);\n`);
    const { code, stdout } = run(['doctor', '-C', dir]);
    assert.equal(code, 1);
    assert.match(stdout, /^hides\s+1 computed import cannot be followed/m);
  });

  test('no entries is a finding, not a crash', () => {
    const dir = fixture('basic');
    write(dir, 'byakugan.json', '{ "framework": "none", "entry": ["missing/*.ts"] }');
    const result = JSON.parse(run(['doctor', '--json', '-C', dir]).stdout);
    assert.ok(result.apps[0].findings.some((f: { kind: string }) => f.kind === 'no-entries'));
  });

  test('--workspace prints one row per app and details for the ones with problems', () => {
    const dir = fixture('monorepo');
    write(dir, 'apps/docs/package.json', JSON.stringify({ name: 'docs', private: true, type: 'module' }));
    write(dir, 'apps/docs/src/index.ts', "import './gone';\nexport const title = 'docs';\n");
    const { code, stdout } = run(['doctor', '--workspace', '-C', dir]);
    assert.equal(code, 1);
    assert.match(stdout, /^apps\/docs\s+none\s+1\s+1\s+1\s+0\s+0$/m);
    assert.match(stdout, /^apps\/web\s+next\s/m);
    assert.match(stdout, /^apps\/docs\nblocks/m);
  });
});
