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

/**
 * A pnpm workspace: apps/web reaches packages/ui through node_modules/@acme/ui, a link, and
 * Tailwind scans the package through that link.
 */
const workspace = (version: 3 | 4) => {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), `byakugan-tailwind-ws${version}-`)));
  const dir = join(repo, 'apps/web');
  write(repo, 'package.json', '{ "name": "root", "private": true }\n');
  write(repo, 'pnpm-workspace.yaml', 'packages:\n  - apps/*\n  - packages/*\n');
  write(repo, '.gitignore', 'node_modules/\n');
  write(repo, 'packages/ui/package.json', '{ "name": "@acme/ui" }\n');
  write(repo, 'packages/ui/src/card.ts', "export const card = () => ['rounded', 'quiet words'];\n");
  write(dir, 'package.json', '{ "name": "web", "devDependencies": { "tailwindcss": "*" } }\n');
  write(dir, 'byakugan.json', '{ "entry": ["src/main.ts"] }\n');
  write(dir, 'src/main.ts', "import './app.css';\n");
  mkdirSync(join(dir, 'node_modules/@acme'), { recursive: true });
  symlinkSync('../../../../packages/ui', join(dir, 'node_modules/@acme/ui'));
  if (version === 4) {
    write(dir, 'src/app.css', '@import "tailwindcss";\n@source "../node_modules/@acme/ui/src";\n');
    link(dir, 'tailwindcss');
    link(dir, '@tailwindcss/node');
    link(dir, '@tailwindcss/oxide');
  } else {
    write(dir, 'src/app.css', '@tailwind utilities;\n');
    write(dir, 'tailwind.config.js', "module.exports = { content: ['./src/**/*.ts', './node_modules/@acme/ui/src/**/*.ts'] };\n");
    link(dir, 'tailwindcss', 'tailwindcss3');
  }
  initRepo(repo);
  return { repo, dir };
};

for (const version of [3, 4] as const) {
  describe(`Tailwind v${version} in a workspace`, () => {
    test('git mode reads the base side of a file Tailwind reaches through a link', () => {
      const { repo, dir } = workspace(version);
      edit(repo, 'packages/ui/src/card.ts', s => s.replace('quiet words', 'other words'));
      assert.equal(affected({ cwd: dir, base: 'main' }).affected, false, 'text that is not a class');
      edit(repo, 'packages/ui/src/card.ts', s => s.replace("'rounded'", "'rounded skew-y-12'"));
      const result = affected({ cwd: dir, base: 'main' });
      assert.equal(result.affected, true, 'a new class');
      assert.equal(result.reasons[0].key, 'apps/web/src/app.css#<tailwind>');
    });

    test('a file under two paths counts once and still counts', () => {
      const { repo, dir } = workspace(version);
      symlinkSync('../../../../packages/ui', join(dir, 'node_modules/@acme/ui-again'));
      edit(dir, 'src/app.css', s => s.replaceAll('@acme/ui', '@acme/ui-again') + s);
      if (version === 3) edit(dir, 'tailwind.config.js', s => s.replace("'] }", "', './node_modules/@acme/ui-again/src/**/*.ts'] }"));
      const before = fingerprint(dir);
      edit(repo, 'packages/ui/src/card.ts', s => s.replace("'rounded'", "'rounded skew-y-12'"));
      assert.notEqual(fingerprint(dir), before);
    });
  });
}

describe('"tailwind": false', () => {
  test('runs no Tailwind and hashes no generated CSS', () => {
    const dir = app();
    write(dir, 'byakugan.json', '{ "entry": ["src/main.ts"], "tailwind": false }\n');
    const graph = analyze({ cwd: dir });
    assert.ok(!graph.live.has('src/app.css#<tailwind>'));
    assert.ok(graph.live.has('src/app.css'), 'the stylesheet itself still counts');
    const before = graph.fingerprint();
    edit(dir, 'src/unused.ts', s => s.replace("'rounded'", "'rounded skew-y-12'"));
    assert.equal(fingerprint(dir), before);
  });
});

/**
 * packages/ui has a v3 stylesheet. apps/host compiles it with its own Tailwind config, which also
 * scans the host's stories, the way Storybook in a host package does.
 */
