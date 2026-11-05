import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { affected, analyze, createManifest, formatAffected, formatChain, loadProject } from '../src/index.ts';
import { commitAll, edit, fixture, git, initRepo, write } from './helpers.ts';

/** The monorepo fixture with @acme/ui linked into node_modules the way npm workspaces do it. */
const monorepo = (options: { git?: boolean } = {}) => {
  const dir = fixture('monorepo');
  mkdirSync(join(dir, 'node_modules/@acme'), { recursive: true });
  symlinkSync('../../packages/ui', join(dir, 'node_modules/@acme/ui'));
  if (options.git !== false) {
    write(dir, '.gitignore', 'node_modules/\n');
    initRepo(dir);
  }
  return { dir, web: join(dir, 'apps/web') };
};

const sinceMain = (web: string) => affected({ cwd: web, base: 'main' });

describe('Next.js project detection', () => {
  const { web } = monorepo({ git: false });
  const project = loadProject({ cwd: web });

  test('finds App Router entries, config files and public assets', () => {
    const rel = (f: string) => f.slice(web.length + 1);
    assert.equal(project.framework, 'next');
    assert.deepEqual(project.entries.map(rel), [
      'app/api/health/route.ts',
      'app/dashboard/page.tsx',
      'app/layout.tsx',
      'app/page.tsx',
      'next.config.ts',
    ]);
    assert.ok(project.inputs.map(rel).includes('public/logo.svg'));
    assert.deepEqual(project.packages, ['next', 'react']);
  });

  test('uses the workspace root for keys outside git', () => {
    const keys = [...analyze({ cwd: web }).live.keys()];
    assert.ok(keys.includes('packages/ui/src/Button.tsx#Button'));
    assert.ok(keys.includes('apps/web/app/globals.css'));
    assert.ok(keys.includes('apps/web/components/Chart.tsx#Chart'), 'next/dynamic(() => import()) target');
    assert.ok(keys.includes('npm:next#<version>'));
    assert.ok(!keys.some(k => k.startsWith('apps/web/components/Unused.tsx')));
  });
});

