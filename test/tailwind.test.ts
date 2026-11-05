import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, test } from 'node:test';
import { affected, analyze } from '../src/index.ts';
import { edit, initRepo, write } from './helpers.ts';

const REPO_MODULES = join(import.meta.dirname, '..', 'node_modules');

/** Links a package from byakugan's own devDependencies into the fixture. */
const link = (dir: string, name: string, from = name) => {
  const target = join(dir, 'node_modules', name);
  mkdirSync(dirname(target), { recursive: true });
  symlinkSync(join(REPO_MODULES, from), target);
};

/**
 * src/main.ts imports src/app.css and src/button.ts. src/unused.ts is never imported,
 * but Tailwind scans it all the same.
 */
const app = (options: { version?: 3 | 4; css?: string; tailwind?: boolean } = {}) => {
  const version = options.version ?? 4;
  const dir = realpathSync(mkdtempSync(join(tmpdir(), `byakugan-tailwind${version}-`)));
  write(dir, 'package.json', '{ "name": "styled", "devDependencies": { "tailwindcss": "*" } }\n');
  write(dir, 'byakugan.json', '{ "entry": ["src/main.ts"] }\n');
  write(dir, '.gitignore', 'node_modules/\n');
  write(dir, 'src/main.ts', "import './app.css';\nimport { button } from './button';\n\ndocument.body.className = button;\n");
  write(dir, 'src/button.ts', "export const button = 'flex p-4 text-sm';\n");
  write(dir, 'src/unused.ts', "export const banner = () => ['rounded', 'quiet words'];\n");
  write(dir, 'README.md', '# Styled\n');
  if (version === 4) {
    write(dir, 'src/app.css', options.css ?? '@import "tailwindcss";\n');
    if (options.tailwind !== false) {
      link(dir, 'tailwindcss');
      link(dir, '@tailwindcss/node');
      link(dir, '@tailwindcss/oxide');
    } else link(dir, 'tailwindcss');
  } else {
    write(dir, 'src/app.css', '@tailwind utilities;\n');
    write(dir, 'tailwind.config.js', "module.exports = { content: ['./src/**/*.ts'] };\n");
    link(dir, 'tailwindcss', 'tailwindcss3');
  }
  return dir;
};

const fingerprint = (dir: string) => analyze({ cwd: dir }).fingerprint();

describe('Tailwind v4', () => {
  test('the generated CSS is a fragment of the root stylesheet', () => {
    const graph = analyze({ cwd: app() });
    assert.deepEqual(graph.warnings, []);
    assert.ok(graph.live.has('src/app.css#<tailwind>'));
    assert.ok(!graph.live.has('src/unused.ts#banner'));
  });

  test('an unimported file counts only when it changes the generated CSS', () => {
    const dir = app();
    const before = fingerprint(dir);
    edit(dir, 'src/unused.ts', s => s.replace('quiet words', 'other words'));
    assert.equal(fingerprint(dir), before, 'text that is not a class');
    edit(dir, 'src/unused.ts', s => s.replace("'rounded'", "'rounded flex'"));
    assert.equal(fingerprint(dir), before, 'a class already used elsewhere');
    edit(dir, 'README.md', s => `${s}\nNotes for new people.\n`);
    assert.equal(fingerprint(dir), before, 'prose in a scanned file');
    edit(dir, 'src/unused.ts', s => s.replace("'rounded flex'", "'rounded flex skew-y-12'"));
    assert.notEqual(fingerprint(dir), before, 'a new class');
  });

  test('@source limits what counts', () => {
    const dir = app({ css: '@import "tailwindcss" source(none);\n@source "../src";\n' });
    write(dir, 'scripts/seed.ts', "export const seed = 'flex';\n");
    const before = fingerprint(dir);
    edit(dir, 'scripts/seed.ts', s => s.replace("'flex'", "'flex skew-y-12'"));
    assert.equal(fingerprint(dir), before, 'outside @source');
    edit(dir, 'src/unused.ts', s => s.replace("'rounded'", "'rounded skew-y-12'"));
    assert.notEqual(fingerprint(dir), before, 'inside @source');
  });

  test('git mode compares the generated CSS with the base side', () => {
    const dir = app();
    initRepo(dir);
    edit(dir, 'src/unused.ts', s => s.replace('quiet words', 'other words'));
    const quiet = affected({ cwd: dir, base: 'main' });
    assert.equal(quiet.affected, false);
    assert.deepEqual(quiet.ignored.map(i => i.path), ['src/unused.ts']);

    edit(dir, 'src/unused.ts', s => s.replace("'rounded'", "'rounded skew-y-12'"));
    const loud = affected({ cwd: dir, base: 'main' });
    assert.equal(loud.affected, true);
    assert.equal(loud.reasons[0].key, 'src/app.css#<tailwind>');
    assert.match(loud.reasons[0].detail, /src\/unused\.ts/);
    assert.deepEqual(loud.ignored, []);
  });

  test('without a working Tailwind, every file it may scan is hashed whole', () => {
    const dir = app({ tailwind: false });
    const graph = analyze({ cwd: dir });
    assert.ok(graph.warnings.some(w => w.includes('could not run Tailwind')), graph.warnings.join('\n'));
    const before = graph.fingerprint();
    edit(dir, 'src/unused.ts', s => s.replace('quiet words', 'other words'));
    assert.notEqual(fingerprint(dir), before);
  });
});

describe('Tailwind v3', () => {
  test('files matched by content globs count when they change the CSS', () => {
    const dir = app({ version: 3 });
    const graph = analyze({ cwd: dir });
    assert.deepEqual(graph.warnings, []);
    assert.ok(graph.live.has('src/app.css#<tailwind>'));
    const before = graph.fingerprint();
    edit(dir, 'src/unused.ts', s => s.replace('quiet words', 'other words'));
    assert.equal(fingerprint(dir), before, 'text that is not a class');
    write(dir, 'scripts/seed.ts', "export const seed = 'skew-y-12';\n");
    assert.equal(fingerprint(dir), before, 'outside content globs');
    edit(dir, 'src/unused.ts', s => s.replace("'rounded'", "'rounded skew-y-12'"));
    assert.notEqual(fingerprint(dir), before, 'a new class');
  });
});