const hosted = (config: object) => {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), 'byakugan-tailwind-host-')));
  const dir = join(repo, 'packages/ui');
  write(repo, '.gitignore', 'node_modules/\n');
  write(dir, 'package.json', '{ "name": "@acme/ui", "devDependencies": { "tailwindcss": "*" } }\n');
  write(dir, 'byakugan.json', JSON.stringify({ entry: ['src/main.ts'], ...config }));
  write(dir, 'src/main.ts', "import './ui.css';\n");
  write(dir, 'src/ui.css', '@tailwind utilities;\n');
  write(dir, 'tailwind.config.js', "module.exports = { content: ['./src/**/*.ts'] };\n");
  write(repo, 'apps/host/tailwind.config.js', "module.exports = { content: ['./stories/**/*.ts', '../../packages/ui/src/**/*.ts'] };\n");
  write(repo, 'apps/host/stories/card.ts', "export const story = 'rounded';\n");
  link(dir, 'tailwindcss', 'tailwindcss3');
  initRepo(repo);
  return { repo, dir };
};

describe('"tailwindDir"', () => {
  test('compiles the stylesheets with that directory\'s configs', () => {
    const { repo, dir } = hosted({ tailwindDir: '../../apps/host' });
    const before = fingerprint(dir);
    edit(repo, 'apps/host/stories/card.ts', s => s.replace("'rounded'", "'rounded skew-y-12'"));
    assert.notEqual(fingerprint(dir), before);
  });

  test('without it, the project\'s own configs compile them', () => {
    const { repo, dir } = hosted({});
    const before = fingerprint(dir);
    edit(repo, 'apps/host/stories/card.ts', s => s.replace("'rounded'", "'rounded skew-y-12'"));
    assert.equal(fingerprint(dir), before);
  });
});

/**
 * One v3 project with two PostCSS configs: the project's names tailwind.a.js through
 * path.join(__dirname, ...), and src/b/postcss.config.js names tailwind.b.js. Each Tailwind
 * config scans its own folder.
 */
const twoConfigs = (config: object) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'byakugan-tailwind-postcss-')));
  write(dir, 'package.json', '{ "name": "styled", "devDependencies": { "tailwindcss": "*" } }\n');
  write(dir, 'byakugan.json', JSON.stringify({ entry: ['src/main.ts'], ...config }));
  write(dir, 'src/main.ts', "import './a/a.css';\nimport './b/b.css';\n");
  write(dir, 'postcss.config.js', "const path = require('path');\nmodule.exports = { plugins: { tailwindcss: { config: path.join(__dirname, './tailwind.a.js') } } };\n");
  write(dir, 'src/b/postcss.config.js', "module.exports = { plugins: { tailwindcss: { config: './tailwind.b.js' } } };\n");
  write(dir, 'tailwind.a.js', "module.exports = { content: ['./src/a/**/*.ts'] };\n");
  write(dir, 'src/b/tailwind.b.js', "module.exports = { content: ['./src/b/**/*.ts'] };\n");
  write(dir, 'src/a/a.css', '@tailwind utilities;\n');
  write(dir, 'src/b/b.css', '@tailwind utilities;\n');
  write(dir, 'src/a/x.ts', "export const x = 'rounded';\n");
  write(dir, 'src/b/y.ts', "export const y = 'rounded';\n");
  link(dir, 'tailwindcss', 'tailwindcss3');
  return dir;
};

describe('PostCSS configs', () => {
  test('a Tailwind config named with path.join(__dirname, ...) is the one that runs', () => {
    const dir = twoConfigs({});
    const before = fingerprint(dir);
    edit(dir, 'src/a/x.ts', s => s.replace("'rounded'", "'rounded skew-y-12'"));
    assert.notEqual(fingerprint(dir), before);
  });

  test('"postcssFromStylesheet" reads the config nearest each stylesheet', () => {
    const dir = twoConfigs({ postcssFromStylesheet: true });
    const before = fingerprint(dir);
    edit(dir, 'src/b/y.ts', s => s.replace("'rounded'", "'rounded skew-y-12'"));
    assert.notEqual(fingerprint(dir), before, 'src/b/b.css runs tailwind.b.js');
  });

  test('without it, every stylesheet reads the project\'s config', () => {
    const dir = twoConfigs({});
    const before = fingerprint(dir);
    edit(dir, 'src/b/y.ts', s => s.replace("'rounded'", "'rounded skew-y-12'"));
    assert.equal(fingerprint(dir), before, 'tailwind.a.js does not scan src/b');
  });
});
