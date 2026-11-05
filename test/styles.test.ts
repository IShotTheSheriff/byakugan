import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, renameSync, symlinkSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { describe, test } from 'node:test';
import { affected, analyze, loadProject } from '../src/index.ts';
import { app, edit, git, liveKeys, pkg, write } from './helpers.ts';

const REPO_MODULES = join(import.meta.dirname, '..', 'node_modules');
const CLI = join(import.meta.dirname, '../src/cli.ts');

/** Links a package from byakugan's own devDependencies into the project. */
const link = (dir: string, name: string, from = name) => {
  const target = join(dir, 'node_modules', name);
  mkdirSync(dirname(target), { recursive: true });
  symlinkSync(join(REPO_MODULES, from), target);
};

/** postcss-import comes with tailwindcss v3. */
const POSTCSS_IMPORT = dirname(createRequire(join(REPO_MODULES, 'tailwindcss3/package.json')).resolve('postcss-import/package.json'));

const tailwind4 = (dir: string) => {
  link(dir, 'tailwindcss');
  link(dir, '@tailwindcss/node');
  link(dir, '@tailwindcss/oxide');
  return dir;
};

const tailwind3 = (dir: string, options: { postcssImport?: boolean } = {}) => {
  link(dir, 'tailwindcss', 'tailwindcss3');
  if (options.postcssImport) {
    mkdirSync(join(dir, 'node_modules'), { recursive: true });
    symlinkSync(POSTCSS_IMPORT, join(dir, 'node_modules/postcss-import'));
  }
  return dir;
};

const fingerprint = (dir: string) => analyze({ cwd: dir }).fingerprint();
const sinceMain = (dir: string) => affected({ cwd: dir, base: 'main' });
const reasonKeys = (dir: string) => sinceMain(dir).reasons.map(r => r.key);

/** Moves a file out of the project, so git sees it as deleted. */
const remove = (dir: string, path: string) => {
  const trash = join(dir, '..', `${dir.split('/').pop()}-trash`);
  mkdirSync(trash, { recursive: true });
  renameSync(join(dir, path), join(trash, path.replaceAll('/', '_')));
};

/** `@import url(/src/x.css)`: the worker inlines it, the graph does not read it. */

/** Files every plain project here starts with. The entry is src/main.ts. */
const plain = (files: Record<string, string | object>): Record<string, string | object> => ({
  'package.json': { name: 'styled' },
  'byakugan.json': { entry: ['src/main.ts'] },
  '.gitignore': 'node_modules/\n',
  ...files,
});

describe('Vite query imports', () => {
  const files = {
    'package.json': { name: 'spa', type: 'module', devDependencies: { vite: '7.0.0' } },
    'vite.config.ts': 'export default {};\n',
    'index.html': '<script type="module" src="/src/main.ts"></script>\n',
    'tsconfig.json': { compilerOptions: { baseUrl: '.', paths: { '~/*': ['./src/*'] } } },
    '.gitignore': 'node_modules/\n',
    'src/main.ts': [
      "import sheet from '~/app.css?url';",
      "import inline from './inline.css?inline';",
      "import snippet from './snippet.ts?raw';",
      "import { used } from './used';",
      "import Counter from './counter.ts?worker';",
      'export const links = [sheet, inline, snippet, used, new Counter()];',
      '',
    ].join('\n'),
    'src/app.css': '.a { color: red; }\n',
    'src/inline.css': '.b { color: red; }\n',
    'src/other.css': '.c { color: red; }\n',
    'src/snippet.ts': '// shown on the docs page\nexport const answer = 42;\n',
    'src/used.ts': '// a helper\nexport const used = 1;\n',
    'src/counter.ts': "import { step } from './step';\nlet count = 0;\nself.onmessage = () => postMessage((count += step));\n",
    'src/step.ts': 'export const step = 1;\nexport const unused = 2;\n',
  };

  test('?url and ?inline stylesheets resolve to the file', () => {
    const keys = liveKeys(app(files));
    assert.ok(keys.includes('src/app.css'), keys.join('\n'));
    assert.ok(keys.includes('src/inline.css'));
    assert.ok(!keys.some(k => k.includes('?')), 'no key keeps the query');
    assert.ok(!keys.includes('src/other.css'));
  });

  test('editing a stylesheet imported with ?url or ?inline is affected', () => {
    const dir = app(files, { repo: true });
    edit(dir, 'src/app.css', s => s.replace('red', 'blue'));
    assert.deepEqual(reasonKeys(dir), ['src/app.css']);
    git(dir, 'checkout', '-q', '.');
    edit(dir, 'src/inline.css', s => s.replace('red', 'blue'));
    assert.deepEqual(reasonKeys(dir), ['src/inline.css']);
  });

  test('editing a stylesheet nobody imports is not affected', () => {
    const dir = app(files, { repo: true });
    edit(dir, 'src/other.css', s => s.replace('red', 'blue'));
    assert.equal(sinceMain(dir).affected, false);
  });

  test('a comment in a file imported with ?raw is affected', () => {
    const dir = app(files, { repo: true });
    const before = fingerprint(dir);
    edit(dir, 'src/snippet.ts', s => s.replace('docs page', 'home page'));
    assert.notEqual(fingerprint(dir), before);
    const result = sinceMain(dir);
    assert.equal(result.affected, true);
    assert.deepEqual(result.reasons.map(r => r.key), ['src/snippet.ts#<raw>']);
  });

  test('a comment in a file imported normally is not affected', () => {
    const dir = app(files, { repo: true });
    const before = fingerprint(dir);
    edit(dir, 'src/used.ts', s => s.replace('a helper', 'the helper'));
    assert.equal(fingerprint(dir), before);
    assert.equal(sinceMain(dir).affected, false);
  });

  test('top-level code of a ?worker file is affected', () => {
    const dir = app(files, { repo: true });
    edit(dir, 'src/counter.ts', s => s.replace('count += step', 'count -= step'));
    assert.deepEqual(reasonKeys(dir), ['src/counter.ts#<module>']);
  });

  test('an export nobody uses in a module the worker imports is not affected', () => {
    const dir = app(files, { repo: true });
    edit(dir, 'src/step.ts', s => s.replace('unused = 2', 'unused = 3'));
    assert.equal(sinceMain(dir).affected, false);
    edit(dir, 'src/step.ts', s => s.replace('step = 1', 'step = 2'));
    assert.deepEqual(reasonKeys(dir), ['src/step.ts#step']);
  });
});

describe('stylesheets linked from Vite index.html', () => {
  const files = {
    'package.json': { name: 'spa', type: 'module', devDependencies: { vite: '7.0.0', tailwindcss: '4.3.4' } },
    'vite.config.ts': 'export default {};\n',
    'index.html': '<link href="/src/style.css" rel="stylesheet">\n<!-- <link href="/src/old.css" rel="stylesheet"> -->\n<script type="module" src="/src/main.ts"></script>\n',
    '.gitignore': 'node_modules/\n',
    'src/main.ts': "document.body.className = 'flex';\n",
    'src/style.css': '@import "tailwindcss";\n',
    'src/old.css': '.old { color: red; }\n',
    'src/unused.ts': "export const banner = ['quiet words'];\n",
  };

  test('the linked stylesheet is an entry and a Tailwind root', () => {
    const dir = tailwind4(app(files));
    const graph = analyze({ cwd: dir });
    assert.ok(graph.project.entries.includes(join(dir, 'src/style.css')));
    assert.ok(!graph.project.entries.includes(join(dir, 'src/old.css')), 'a link inside an HTML comment');
    assert.ok(graph.live.has('src/style.css#<tailwind>'));
  });

  test('editing the linked stylesheet is affected, a commented-out one is not', () => {
    const dir = tailwind4(app(files, { repo: true }));
    edit(dir, 'src/old.css', s => s.replace('red', 'blue'));
    assert.equal(sinceMain(dir).affected, false);
    git(dir, 'checkout', '-q', '.');
    edit(dir, 'src/style.css', s => `${s}.x { color: red; }\n`);
    assert.deepEqual(reasonKeys(dir), ['src/style.css']);
  });

  test('a new class in a file nobody imports is affected, plain text is not', () => {
    const dir = tailwind4(app(files, { repo: true }));
    edit(dir, 'src/unused.ts', s => s.replace('quiet words', 'other words'));
    assert.equal(sinceMain(dir).affected, false);
    edit(dir, 'src/unused.ts', s => s.replace('other words', 'skew-y-12'));
    assert.deepEqual(reasonKeys(dir), ['src/style.css#<tailwind>']);
  });
});