describe('affected since a git ref', () => {
  test('a change to an unused component in a workspace package does not affect the app', () => {
    const { dir, web } = monorepo();
    edit(dir, 'packages/ui/src/Modal.tsx', s => s.replace("cx('modal')", "cx('modal', 'open')"));
    const result = sinceMain(web);
    assert.equal(result.affected, false);
    assert.deepEqual(result.ignored.map(i => i.path), ['packages/ui/src/Modal.tsx']);
  });

  test('a change to the used component affects the app and explains the import chain', () => {
    const { dir, web } = monorepo();
    edit(dir, 'packages/ui/src/Button.tsx', s => s.replace("cx('btn')", "cx('btn', 'primary')"));
    const result = sinceMain(web);
    assert.equal(result.affected, true);
    assert.equal(result.reasons.length, 1);
    const [reason] = result.reasons;
    assert.equal(reason.key, 'packages/ui/src/Button.tsx#Button');
    const chain = formatChain(analyze({ cwd: web }), reason.chain, '').map(l => l.replace('└ ', ''));
    assert.equal(chain[0], 'apps/web/app/page.tsx (entry)');
    assert.ok(chain.includes('packages/ui/src/index.ts › Button'));
    assert.equal(chain.at(-1), 'packages/ui/src/Button.tsx#Button');
  });

  test('a shared helper used through the component affects the app', () => {
    const { dir, web } = monorepo();
    edit(dir, 'packages/ui/src/cx.ts', s => s.replace('filter(Boolean)', 'filter(n => n.length > 0)'));
    assert.equal(sinceMain(web).affected, true);
  });

  test('adding a component to the barrel does not affect the app', () => {
    const { dir, web } = monorepo();
    write(dir, 'packages/ui/src/Tabs.tsx', 'export const Tabs = () => null;\n');
    edit(dir, 'packages/ui/src/index.ts', s => `${s}export { Tabs } from './Tabs';\n`);
    const result = sinceMain(web);
    assert.equal(result.affected, false, formatAffected(analyze({ cwd: web }), result));
  });

  test('committed changes on a branch are compared with the merge base', () => {
    const { dir, web } = monorepo();
    git(dir, 'checkout', '-q', '-b', 'feature');
    edit(dir, 'apps/web/components/Unused.tsx', s => s.replace('return null', 'return 1'));
    commitAll(dir, 'unused');
    assert.equal(sinceMain(web).affected, false);
    edit(dir, 'apps/web/components/Hero.tsx', s => s.replace('Hello', 'Hi'));
    commitAll(dir, 'hero');
    const result = sinceMain(web);
    assert.equal(result.affected, true);
    assert.deepEqual(result.reasons.map(r => r.key), ['apps/web/components/Hero.tsx#Hero']);
  });

  test('a dynamically imported component counts', () => {
    const { dir, web } = monorepo();
    edit(dir, 'apps/web/components/Chart.tsx', s => s.replace('<svg />', '<svg width={10} />'));
    assert.equal(sinceMain(web).affected, true);
  });

  test('a stylesheet pulled in by a relative @import counts', () => {
    const { dir, web } = monorepo();
    edit(dir, 'apps/web/app/theme.css', s => s.replace('#3b82f6', '#ef4444'));
    assert.deepEqual(sinceMain(web).reasons.map(r => r.key), ['apps/web/app/theme.css']);
  });

  test('Sass partials resolve through @use', () => {
    const { dir, web } = monorepo();
    write(dir, 'apps/web/app/styles/_tokens.scss', '$brand: blue;\n');
    write(dir, 'apps/web/app/styles/main.scss', "@use './tokens';\n");
    edit(dir, 'apps/web/app/layout.tsx', s => `import './styles/main.scss';\n${s}`);
    commitAll(dir, 'sass');
    edit(dir, 'apps/web/app/styles/_tokens.scss', s => s.replace('blue', 'red'));
    assert.deepEqual(sinceMain(web).reasons.map(r => r.key), ['apps/web/app/styles/_tokens.scss']);
  });

  test('public assets and config inputs count', () => {
    const { dir, web } = monorepo();
    edit(dir, 'apps/web/public/logo.svg', s => s.replace('></svg>', '><rect /></svg>'));
    const result = sinceMain(web);
    assert.deepEqual(result.reasons.map(r => [r.kind, r.key]), [['input', 'apps/web/public/logo.svg']]);
  });

  test('a lockfile bump of a package the app does not use is ignored', () => {
    const { dir, web } = monorepo();
    edit(dir, 'package-lock.json', s => s.replace('"version": "1.3.0"', '"version": "1.3.1"'));
    assert.equal(sinceMain(web).affected, false);
  });

  test('a lockfile bump of a used package affects the app (package-level in git mode)', () => {
    const { dir, web } = monorepo();
    edit(dir, 'package-lock.json', s => s.replace('"version": "4.17.21"', '"version": "4.17.22"'));
    const result = sinceMain(web);
    assert.equal(result.affected, true);
    assert.equal(result.reasons[0].kind, 'dependency');
    assert.equal(result.reasons[0].key, 'lodash');
  });

  test('deleting a file the app imports is a change that reaches it', () => {
    const { dir, web } = monorepo();
    rmSync(join(dir, 'apps/web/components/Hero.tsx'));
    const result = sinceMain(web);
    assert.equal(result.affected, true);
    assert.equal(result.reasons[0].kind, 'unresolved');
  });

  test('changes outside the app and its dependencies are ignored', () => {
    const { dir, web } = monorepo();
    write(dir, 'README.md', '# acme\n');
    write(dir, 'apps/docs/index.ts', 'export {};\n');
    assert.equal(sinceMain(web).affected, false);
  });
});

describe('affected since a manifest', () => {
  test('editing lodash filter.js in node_modules does not affect an app that uses partition', () => {
    const { dir, web } = monorepo({ git: false });
    const base = createManifest(analyze({ cwd: web }));
    edit(dir, 'node_modules/lodash/filter.js', s => s.replace('array.filter(predicate)', 'Array.prototype.filter.call(array, predicate)'));
    edit(dir, 'package-lock.json', s => s.replace('"version": "4.17.21"', '"version": "4.17.22"'));
    assert.equal(affected({ cwd: web, baseManifest: base }).affected, false);
  });

  test('editing a file partition depends on affects the app', () => {
    const { dir, web } = monorepo({ git: false });
    const base = createManifest(analyze({ cwd: web }));
    edit(dir, 'node_modules/lodash/_createAggregator.js', s => s.replace('i++', 'i += 1'));
    const result = affected({ cwd: web, baseManifest: base });
    assert.equal(result.affected, true);
    assert.deepEqual(result.reasons.map(r => r.key), ['npm:lodash/_createAggregator.js']);
  });

  test('a framework version bump affects the app', () => {
    const { dir, web } = monorepo({ git: false });
    const base = createManifest(analyze({ cwd: web }));
    edit(dir, 'node_modules/next/package.json', s => s.replace('15.0.0', '15.0.1'));
    const result = affected({ cwd: web, baseManifest: base });
    assert.deepEqual(result.reasons.map(r => r.key), ['npm:next#<version>']);
  });
});

