import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { analyze } from '../src/index.ts';
import { edit, fixture, initRepo, write } from './helpers.ts';

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