describe('stylesheet references', () => {
  const files = plain({
    'src/main.ts': [
      "import styles from './button.module.css';",
      "import './main.scss';",
      "import './theme.less';",
      "import './hero.css';",
      'document.body.className = styles.btn;',
      '',
    ].join('\n'),
    'src/button.module.css': "@value primary from './colors.css';\n.btn {\n  composes: base from './base.module.css';\n  color: primary;\n}\n",
    'src/base.module.css': '.base { padding: 4px; }\n',
    'src/colors.css': '@value primary: red;\n',
    'src/other.module.css': '.other { padding: 4px; }\n',
    'src/main.scss': "@import 'variables', 'mixins';\n// @use 'old';\n/* @import 'older'; */\n.a { background: url(https://cdn.example.com/a.png); } @use 'tokens';\nbody { color: $c; }\n",
    'src/_variables.scss': '$c: red;\n',
    'src/_mixins.scss': '@mixin m { color: red; }\n',
    'src/_tokens.scss': '$t: 1;\n',
    'src/_old.scss': '$o: 1;\n',
    'src/_older.scss': '$o: 2;\n',
    'src/_unused.scss': '$u: 1;\n',
    'src/theme.less': '@import (reference) "tokens.less";\n.a { color: @brand; }\n',
    'src/tokens.less': '@brand: red;\n',
    'src/unused.less': '@u: red;\n',
    'src/hero.css': '.hero { background-image: image-set("./hero.png" 1x, "./hero@2x.png" 2x); }\n/* .old { background: url(./old.png); } */\n',
    'src/hero.png': 'PNG1',
    'src/hero@2x.png': 'PNG2',
    'src/old.png': 'PNG3',
    'src/other.png': 'PNG4',
  });

  const affectedBy = (path: string) => {
    const dir = app(files, { repo: true });
    edit(dir, path, s => `${s}\n`);
    return sinceMain(dir);
  };

  for (const path of [
    'src/base.module.css',
    'src/colors.css',
    'src/_variables.scss',
    'src/_mixins.scss',
    'src/_tokens.scss',
    'src/tokens.less',
    'src/hero.png',
    'src/hero@2x.png',
  ]) {
    test(`editing ${path}, which a stylesheet references, is affected`, () => {
      const result = affectedBy(path);
      assert.equal(result.affected, true, path);
      assert.deepEqual(result.reasons.map(r => r.key), [path]);
    });
  }

  for (const path of ['src/other.module.css', 'src/_unused.scss', 'src/unused.less', 'src/other.png', 'src/_old.scss', 'src/_older.scss', 'src/old.png']) {
    test(`editing ${path}, which nothing references or only a comment names, is not affected`, () => {
      assert.equal(affectedBy(path).affected, false, path);
    });
  }

  test('deleting an asset a stylesheet still points at is affected', () => {
    const dir = app(plain({ 'src/main.ts': "import './app.css';\n", 'src/app.css': '.a { background: url("./bg.png"); }\n', 'src/bg.png': 'PNG', 'src/spare.png': 'PNG' }), {
      repo: true,
    });
    remove(dir, 'src/bg.png');
    const result = sinceMain(dir);
    assert.equal(result.affected, true);
    assert.match(result.reasons[0].detail, /deleted/);
  });

  test('deleting an asset no stylesheet points at is not affected', () => {
    const dir = app(plain({ 'src/main.ts': "import './app.css';\n", 'src/app.css': '.a { background: url("./bg.png"); }\n', 'src/bg.png': 'PNG', 'src/spare.png': 'PNG' }), {
      repo: true,
    });
    remove(dir, 'src/spare.png');
    assert.equal(sinceMain(dir).affected, false);
  });
});

describe('aliases and Sass load paths in stylesheets', () => {
  const next = (extra: Record<string, string | object>) =>
    app(
      {
        'package.json': { name: 'web', dependencies: { next: '15.0.0', react: '19.0.0', sass: '1.80.0' } },
        '.gitignore': 'node_modules/\n',
        'app/page.tsx': "import styles from './page.module.scss';\nexport default function Page() { return <div className={styles.hero} />; }\n",
        ...extra,
      },
      { repo: true }
    );

  test('tsconfig paths resolve in @use, and only the target counts', () => {
    const dir = next({
      'tsconfig.json': { compilerOptions: { baseUrl: '.', paths: { '@/*': ['./*'] } } },
      'app/page.module.scss': "@use '@/styles/variables' as *;\n.hero { color: $brand; }\n",
      'styles/_variables.scss': '$brand: blue;\n',
      'styles/_other.scss': '$other: blue;\n',
    });
    assert.deepEqual(analyze({ cwd: dir }).unresolved, []);
    edit(dir, 'styles/_other.scss', s => s.replace('blue', 'red'));
    assert.equal(sinceMain(dir).affected, false);
    edit(dir, 'styles/_variables.scss', s => s.replace('blue', 'red'));
    assert.deepEqual(reasonKeys(dir), ['styles/_variables.scss']);
  });

  test('tsconfig paths resolve in a plain CSS @import', () => {
    const dir = app(
      plain({
        'tsconfig.json': { compilerOptions: { baseUrl: '.', paths: { '@/*': ['./src/*'] } } },
        'src/main.ts': "import styles from './x.module.css';\ndocument.body.className = styles.a;\n",
        'src/x.module.css': '@import "@/styles/tokens.css";\n.a { color: var(--c); }\n',
        'src/styles/tokens.css': ':root { --c: red; }\n',
        'src/styles/spare.css': ':root { --d: red; }\n',
      }),
      { repo: true }
    );
    edit(dir, 'src/styles/spare.css', s => s.replace('red', 'blue'));
    assert.equal(sinceMain(dir).affected, false);
    edit(dir, 'src/styles/tokens.css', s => s.replace('red', 'blue'));
    assert.deepEqual(reasonKeys(dir), ['src/styles/tokens.css']);
  });

  test('sassOptions.includePaths in next.config resolve @use', () => {
    const dir = next({
      'next.config.js': "const path = require('path');\nmodule.exports = { sassOptions: { includePaths: [path.join(__dirname, 'styles')] } };\n",
      'app/page.module.scss': "@use 'abstracts/colors' as c;\n.hero { color: c.$brand; }\n",
      'styles/abstracts/_colors.scss': '$brand: blue;\n',
      'styles/abstracts/_spacing.scss': '$gap: 4px;\n',
    });
    edit(dir, 'styles/abstracts/_spacing.scss', s => s.replace('4px', '8px'));
    assert.equal(sinceMain(dir).affected, false);
    edit(dir, 'styles/abstracts/_colors.scss', s => s.replace('blue', 'red'));
    assert.deepEqual(reasonKeys(dir), ['styles/abstracts/_colors.scss']);
  });

  test('Sass loadPaths in vite.config resolve @use', () => {
    const dir = app(
      {
        'package.json': { name: 'spa', type: 'module', devDependencies: { vite: '7.0.0', sass: '1.80.0' } },
        'vite.config.ts': "export default { css: { preprocessorOptions: { scss: { loadPaths: ['shared'] } } } };\n",
        'index.html': '<script type="module" src="/src/main.ts"></script>\n',
        '.gitignore': 'node_modules/\n',
        'src/main.ts': "import './app.scss';\n",
        'src/app.scss': "@use 'tokens';\nbody { color: tokens.$c; }\n",
        'shared/_tokens.scss': '$c: red;\n',
        'shared/_spare.scss': '$s: red;\n',
      },
      { repo: true }
    );
    edit(dir, 'shared/_spare.scss', s => s.replace('red', 'blue'));
    assert.equal(sinceMain(dir).affected, false);
    edit(dir, 'shared/_tokens.scss', s => s.replace('red', 'blue'));
    assert.deepEqual(reasonKeys(dir), ['shared/_tokens.scss']);
  });
});