describe('git mode: code that only the base side has', () => {
  /** src/main.ts runs and uses `price` from src/lib.ts; `legacy` is never used. */
  const app = () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'byakugan-removed-')));
    write(dir, 'package.json', '{ "name": "app", "type": "module" }\n');
    write(dir, 'byakugan.json', '{ "entry": ["src/main.ts"] }\n');
    write(dir, 'src/main.ts', "import './polyfill';\nimport { price } from './lib';\n\nconsole.log(price(1));\n");
    write(dir, 'src/polyfill.ts', "globalThis.ready = true;\n");
    write(dir, 'src/lib.ts', "import './register';\n\nconst rate = 2;\nexport const price = (n: number) => n * rate;\nexport const legacy = () => 'old';\n");
    write(dir, 'src/register.ts', "export {};\n");
    initRepo(dir);
    return dir;
  };
  const since = (dir: string) => affected({ cwd: dir, base: 'main' });

  test('removing a bare import from a module that runs is affected', () => {
    const dir = app();
    edit(dir, 'src/main.ts', s => s.replace("import './polyfill';\n", ''));
    const result = since(dir);
    assert.equal(result.affected, true);
    assert.equal(result.reasons[0].key, 'src/main.ts#<module>');
  });

  test('removing the only effect of a module that runs is affected', () => {
    const dir = app();
    edit(dir, 'src/lib.ts', s => s.replace("import './register';\n", ''));
    const result = since(dir);
    assert.equal(result.affected, true);
    assert.deepEqual(result.reasons.map(r => [r.key, r.detail]), [['src/lib.ts#<module>', 'removed']]);
  });

  test('removing a declaration live code still names is affected, removing an unused one is not', () => {
    const dir = app();
    edit(dir, 'src/lib.ts', s => s.replace("export const legacy = () => 'old';\n", ''));
    assert.equal(since(dir).affected, false);
    edit(dir, 'src/lib.ts', s => s.replace('const rate = 2;\n', ''));
    const result = since(dir);
    assert.equal(result.affected, true);
    assert.deepEqual(result.reasons.map(r => [r.key, r.detail]), [['src/lib.ts#rate', 'removed']]);
  });
});

describe('git mode: CSS imports', () => {
  /** src/main.ts imports a.css and b.css in that order; c.css exists but nothing imports it. */
  const app = () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'byakugan-css-')));
    write(dir, 'package.json', '{ "name": "app", "type": "module", "dependencies": { "anim": "1.0.0" } }\n');
    write(dir, 'byakugan.json', '{ "entry": ["src/main.ts"] }\n');
    write(dir, '.gitignore', 'node_modules/\n');
    write(dir, 'src/main.ts', "import './a.css';\nimport './b.css';\nimport 'anim';\nimport type { Props } from './typed';\n\nexport const run = (p: Props) => p;\n");
    write(dir, 'src/a.css', '.a { color: red }\n');
    write(dir, 'src/b.css', '.b { color: blue }\n');
    write(dir, 'src/c.css', '.c { color: green }\n');
    write(dir, 'src/typed.ts', "import './typed.css';\nexport type Props = { id: string };\n");
    write(dir, 'src/typed.css', '.typed { color: gray }\n');
    write(dir, 'node_modules/anim/package.json', '{ "name": "anim", "version": "1.0.0", "exports": { ".": { "style": "./dist/anim.css" } } }');
    write(dir, 'node_modules/anim/dist/anim.css', '.spin { }\n');
    initRepo(dir);
    return dir;
  };
  const since = (dir: string) => affected({ cwd: dir, base: 'main' });

  test('swapping the order of two CSS imports is affected', () => {
    const dir = app();
    edit(dir, 'src/main.ts', s => s.replace("import './a.css';\nimport './b.css';", "import './b.css';\nimport './a.css';"));
    assert.deepEqual(since(dir).reasons.map(r => r.key), ['src/main.ts#<module>']);
  });

  test('a stylesheet nobody imports does not count until an import is added', () => {
    const dir = app();
    edit(dir, 'src/c.css', s => s.replace('green', 'lime'));
    assert.equal(since(dir).affected, false);
    edit(dir, 'src/main.ts', s => s.replace("import './b.css';", "import './b.css';\nimport './c.css';"));
    assert.equal(since(dir).affected, true);
  });

  test('a stylesheet imported by a module reached only through types does not count', () => {
    const dir = app();
    edit(dir, 'src/typed.css', s => s.replace('gray', 'black'));
    assert.equal(since(dir).affected, false);
    edit(dir, 'src/a.css', s => s.replace('red', 'maroon'));
    assert.equal(since(dir).affected, true);
  });

  test('a bare import of a package that exports only a style condition reaches its stylesheet', () => {
    const graph = analyze({ cwd: app() });
    assert.ok(graph.live.has('npm:anim/dist/anim.css'), [...graph.live.keys()].join('\n'));
    assert.deepEqual(graph.unresolved, []);
  });
});