describe('order of CSS imports', () => {
  const files = plain({
    'src/main.ts': "import './app.css';\nimport { Header } from './header';\nimport styles from './x.module.css';\nimport { pure } from './pure';\ndocument.body.className = Header + styles.h + pure;\n",
    'src/app.css': '.a { color: red; }\n',
    'src/header.ts': "import './header.css';\nexport const Header = 'h';\n",
    'src/header.css': '.h { color: blue; }\n',
    'src/x.module.css': '.h { color: green; }\n',
    'src/pure.ts': "export const pure = 'p';\n",
  });
  const swap = (dir: string, a: string, b: string) =>
    edit(dir, 'src/main.ts', s => {
      const lines = s.split('\n');
      const i = lines.findIndex(l => l.includes(a));
      const j = lines.findIndex(l => l.includes(b));
      [lines[i], lines[j]] = [lines[j], lines[i]];
      return lines.join('\n');
    });

  test('moving a CSS import past a module that imports CSS is affected', () => {
    const dir = app(files, { repo: true });
    const before = fingerprint(dir);
    swap(dir, "'./app.css'", "'./header'");
    assert.notEqual(fingerprint(dir), before);
    assert.deepEqual(reasonKeys(dir), ['src/main.ts#<imports>']);
  });

  test('moving a CSS import past a CSS Modules import is affected', () => {
    const dir = app(files, { repo: true });
    swap(dir, "'./app.css'", "'./x.module.css'");
    assert.deepEqual(reasonKeys(dir), ['src/main.ts#<imports>']);
  });

  test('moving a CSS import past a module that only declares things is not affected', () => {
    const dir = app(files, { repo: true });
    const before = fingerprint(dir);
    swap(dir, "'./x.module.css'", "'./pure'");
    assert.equal(fingerprint(dir), before);
    assert.equal(sinceMain(dir).affected, false);
  });
});

describe('Tailwind root choice', () => {
  const v4 = (files: Record<string, string | object>, repo = true) =>
    tailwind4(
      app(
        plain({
          'package.json': { name: 'styled', devDependencies: { tailwindcss: '*' } },
          'src/main.ts': "import './app.css';\ndocument.body.className = 'flex';\n",
          'src/unused.ts': "export const banner = ['quiet words'];\n",
          ...files,
        }),
        { repo }
      )
    );

  test('the stylesheet code imports is the root when the directive sits in a file it imports', () => {
    const files = {
      'src/app.css': '@import "./tw.css";\n@theme { --color-brand: #f00; }\n',
      'src/tw.css': '@import "tailwindcss";\n',
    };
    const keys = liveKeys(v4(files, false));
    assert.ok(keys.includes('src/app.css#<tailwind>'), keys.join('\n'));
    assert.ok(!keys.includes('src/tw.css#<tailwind>'));
    const dir = v4(files);
    edit(dir, 'src/unused.ts', s => s.replace('quiet words', 'other words'));
    assert.equal(sinceMain(dir).affected, false, 'text that is not a class');
    edit(dir, 'src/unused.ts', s => s.replace('other words', 'bg-brand'));
    assert.deepEqual(reasonKeys(dir), ['src/app.css#<tailwind>'], 'a color the root stylesheet defines');
  });

  test('a Tailwind stylesheet from a package is followed', () => {
    const files = {
      'src/app.css': '@import "@acme/design/tailwind.css";\n',
      ...pkg('@acme/design', { exports: { './tailwind.css': './tailwind.css' } }, { 'tailwind.css': '@import "tailwindcss";\n@theme { --color-brand: #f00; }\n' }),
    };
    assert.ok(liveKeys(v4(files, false)).includes('src/app.css#<tailwind>'));
    const dir = v4(files);
    edit(dir, 'src/unused.ts', s => s.replace('quiet words', 'bg-blue'));
    assert.equal(sinceMain(dir).affected, false, 'a color nobody defines');
    edit(dir, 'src/unused.ts', s => s.replace('bg-blue', 'bg-brand'));
    assert.deepEqual(reasonKeys(dir), ['src/app.css#<tailwind>']);
  });
});

describe('Tailwind v3', () => {
  const v3 = (files: Record<string, string | object>, options: { repo?: boolean; postcssImport?: boolean } = {}) =>
    tailwind3(
      app(
        plain({
          'package.json': { name: 'styled', devDependencies: { tailwindcss: '*' } },
          'src/main.ts': "import './app.css';\ndocument.body.className = 'flex';\n",
          'src/unused.ts': "export const banner = ['quiet words'];\n",
          'tailwind.config.js': "module.exports = { content: ['./src/**/*.ts'] };\n",
          ...files,
        }),
        { repo: options.repo ?? true }
      ),
      options
    );

  test('with postcss-import, a component class from an imported file counts', () => {
    const dir = v3(
      {
        'postcss.config.js': "module.exports = { plugins: { 'postcss-import': {}, tailwindcss: {} } };\n",
        'src/app.css': '@import "tailwindcss/base";\n@import "tailwindcss/components";\n@import "./buttons.css";\n@import "tailwindcss/utilities";\n',
        'src/buttons.css': '@layer components {\n  .btn-primary { color: red; }\n}\n',
      },
      { postcssImport: true }
    );
    edit(dir, 'src/unused.ts', s => s.replace('quiet words', 'btn-secondary'));
    assert.equal(sinceMain(dir).affected, false, 'a class nobody defines');
    edit(dir, 'src/unused.ts', s => s.replace('btn-secondary', 'btn-primary'));
    assert.deepEqual(reasonKeys(dir), ['src/app.css#<tailwind>']);
  });

  test('without postcss-import, each imported file with directives is compiled', () => {
    const files = {
      'src/app.css': '@import "./base.css";\n@import "./utilities.css";\n',
      'src/base.css': '@tailwind base;\n',
      'src/utilities.css': '@tailwind utilities;\n',
    };
    const graph = analyze({ cwd: v3(files, { repo: false }) });
    assert.deepEqual(graph.warnings, []);
    assert.ok(graph.live.has('src/app.css#<tailwind>'));
    const dir = v3(files);
    edit(dir, 'src/unused.ts', s => s.replace('quiet words', 'other words'));
    assert.equal(sinceMain(dir).affected, false);
    edit(dir, 'src/unused.ts', s => s.replace('other words', 'skew-y-12'));
    assert.deepEqual(reasonKeys(dir), ['src/app.css#<tailwind>']);
  });

  for (const [form, postcss] of [
    ['an object key', "module.exports = { plugins: { tailwindcss: { config: './config/tailwind.config.js' } } };\n"],
    ['a call', "const tailwindcss = require('tailwindcss');\nmodule.exports = { plugins: [tailwindcss({ config: './config/tailwind.config.js' })] };\n"],
    ['an inline require call', "module.exports = { plugins: [require('tailwindcss')({ config: './config/tailwind.config.js' })] };\n"],
  ]) {
    test(`the config path set in the PostCSS config as ${form} is read`, () => {
      const dir = v3({
        'postcss.config.js': postcss,
        'config/tailwind.config.js': "module.exports = { content: ['./src/**/*.ts'] };\n",
        // A config at the default path that the build does not use.
        'tailwind.config.js': "module.exports = { content: ['./other/**/*.ts'] };\n",
        'src/app.css': '@tailwind utilities;\n',
        'other/seed.ts': "export const seed = 'quiet';\n",
      });
      edit(dir, 'other/seed.ts', s => s.replace('quiet', 'skew-y-12'));
      assert.equal(sinceMain(dir).affected, false, 'outside the content of the config in use');
      git(dir, 'checkout', '-q', '.');
      edit(dir, 'src/unused.ts', s => s.replace('quiet words', 'skew-y-12'));
      assert.deepEqual(reasonKeys(dir), ['src/app.css#<tailwind>']);
    });
  }

  test('absolute content globs count new classes and deletions', () => {
    const files = {
      'tailwind.config.js': "const path = require('path');\nmodule.exports = { content: [path.join(__dirname, 'src/**/*.ts')] };\n",
      'src/app.css': '@tailwind utilities;\n',
      'src/rare.ts': "export const rare = 'skew-y-12';\n",
      'other/seed.ts': "export const seed = 'quiet';\n",
    };
    const dir = v3(files);
    edit(dir, 'other/seed.ts', s => s.replace('quiet', 'skew-y-6'));
    assert.equal(sinceMain(dir).affected, false, 'outside the globs');
    edit(dir, 'src/unused.ts', s => s.replace('quiet words', 'skew-y-6'));
    assert.deepEqual(reasonKeys(dir), ['src/app.css#<tailwind>'], 'inside the globs');
    git(dir, 'checkout', '-q', '.');
    remove(dir, 'src/rare.ts');
    const deleted = sinceMain(dir);
    assert.deepEqual(deleted.reasons.map(r => r.key), ['src/app.css#<tailwind>'], 'deleting the only file with a class');
    assert.match(deleted.reasons[0].detail, /src\/rare\.ts/);
  });

  test('deleting a scanned file whose classes are used elsewhere is not affected', () => {
    const dir = v3({
      'tailwind.config.js': "const path = require('path');\nmodule.exports = { content: [path.join(__dirname, 'src/**/*.ts')] };\n",
      'src/app.css': '@tailwind utilities;\n',
      'src/copy.ts': "export const copy = 'flex';\n",
    });
    remove(dir, 'src/copy.ts');
    assert.equal(sinceMain(dir).affected, false);
  });
});

describe('Tailwind v4 deletions in git mode', () => {
  const files = (css: string) =>
    plain({
      'package.json': { name: 'styled', devDependencies: { tailwindcss: '*' } },
      'src/main.ts': "import './app.css';\ndocument.body.className = 'flex';\n",
      'src/app.css': css,
      'content/rare.md': '<div class="skew-y-12">x</div>\n',
      'content/plain.md': '<div class="flex">x</div>\n',
    });

  for (const [name, css] of [
    ['automatic source', '@import "tailwindcss";\n'],
    ['@source with ../', '@import "tailwindcss" source(none);\n@source "../content";\n@source "./";\n'],
    ['@source with a glob', '@import "tailwindcss" source(none);\n@source "../**/*.{md,ts}";\n'],
  ]) {
    test(`${name}: deleting the only file with a class is affected`, () => {
      const dir = tailwind4(app(files(css), { repo: true }));
      remove(dir, 'content/rare.md');
      const result = sinceMain(dir);
      assert.deepEqual(result.reasons.map(r => r.key), ['src/app.css#<tailwind>']);
      assert.match(result.reasons[0].detail, /content\/rare\.md/);
    });

    test(`${name}: deleting a file whose classes are used elsewhere is not affected`, () => {
      const dir = tailwind4(app(files(css), { repo: true }));
      remove(dir, 'content/plain.md');
      assert.equal(sinceMain(dir).affected, false);
    });
  }

  test('deleting a file outside @source is not affected', () => {
    const dir = tailwind4(app({ ...files('@import "tailwindcss" source(none);\n@source "../content";\n'), 'scripts/seed.md': '<div class="skew-y-6">x</div>\n' }, { repo: true }));
    remove(dir, 'scripts/seed.md');
    assert.equal(sinceMain(dir).affected, false);
  });
});

describe('CSS tools tracked by version', () => {
  test('a tailwindcss bump in the lockfile is affected without a framework', () => {
    const lock = (tw: string, pad: string) =>
      `${JSON.stringify({
        name: 'styled',
        lockfileVersion: 3,
        packages: {
          '': { name: 'styled', dependencies: { 'left-pad': '*' }, devDependencies: { tailwindcss: '*' } },
          'node_modules/tailwindcss': { version: tw },
          'node_modules/left-pad': { version: pad },
        },
      })}\n`;
    const dir = tailwind3(
      app(
        plain({
          'package.json': { name: 'styled', dependencies: { 'left-pad': '*' }, devDependencies: { tailwindcss: '*' } },
          'package-lock.json': lock('3.3.0', '1.0.0'),
          'tailwind.config.js': "module.exports = { content: ['./src/**/*.ts'] };\n",
          'src/main.ts': "import './app.css';\n",
          'src/app.css': '@tailwind utilities;\n',
        }),
        { repo: true }
      )
    );
    write(dir, 'package-lock.json', lock('3.3.0', '1.0.1'));
    assert.equal(sinceMain(dir).affected, false, 'a package the app does not use');
    write(dir, 'package-lock.json', lock('3.4.17', '1.0.0'));
    assert.deepEqual(reasonKeys(dir), ['tailwindcss']);
  });

  test('a Tailwind root tracks tailwindcss even when it is not a declared dependency', () => {
    const files = plain({ 'tailwind.config.js': "module.exports = { content: ['./src/**/*.ts'] };\n", 'src/main.ts': "import './app.css';\n" });
    const withRoot = tailwind3(app({ ...files, 'src/app.css': '@tailwind utilities;\n' }));
    assert.ok(liveKeys(withRoot).includes('npm:tailwindcss#<version>'));
    const without = tailwind3(app({ ...files, 'src/app.css': '.a { color: red; }\n' }));
    assert.ok(!liveKeys(without).includes('npm:tailwindcss#<version>'));
  });

  test('caniuse-lite and browserslist are tracked when autoprefixer is a dependency', () => {
    const browserData = { ...pkg('caniuse-lite', { version: '1.0.30001700' }, {}), ...pkg('browserslist', { version: '4.24.0' }, {}) };
    const files = (deps: object) => plain({ 'package.json': { name: 'styled', devDependencies: deps }, 'src/main.ts': "import './app.css';\n", 'src/app.css': '.a { color: red; }\n', ...browserData });
    const tracked = loadProject({ cwd: app(files({ autoprefixer: '10.0.0', postcss: '8.0.0' })) }).packages;
    assert.ok(tracked.includes('caniuse-lite'), tracked.join(', '));
    assert.ok(tracked.includes('browserslist'));
    const untracked = loadProject({ cwd: app(files({ postcss: '8.0.0' })) }).packages;
    assert.ok(!untracked.includes('caniuse-lite'), untracked.join(', '));
  });

  test('a caniuse-lite bump in the lockfile is affected with autoprefixer, not without', () => {
    const lock = (deps: object, version: string) =>
      `${JSON.stringify({ name: 'styled', lockfileVersion: 3, packages: { '': { name: 'styled', devDependencies: deps }, 'node_modules/caniuse-lite': { version } } })}\n`;
    const project = (deps: object) =>
      app(
        plain({
          'package.json': { name: 'styled', devDependencies: deps },
          'package-lock.json': lock(deps, '1.0.30001700'),
          'src/main.ts': "import './app.css';\n",
          'src/app.css': '.a { color: red; }\n',
          ...pkg('caniuse-lite', { version: '1.0.30001700' }, {}),
        }),
        { repo: true }
      );
    const prefixed = project({ autoprefixer: '10.0.0' });
    write(prefixed, 'package-lock.json', lock({ autoprefixer: '10.0.0' }, '1.0.30001750'));
    assert.deepEqual(reasonKeys(prefixed), ['caniuse-lite']);
    const plainCss = project({ postcss: '8.0.0' });
    write(plainCss, 'package-lock.json', lock({ postcss: '8.0.0' }, '1.0.30001750'));
    assert.equal(sinceMain(plainCss).affected, false);
  });

  test('a PostCSS plugin named as an unquoted key is tracked, one the config does not name is not', () => {
    const dir = app({
      'package.json': { name: 'web', dependencies: { next: '15.0.0', react: '19.0.0' }, devDependencies: { cssnano: '7.0.0', 'postcss-nested': '6.0.0' } },
      'postcss.config.js': "module.exports = { plugins: { '@tailwindcss/postcss': {}, cssnano: {} } };\n",
      'app/page.tsx': 'export default function Page() { return null; }\n',
    });
    const packages = loadProject({ cwd: dir }).packages;
    assert.ok(packages.includes('cssnano'), packages.join(', '));
    assert.ok(!packages.includes('postcss-nested'));
  });
});

describe('when Tailwind cannot run', () => {
  const monorepo = (options: { broken?: boolean } = {}) => {
    const plugin = options.broken === false ? '' : '@plugin "./broken.mjs";\n';
    const dir = app(
      {
        'package.json': { name: 'root', private: true, workspaces: ['apps/*', 'packages/*'] },
        '.gitignore': 'node_modules/\n',
        'apps/web/package.json': { name: 'web', dependencies: { next: '15.0.0', react: '19.0.0', '@workspace/ui': '*' }, devDependencies: { tailwindcss: '*' } },
        'apps/web/app/layout.tsx': "import '@workspace/ui/globals.css';\nexport default function Layout({ children }) { return children; }\n",
        'apps/web/app/page.tsx': "export default function Page() { return <div className='flex' />; }\n",
        'packages/ui/package.json': { name: '@workspace/ui', version: '0.0.0', exports: { './globals.css': './src/styles/globals.css' } },
        'packages/ui/src/styles/globals.css': `@import "tailwindcss";\n${plugin}@source "../**/*.{ts,tsx}";\n`,
        'packages/ui/src/styles/broken.mjs': "throw new Error('boom');\n",
        'packages/ui/src/components/dialog.tsx': "export const Dialog = () => <div className='rounded skew-y-12' />;\n",
        'packages/ui/src/components/plain.tsx': "export const Plain = () => <div className='flex' />;\n",
        'packages/ui/src/icon.png': 'PNG',
      },
      { repo: true }
    );
    mkdirSync(join(dir, 'node_modules/@workspace'), { recursive: true });
    symlinkSync('../../packages/ui', join(dir, 'node_modules/@workspace/ui'));
    // npm workspaces hoist Tailwind to the root.
    tailwind4(dir);
    return { dir, web: join(dir, 'apps/web') };
  };

  test('files in other workspace packages are hashed whole, with a warning', () => {
    const { dir, web } = monorepo();
    const graph = analyze({ cwd: web });
    assert.ok(graph.warnings.some(w => w.includes('could not run Tailwind')), graph.warnings.join('\n'));
    const before = graph.fingerprint();
    edit(dir, 'packages/ui/src/components/dialog.tsx', s => s.replace('skew-y-12', 'skew-y-6'));
    assert.notEqual(fingerprint(web), before);
    assert.equal(affected({ cwd: web, base: 'main' }).affected, true);
  });

  test('binary files are still left out', () => {
    const { dir, web } = monorepo();
    const before = fingerprint(web);
    write(dir, 'packages/ui/src/icon.png', 'PNG2');
    assert.equal(fingerprint(web), before);
  });

  test('deleting a file it may scan is affected', () => {
    const { dir, web } = monorepo();
    remove(dir, 'packages/ui/src/components/plain.tsx');
    assert.equal(sinceMain(web).affected, true);
  });

  test('deleting the same file is not affected when Tailwind runs', () => {
    const { dir, web } = monorepo({ broken: false });
    assert.deepEqual(analyze({ cwd: web }).warnings, []);
    remove(dir, 'packages/ui/src/components/plain.tsx');
    assert.equal(sinceMain(web).affected, false);
  });

  const run = (args: string[]) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env: { ...process.env, GITHUB_OUTPUT: '' } });

  test('hash and affected print the warning', () => {
    const { web } = monorepo();
    const hash = run(['hash', '-C', web]);
    assert.equal(hash.status, 0);
    assert.match(hash.stderr, /byakugan: warning: .*could not run Tailwind \(boom\)/);
    assert.match(hash.stdout, /^[0-9a-f]{64}\n$/, 'stdout stays the fingerprint');
    const result = run(['affected', '--base', 'main', '-C', web]);
    assert.match(result.stdout + result.stderr, /could not run Tailwind \(boom\)/);
  });

  test('hash prints no warning when Tailwind runs', () => {
    const dir = tailwind4(app(plain({ 'package.json': { name: 'styled', devDependencies: { tailwindcss: '*' } }, 'src/main.ts': "import './app.css';\n", 'src/app.css': '@import "tailwindcss";\n' })));
    const hash = run(['hash', '-C', dir]);
    assert.equal(hash.stderr, '');
  });
});

describe('Tailwind v4 skips stylesheets when it scans', () => {
  const files = plain({
    'package.json': { name: 'styled', devDependencies: { tailwindcss: '*' } },
    'src/main.ts': "import './app.css';\ndocument.body.className = 'flex';\n",
    'src/app.css': '@import "tailwindcss";\n@utility glass { backdrop-filter: blur(4px); }\n',
    'src/legacy.css': '.legacy { color: red; }\n',
    'src/unused.ts': "export const banner = ['quiet words'];\n",
  });

  test('a utility the root stylesheet defines counts once a scanned file uses it', () => {
    const dir = tailwind4(app(files, { repo: true }));
    edit(dir, 'src/unused.ts', s => s.replace('quiet words', 'glass'));
    assert.deepEqual(reasonKeys(dir), ['src/app.css#<tailwind>']);
  });

  test('a class named in a stylesheet nobody imports is not affected', () => {
    const dir = tailwind4(app(files, { repo: true }));
    edit(dir, 'src/legacy.css', s => `/* skew-y-12 */\n${s}`);
    assert.equal(sinceMain(dir).affected, false);
  });
});

describe('Tailwind v3 in Vite', () => {
  const vite = (files: Record<string, string | object>) =>
    tailwind3(
      app(
        {
          'package.json': { name: 'spa', type: 'module', devDependencies: { vite: '5.4.0', tailwindcss: '3.4.17' } },
          'vite.config.js': 'export default {};\n',
          'index.html': '<script type="module" src="/src/main.ts"></script>\n',
          '.gitignore': 'node_modules/\n',
          'postcss.config.cjs': 'module.exports = { plugins: { tailwindcss: {} } };\n',
          'tailwind.config.cjs': "module.exports = { content: ['./index.html', './src/**/*.ts'] };\n",
          'src/main.ts': "import './app.css';\n",
          'src/buttons.css': '@layer components {\n  .btn-primary { color: red; }\n}\n',
          'src/unused.ts': "export const banner = ['quiet words'];\n",
          ...files,
        },
        { repo: true }
      )
    );

  // Vite runs its own postcss-import before the PostCSS config's plugins.
  for (const [name, css] of [
    ['a relative @import', '@import "./buttons.css";\n@tailwind base;\n@tailwind components;\n@tailwind utilities;\n'],
    ['Tailwind layer imports', '@import "tailwindcss/base";\n@import "tailwindcss/components";\n@import "./buttons.css";\n@import "tailwindcss/utilities";\n'],
    ['an unquoted url() @import', '@import url(./buttons.css);\n@tailwind base;\n@tailwind components;\n@tailwind utilities;\n'],
    ['an @import from the project root', '@import "/src/buttons.css";\n@tailwind base;\n@tailwind components;\n@tailwind utilities;\n'],
    ['an unquoted url() @import from the project root', '@import url(/src/buttons.css);\n@tailwind base;\n@tailwind components;\n@tailwind utilities;\n'],
  ]) {
    test(`${name}: a component class from the imported file counts`, () => {
      const dir = vite({ 'src/app.css': css });
      assert.deepEqual(analyze({ cwd: dir }).warnings, []);
      edit(dir, 'src/unused.ts', s => s.replace('quiet words', 'btn-secondary'));
      assert.equal(sinceMain(dir).affected, false, 'a class nobody defines');
      edit(dir, 'src/unused.ts', s => s.replace('btn-secondary', 'btn-primary'));
      assert.deepEqual(reasonKeys(dir), ['src/app.css#<tailwind>']);
    });
  }

  // The worker inlines the file, so the fingerprint moves. The graph never reads it, and the
  // base-side Tailwind run reads it from disk, so git mode sees both sides alike.
  test('an unquoted url() @import from the project root: editing the imported file is affected', () => {
    const dir = vite({ 'src/main.ts': "import './app.css';\nexport const c = 'btn-primary';\n", 'src/app.css': '@import url(/src/buttons.css);\n@tailwind base;\n@tailwind components;\n@tailwind utilities;\n' });
    const before = fingerprint(dir);
    edit(dir, 'src/buttons.css', s => s.replace('red', 'blue'));
    assert.notEqual(fingerprint(dir), before);
    assert.equal(sinceMain(dir).affected, true);
  });
});

describe('an @import from the project root', () => {
  const files = plain({
    'src/main.ts': "import './app.css';\n",
    'src/app.css': '@import "/src/theme.css";\n.app { color: red; }\n',
    'src/theme.css': '.theme { color: red; }\n',
    'src/other.css': '.other { color: red; }\n',
  });

  test('editing the file it names is affected', () => {
    const dir = app(files, { repo: true });
    edit(dir, 'src/theme.css', s => s.replace('red', 'blue'));
    assert.deepEqual(reasonKeys(dir), ['src/theme.css']);
  });

  test('editing a stylesheet it does not name is not affected', () => {
    const dir = app(files, { repo: true });
    edit(dir, 'src/other.css', s => s.replace('red', 'blue'));
    assert.equal(sinceMain(dir).affected, false);
  });

  test('editing the file an unquoted url() @import names is affected', () => {
    const dir = app({ ...files, 'src/app.css': '@import url(/src/theme.css);\n.app { color: red; }\n' }, { repo: true });
    edit(dir, 'src/theme.css', s => s.replace('red', 'blue'));
    assert.deepEqual(reasonKeys(dir), ['src/theme.css']);
  });

  test('editing a stylesheet an unquoted url() @import does not name is not affected', () => {
    const dir = app({ ...files, 'src/app.css': '@import url(/src/theme.css);\n.app { color: red; }\n' }, { repo: true });
    edit(dir, 'src/other.css', s => s.replace('red', 'blue'));
    assert.equal(sinceMain(dir).affected, false);
  });

  // A missing target is recorded as the path the code wrote, `/src/theme`, which no deleted file matches.
  for (const [name, extra, target] of [
    ['an @import without an extension', { 'src/app.css': '@import "/src/theme";\n.app { color: red; }\n' }, 'src/theme.css'],
    ['a Sass @use of a partial', { 'src/main.ts': "import './app.scss';\n", 'src/app.scss': '@use "/src/styles/vars";\n.app { color: vars.$c; }\n', 'src/styles/_vars.scss': '$c: red;\n' }, 'src/styles/_vars.scss'],
  ] as const) {
    test(`deleting the file ${name} from the project root names is affected`, () => {
      const dir = app({ ...files, ...extra }, { repo: true });
      const before = fingerprint(dir);
      remove(dir, target);
      assert.notEqual(fingerprint(dir), before);
      assert.equal(sinceMain(dir).affected, true);
    });

    test(`deleting a stylesheet ${name} from the project root does not name is not affected`, () => {
      const dir = app({ ...files, ...extra }, { repo: true });
      remove(dir, 'src/other.css');
      assert.equal(sinceMain(dir).affected, false);
    });
  }
});

describe('Tailwind v3 root written in Sass', () => {
  /** Stands in for the project's `sass`: inlines `@import 'name'` from `_name.scss` next to the file. */
  const fakeSass = [
    "const { readFileSync } = require('node:fs');",
    "const { dirname, join } = require('node:path');",
    "const inline = file => readFileSync(file, 'utf8').replace(/@import\\s+'([^']+)';/g, (_, name) => inline(join(dirname(file), `_${name}.scss`)));",
    'exports.compile = file => ({ css: inline(file) });',
    '',
  ].join('\n');
  const files = (sass: boolean) =>
    plain({
      'package.json': { name: 'styled', devDependencies: { tailwindcss: '*', sass: '*' } },
      'tailwind.config.js': "module.exports = { content: ['./src/**/*.ts'] };\n",
      'src/main.ts': "import './app.scss';\n",
      'src/app.scss': "@import 'buttons';\n@tailwind base;\n@tailwind components;\n@tailwind utilities;\n",
      'src/_buttons.scss': '@layer components {\n  .btn-primary { color: red; }\n}\n',
      'src/unused.ts': "export const banner = ['quiet words'];\n",
      ...(sass ? pkg('sass', { main: 'index.js' }, { 'index.js': fakeSass }) : {}),
    });

  test('a component class from a Sass partial counts, a class nobody defines does not', () => {
    const dir = tailwind3(app(files(true), { repo: true }));
    assert.deepEqual(analyze({ cwd: dir }).warnings, []);
    edit(dir, 'src/unused.ts', s => s.replace('quiet words', 'btn-secondary'));
    assert.equal(sinceMain(dir).affected, false);
    edit(dir, 'src/unused.ts', s => s.replace('btn-secondary', 'btn-primary'));
    assert.deepEqual(reasonKeys(dir), ['src/app.scss#<tailwind>']);
  });

  // Sass compiles app.scss in one piece, so the directives in a partial still see _buttons.scss.
  const partialRoot = () =>
    tailwind3(
      app(
        {
          ...files(true),
          'src/app.scss': "@import 'tailwind';\n@import 'buttons';\n",
          'src/_tailwind.scss': '@tailwind base;\n@tailwind components;\n@tailwind utilities;\n',
        },
        { repo: true }
      )
    );

  test('with the directives in a partial, the imported Sass file is the root', () => {
    const dir = partialRoot();
    edit(dir, 'src/unused.ts', s => s.replace('quiet words', 'btn-primary'));
    assert.deepEqual(reasonKeys(dir), ['src/app.scss#<tailwind>']);
  });

  test('with the directives in a partial, a class nobody defines is not affected', () => {
    const dir = partialRoot();
    edit(dir, 'src/unused.ts', s => s.replace('quiet words', 'btn-secondary'));
    assert.equal(sinceMain(dir).affected, false);
  });

  // Sass leaves `@import "./tw.css"` in place, and the bundler compiles tw.css on its own. The
  // worker compiles only app.scss's Sass output, so the directives in tw.css never run.
  const plainImport = () =>
    tailwind3(
      app(
        {
          ...files(true),
          'src/app.scss': '@import "./tw.css";\n.app { color: red; }\n',
          'src/tw.css': '@tailwind base;\n@tailwind components;\n@tailwind utilities;\n',
        },
        { repo: true }
      )
    );

  test('with the directives in a plain CSS file it imports, a utility in a file nobody imports is affected', () => {
    const dir = plainImport();
    const before = fingerprint(dir);
    edit(dir, 'src/unused.ts', s => s.replace('quiet words', 'flex'));
    assert.notEqual(fingerprint(dir), before);
    assert.equal(sinceMain(dir).affected, true);
  });

  test('with the directives in a plain CSS file it imports, words that are no utility are not affected', () => {
    const dir = plainImport();
    edit(dir, 'src/unused.ts', s => s.replace('quiet words', 'other words'));
    assert.equal(sinceMain(dir).affected, false);
  });

  test('without sass installed, it falls back with a warning', () => {
    const dir = tailwind3(app(files(false)));
    const graph = analyze({ cwd: dir });
    assert.ok(graph.warnings.some(w => w.includes('could not run Tailwind')), graph.warnings.join('\n'));
    const before = graph.fingerprint();
    edit(dir, 'src/unused.ts', s => s.replace('quiet words', 'other words'));
    assert.notEqual(fingerprint(dir), before);
  });
});

describe('Sass additionalData', () => {
  const vite = (main: string) =>
    app(
      {
        'package.json': { name: 'spa', type: 'module', devDependencies: { vite: '7.0.0', sass: '1.80.0' } },
        'vite.config.ts': "export default {\n  css: { preprocessorOptions: { scss: { additionalData: '@use \"@/styles/vars\" as *;' } } },\n};\n",
        'tsconfig.json': { compilerOptions: { baseUrl: '.', paths: { '@/*': ['./src/*'] } } },
        'index.html': '<script type="module" src="/src/main.ts"></script>\n',
        '.gitignore': 'node_modules/\n',
        'src/main.ts': main,
        'src/card.module.scss': '.card { color: $brand; }\n',
        'src/app.css': '.app { color: red; }\n',
        'src/styles/_vars.scss': '$brand: red;\n',
        'src/styles/_other.scss': '$other: red;\n',
      },
      { repo: true }
    );

  test('the partial it loads counts for every Sass file, a sibling partial does not', () => {
    const dir = vite("import styles from './card.module.scss';\ndocument.body.className = styles.card;\n");
    edit(dir, 'src/styles/_other.scss', s => s.replace('red', 'blue'));
    assert.equal(sinceMain(dir).affected, false);
    git(dir, 'checkout', '-q', '.');
    edit(dir, 'src/styles/_vars.scss', s => s.replace('red', 'blue'));
    assert.deepEqual(reasonKeys(dir), ['src/styles/_vars.scss']);
  });

  test('deleting the partial it loads is affected', () => {
    const dir = vite("import styles from './card.module.scss';\ndocument.body.className = styles.card;\n");
    remove(dir, 'src/styles/_vars.scss');
    assert.equal(sinceMain(dir).affected, true);
  });

  test('a Sass built-in module next to it is not an unresolved import', () => {
    const dir = vite("import styles from './card.module.scss';\ndocument.body.className = styles.card;\n");
    edit(dir, 'vite.config.ts', s => s.replace('@use "@/styles', '@use "sass:math"; @use "@/styles'));
    git(dir, 'commit', '-qam', 'sass:math');
    assert.deepEqual(analyze({ cwd: dir }).unresolved, []);
    edit(dir, 'src/styles/_other.scss', s => s.replace('red', 'blue'));
    assert.equal(sinceMain(dir).affected, false);
  });

  // Sass 1.71 resolves `pkg:` URLs through node_modules. Before EXTERNAL_URL they failed closed as unresolved.
  test('a Sass pkg: URL counts the package stylesheet', () => {
    const dir = app(
      plain({
        'package.json': { name: 'styled', dependencies: { bootstrap: '5.0.0' } },
        'src/main.ts': "import './app.scss';\n",
        'src/app.scss': '@use "pkg:bootstrap/scss/grid";\n.app { color: red; }\n',
        ...pkg('bootstrap', { version: '5.0.0' }, { 'scss/_grid.scss': '.row { display: flex; }\n' }),
      })
    );
    const before = fingerprint(dir);
    edit(dir, 'node_modules/bootstrap/scss/_grid.scss', s => s.replace('flex', 'grid'));
    assert.notEqual(fingerprint(dir), before);
  });

  test('a Sass built-in module in a stylesheet is not followed', () => {
    const dir = app(plain({ 'src/main.ts': "import './app.scss';\n", 'src/app.scss': '@use "sass:math";\n.app { width: math.div(1, 2); }\n' }));
    const graph = analyze({ cwd: dir });
    assert.deepEqual(graph.unresolved, []);
    assert.deepEqual(graph.warnings, []);
  });

  test('an app with only plain CSS does not depend on it', () => {
    const dir = vite("import './app.css';\n");
    edit(dir, 'src/styles/_vars.scss', s => s.replace('red', 'blue'));
    assert.equal(sinceMain(dir).affected, false);
  });

  test('prependData in next.config counts too', () => {
    const dir = app(
      {
        'package.json': { name: 'web', dependencies: { next: '15.0.0', react: '19.0.0', sass: '1.80.0' } },
        'next.config.js': "module.exports = { sassOptions: { includePaths: ['styles'], prependData: '@import \"variables\";' } };\n",
        '.gitignore': 'node_modules/\n',
        'app/page.tsx': "import styles from './page.module.scss';\nexport default function Page() { return <div className={styles.hero} />; }\n",
        'app/page.module.scss': '.hero { color: $brand; }\n',
        'styles/_variables.scss': '$brand: blue;\n',
        'styles/_spacing.scss': '$gap: 4px;\n',
      },
      { repo: true }
    );
    edit(dir, 'styles/_spacing.scss', s => s.replace('4px', '8px'));
    assert.equal(sinceMain(dir).affected, false);
    edit(dir, 'styles/_variables.scss', s => s.replace('blue', 'red'));
    assert.deepEqual(reasonKeys(dir), ['styles/_variables.scss']);
  });
});

describe('url() and @value targets', () => {
  const files = plain({
    'tsconfig.json': { compilerOptions: { baseUrl: '.', paths: { '@/*': ['./src/*'] } } },
    'src/main.ts': "import './app.css';\nimport styles from './button.module.css';\ndocument.body.className = styles.btn;\n",
    'src/app.css': '.hero { background: url("@/assets/hero.png"); }\n',
    'src/assets/hero.png': 'PNG1',
    'src/assets/spare.png': 'PNG2',
    'src/button.module.css': '@value colors: "./colors.css";\n@value font: "Inter";\n@value primary from colors;\n.btn { color: primary; font-family: font; }\n',
    'src/colors.css': '@value primary: red;\n',
    'src/spare.css': '@value spare: red;\n',
  });

  test('an asset behind a tsconfig alias counts, a sibling asset does not', () => {
    const dir = app(files, { repo: true });
    write(dir, 'src/assets/spare.png', 'PNG3');
    assert.equal(sinceMain(dir).affected, false);
    write(dir, 'src/assets/hero.png', 'PNG3');
    assert.deepEqual(reasonKeys(dir), ['src/assets/hero.png']);
  });

  test('deleting an asset behind a tsconfig alias is affected', () => {
    const dir = app(files, { repo: true });
    remove(dir, 'src/assets/hero.png');
    assert.equal(sinceMain(dir).affected, true);
  });

  test('deleting a sibling asset is not affected', () => {
    const dir = app(files, { repo: true });
    remove(dir, 'src/assets/spare.png');
    assert.equal(sinceMain(dir).affected, false);
  });

  // `@import "@/theme.css"` with no tsconfig alias fails closed as an unresolved import. url() does not.
  test('an asset behind an alias tsconfig does not name fails closed', () => {
    const dir = app({ ...files, 'tsconfig.json': { compilerOptions: {} } }, { repo: true });
    write(dir, 'src/assets/hero.png', 'PNG3');
    assert.equal(sinceMain(dir).affected, true);
  });

  test('an asset behind an alias tsconfig names is not an unresolved import', () => {
    const dir = app(files, { repo: true });
    assert.deepEqual(analyze({ cwd: dir }).unresolved, []);
  });

  /** `@/*` maps to src/* first and fallback/* second, as tsconfig paths and bundlers try them. */
  const twoTargets = () =>
    app(
      {
        ...files,
        'tsconfig.json': { compilerOptions: { paths: { '@/*': ['./src/*', './fallback/*'] } } },
        'fallback/assets/hero.png': 'PNG-fallback',
      },
      { repo: true }
    );

  test('deleting an asset so that its alias falls back to the second target is affected', () => {
    const dir = twoTargets();
    const before = fingerprint(dir);
    remove(dir, 'src/assets/hero.png');
    assert.notEqual(fingerprint(dir), before);
    assert.equal(sinceMain(dir).affected, true);
  });

  test('deleting the second target while the first one answers is not affected', () => {
    const dir = twoTargets();
    remove(dir, 'fallback/assets/hero.png');
    assert.equal(sinceMain(dir).affected, false);
  });

  test('a path named by @value counts, a plain string value is not a path', () => {
    const dir = app(files, { repo: true });
    assert.deepEqual(analyze({ cwd: dir }).unresolved, [], '"Inter" is not a file');
    edit(dir, 'src/spare.css', s => s.replace('red', 'blue'));
    assert.equal(sinceMain(dir).affected, false);
    edit(dir, 'src/colors.css', s => s.replace('red', 'blue'));
    assert.deepEqual(reasonKeys(dir), ['src/colors.css']);
  });
});

describe('?url of a script', () => {
  const files = {
    'package.json': { name: 'spa', type: 'module', devDependencies: { vite: '7.0.0' } },
    'vite.config.ts': 'export default {};\n',
    'index.html': '<script type="module" src="/src/main.ts"></script>\n',
    '.gitignore': 'node_modules/\n',
    'src/main.ts': "import worklet from './worklet.js?url';\nimport Counter from './counter.ts?worker';\nexport const run = () => [worklet, new Counter()];\n",
    'src/worklet.js': "// paints a border\nimport { width } from './width.js';\nregisterPaint('border', class { paint() { return width; } });\n",
    'src/width.js': 'export const width = 2;\n',
    'src/counter.ts': "// counts messages\nimport { width } from './width.js';\nlet count = 0;\nself.onmessage = () => postMessage((count += width));\n",
  };

  test('a comment in a script imported with ?url is affected, since Vite emits it as is', () => {
    const dir = app(files, { repo: true });
    edit(dir, 'src/worklet.js', s => s.replace('paints a border', 'paints the border'));
    assert.deepEqual(reasonKeys(dir), ['src/worklet.js#<raw>']);
  });

  test('a comment in a script imported with ?worker is not affected, since Vite bundles it', () => {
    const dir = app(files, { repo: true });
    edit(dir, 'src/counter.ts', s => s.replace('counts messages', 'counts the messages'));
    assert.equal(sinceMain(dir).affected, false);
  });
});

describe('.gitignore and Tailwind', () => {
  test('a .gitignore change is affected with a Tailwind v4 root', () => {
    const dir = tailwind4(
      app(
        plain({
          'package.json': { name: 'styled', devDependencies: { tailwindcss: '*' } },
          'src/main.ts': "import './app.css';\n",
          'src/app.css': '@import "tailwindcss";\n',
          'src/legacy/old.ts': "export const old = 'skew-y-12';\n",
        }),
        { repo: true }
      )
    );
    edit(dir, '.gitignore', s => `${s}src/legacy/\n`);
    assert.deepEqual(reasonKeys(dir), ['.gitignore']);
  });

  test('a .gitignore change is not affected with only a v3 root, whose globs ignore it', () => {
    const dir = tailwind3(
      app(
        plain({
          'package.json': { name: 'styled', devDependencies: { tailwindcss: '*' } },
          'tailwind.config.js': "module.exports = { content: ['./src/**/*.ts'] };\n",
          'src/main.ts': "import './app.css';\n",
          'src/app.css': '@tailwind utilities;\n',
          'src/legacy/old.ts': "export const old = 'skew-y-12';\n",
        }),
        { repo: true }
      )
    );
    edit(dir, '.gitignore', s => `${s}src/legacy/\n`);
    assert.equal(sinceMain(dir).affected, false);
  });
});

describe('stylesheet comments', () => {
  test('a stylesheet full of unclosed comments is read in linear time', () => {
    const dir = app(plain({ 'src/main.ts': "import './app.css';\n", 'src/app.css': `.a { color: red; }\n${'/* '.repeat(200_000)}` }));
    const start = Date.now();
    analyze({ cwd: dir });
    assert.ok(Date.now() - start < 5000, `took ${Date.now() - start}ms`);
  });

  test('an @import after a closed comment still counts, one inside an unclosed comment does not', () => {
    const dir = app(
      plain({
        'src/main.ts': "import './app.css';\n",
        'src/app.css': "/* old */ @import './tokens.css';\n/* @import './draft.css';\n",
        'src/tokens.css': ':root { --c: red; }\n',
        'src/draft.css': ':root { --d: red; }\n',
      }),
      { repo: true }
    );
    edit(dir, 'src/draft.css', s => s.replace('red', 'blue'));
    assert.equal(sinceMain(dir).affected, false);
    edit(dir, 'src/tokens.css', s => s.replace('red', 'blue'));
    assert.deepEqual(reasonKeys(dir), ['src/tokens.css']);
  });
});
