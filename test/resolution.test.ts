import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, renameSync, symlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, test } from 'node:test';
import { affected, analyze, createManifest, formatAffected, loadProject, type AffectedResult } from '../src/index.ts';
import { diffVersions, parseLockfile } from '../src/lockfile.ts';
import { app, edit, fingerprintOf, initRepo, liveKeys, pkg, write } from './helpers.ts';

const sinceMain = (cwd: string) => affected({ cwd, base: 'main' });

const CLI = join(import.meta.dirname, '../src/cli.ts');
const cli = (...args: string[]) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env: { ...process.env, GITHUB_OUTPUT: '' } });

const writeJson = (dir: string, path: string, value: object) => write(dir, path, `${JSON.stringify(value, null, 2)}\n`);

/** `kind:key` of every reason, for short asserts. */
const reasons = (result: AffectedResult) => result.reasons.map(r => `${r.kind}:${r.key}`);

/** Readable failure message: the formatted result. */
const explain = (cwd: string, result: AffectedResult) => formatAffected(analyze({ cwd }), result);

/** Links `node_modules/<name>` to a workspace directory, the way npm and pnpm workspaces do. */
const link = (dir: string, name: string, target: string) => {
  const at = join(dir, 'node_modules', name);
  mkdirSync(dirname(at), { recursive: true });
  symlinkSync(join(dir, target), at);
};

const rel = (dir: string) => (file: string) => file.slice(dir.length + 1);

/** Moves a file out of the repository: the working tree no longer has it, and nothing is deleted. */
const remove = (dir: string, path: string) => {
  const away = join(`${dir}.removed`, path.replace(/\//g, '_'));
  mkdirSync(dirname(away), { recursive: true });
  renameSync(join(dir, path), away);
};

const NEXT = {
  ...pkg('next', { version: '15.0.0' }, {}),
  'package.json': { name: 'web', dependencies: { next: '15.0.0' } },
};

const VITE = {
  ...pkg('vite', { version: '6.0.0' }, {}),
  'package.json': { name: 'v', devDependencies: { vite: '6.0.0' } },
  'vite.config.ts': 'export default {};\n',
};

describe('unresolved project imports fail closed', () => {
  /** Next.js app whose page imports `~lib/v`. Only `next.config.ts` (which byakugan does not read) names the alias. */
  const turbopackAlias = () =>
    app(
      {
        ...NEXT,
        'tsconfig.json': {},
        'next.config.ts': "export default { turbopack: { resolveAlias: { '~lib': './lib' } } };\n",
        'app/page.tsx': "import { v } from '~lib/v';\nexport default function Page() { return v; }\n",
        'lib/v.ts': "export const v = 'old';\n",
      },
      { repo: true }
    );

  test('an alias byakugan cannot read is affected in git mode and warns', () => {
    const dir = turbopackAlias();
    assert.ok(analyze({ cwd: dir }).warnings.some(w => w.includes('cannot resolve "~lib/v"')));
    edit(dir, 'lib/v.ts', s => s.replace('old', 'new'));
    const result = sinceMain(dir);
    assert.equal(result.affected, true);
    assert.deepEqual(reasons(result), ['unresolved:app/page.tsx -> ~lib/v']);
  });

  test('the same alias in tsconfig paths resolves, so an unused file is not affected', () => {
    const dir = app(
      {
        ...NEXT,
        'tsconfig.json': { compilerOptions: { paths: { '~lib/*': ['./lib/*'] } } },
        'app/page.tsx': "import { v } from '~lib/v';\nexport default function Page() { return v; }\n",
        'lib/v.ts': "export const v = 'old';\n",
        'lib/unused.ts': "export const u = 'old';\n",
      },
      { repo: true }
    );
    assert.deepEqual(analyze({ cwd: dir }).warnings, []);
    edit(dir, 'lib/unused.ts', s => s.replace('old', 'new'));
    const result = sinceMain(dir);
    assert.equal(result.affected, false, explain(dir, result));
    edit(dir, 'lib/v.ts', s => s.replace('old', 'new'));
    assert.deepEqual(reasons(sinceMain(dir)), ['source:lib/v.ts#v']);
  });

  test('an unresolved alias is affected against a manifest of the same graph', () => {
    const dir = turbopackAlias();
    const result = affected({ cwd: dir, baseManifest: createManifest(analyze({ cwd: dir })) });
    assert.equal(result.affected, true);
    assert.deepEqual(reasons(result), ['unresolved:app/page.tsx -> ~lib/v']);
    assert.ok(result.warnings.some(w => w.includes('~lib/v')));
  });

  test('a graph with every import resolved is not affected against its own manifest', () => {
    const dir = app({ ...NEXT, 'tsconfig.json': {}, 'app/page.tsx': "import { v } from '../lib/v';\nexport default function Page() { return v; }\n", 'lib/v.ts': 'export const v = 1;\n' });
    const result = affected({ cwd: dir, baseManifest: createManifest(analyze({ cwd: dir })) });
    assert.equal(result.affected, false, explain(dir, result));
  });

  test('a relative import of a missing file is affected', () => {
    const dir = app({ ...NEXT, 'tsconfig.json': {}, 'app/page.tsx': "import { v } from '../lib/gone';\nexport default function Page() { return v; }\n", 'README.md': 'a\n' }, { repo: true });
    write(dir, 'README.md', 'b\n');
    assert.deepEqual(reasons(sinceMain(dir)), ['unresolved:app/page.tsx -> ../lib/gone']);
  });

  test('a declared npm package that is not installed does not warn and is not affected', () => {
    const dir = app(
      {
        ...NEXT,
        'package.json': { name: 'web', dependencies: { next: '15.0.0', 'not-installed': '1.0.0' } },
        'tsconfig.json': {},
        'app/page.tsx': "import { x } from 'not-installed';\nexport default function Page() { return x; }\n",
        'README.md': 'a\n',
      },
      { repo: true }
    );
    assert.deepEqual(analyze({ cwd: dir }).warnings, []);
    write(dir, 'README.md', 'b\n');
    const result = sinceMain(dir);
    assert.equal(result.affected, false, explain(dir, result));
  });

  test('a # import with no matching package.json imports entry warns, a matching one does not', () => {
    const files = (specifier: string) => ({
      ...NEXT,
      'package.json': { name: 'web', dependencies: { next: '15.0.0' }, imports: { '#util/*': './util/*.ts' } },
      'tsconfig.json': {},
      'app/page.tsx': `import { u } from '${specifier}';\nexport default function Page() { return u; }\n`,
      'util/u.ts': 'export const u = 1;\n',
    });
    assert.deepEqual(analyze({ cwd: app(files('#util/u')) }).warnings, []);
    const warnings = analyze({ cwd: app(files('#util/gone')) }).warnings;
    assert.ok(warnings.some(w => w.includes('cannot resolve "#util/gone"')), warnings.join('\n'));
  });

  test('a missing file in a baseUrl directory warns, a declared package does not', () => {
    const files = (specifier: string) => ({
      ...NEXT,
      'tsconfig.json': { compilerOptions: { baseUrl: '.' } },
      'app/page.tsx': `import { a } from '${specifier}';\nexport default function Page() { return a; }\n`,
      'components/a.ts': 'export const a = 1;\n',
    });
    assert.deepEqual(analyze({ cwd: app(files('components/a')) }).warnings, []);
    assert.ok(analyze({ cwd: app(files('components/gone')) }).warnings.some(w => w.includes('"components/gone"')));
    // A name no package.json declares reads as an alias, even when no such directory exists.
    assert.ok(analyze({ cwd: app(files('nothere/a')) }).warnings.some(w => w.includes('"nothere/a"')));
    const declared = { ...files('nothere/a'), 'package.json': { name: 'web', dependencies: { next: '15.0.0', nothere: '1.0.0' } } };
    assert.deepEqual(analyze({ cwd: app(declared) }).warnings, []);
  });

  test('a linked workspace package whose entry is missing warns, an installed npm package does not', () => {
    const dir = app({
      'package.json': { name: 'root', private: true, workspaces: ['apps/*', 'packages/*'] },
      'apps/web/package.json': { name: 'web', dependencies: { '@acme/ui': '*', broken: '1.0.0' } },
      'apps/web/index.ts': "import { Button } from '@acme/ui';\nexport const b = Button();\n",
      'apps/web/other.ts': "import { x } from 'broken';\nexport const o = x;\n",
      'packages/ui/package.json': { name: '@acme/ui', version: '0.0.0', main: './src/gone.ts' },
      ...pkg('broken', { main: './gone.js' }, {}),
    });
    link(dir, '@acme/ui', 'packages/ui');
    const web = join(dir, 'apps/web');
    assert.ok(analyze({ cwd: web }).warnings.some(w => w.includes('cannot resolve "@acme/ui"')));
    writeJson(dir, 'apps/web/byakugan.json', { entry: ['other.ts'] });
    write(dir, 'apps/web/index.ts', 'export {};\n');
    assert.deepEqual(analyze({ cwd: web }).warnings, []);
  });
});

describe('jsconfig.json', () => {
  /** create-next-app --js: `@/*` in jsconfig.json, no tsconfig.json. */
  const jsApp = () =>
    app(
      {
        ...NEXT,
        'jsconfig.json': { compilerOptions: { paths: { '@/*': ['./src/*'] } } },
        'src/app/page.js': "import { Button } from '@/components/Button';\nexport default function Page() { return Button(); }\n",
        'src/components/Button.js': "export function Button() { return 'old'; }\n",
        'src/components/Unused.js': "export function Unused() { return 'old'; }\n",
      },
      { repo: true }
    );

  test('paths resolve when there is no tsconfig.json, so the aliased file is affected', () => {
    const dir = jsApp();
    assert.deepEqual(analyze({ cwd: dir }).warnings, []);
    edit(dir, 'src/components/Button.js', s => s.replace('old', 'new'));
    assert.deepEqual(reasons(sinceMain(dir)), ['source:src/components/Button.js#Button']);
  });

  test('a file nobody imports next to the aliased one is not affected', () => {
    const dir = jsApp();
    edit(dir, 'src/components/Unused.js', s => s.replace('old', 'new'));
    const result = sinceMain(dir);
    assert.equal(result.affected, false, explain(dir, result));
  });

  test('jsconfig.json is an input, an unrelated JSON file is not', () => {
    const dir = jsApp();
    write(dir, 'components.json', '{}\n');
    const before = fingerprintOf(dir);
    write(dir, 'components.json', '{ "style": "new-york" }\n');
    assert.equal(fingerprintOf(dir), before);
    edit(dir, 'jsconfig.json', s => s.replace('"compilerOptions": {', '"compilerOptions": {\n    "checkJs": true,'));
    assert.notEqual(fingerprintOf(dir), before);
  });
});

describe('tsconfig extends from a package', () => {
  /** create-turbo layout: apps/web extends `@acme/tsconfig/nextjs.json`, a workspace package. */
  const turbo = () => {
    const dir = app({
      'package.json': { name: 'root', private: true, workspaces: ['apps/*', 'packages/*'] },
      'apps/web/package.json': { name: 'web', dependencies: { next: '15.0.0' }, devDependencies: { '@acme/tsconfig': '*' } },
      'apps/web/tsconfig.json': { extends: '@acme/tsconfig/nextjs.json' },
      'apps/web/app/page.tsx': "export default function Page() { return 'page'; }\n",
      'packages/tsconfig/package.json': { name: '@acme/tsconfig', version: '0.0.0' },
      'packages/tsconfig/nextjs.json': { extends: './base.json', compilerOptions: { jsx: 'preserve' } },
      'packages/tsconfig/base.json': { compilerOptions: { strict: true } },
      'packages/tsconfig/react-library.json': { compilerOptions: { jsx: 'react-jsx' } },
      ...pkg('next', { version: '15.0.0' }, {}),
    });
    link(dir, '@acme/tsconfig', 'packages/tsconfig');
    initRepo(dir);
    return { dir, web: join(dir, 'apps/web') };
  };

  test('editing the extended config, or the one it extends, is affected', () => {
    const { dir, web } = turbo();
    edit(dir, 'packages/tsconfig/nextjs.json', s => s.replace('preserve', 'react-jsx'));
    edit(dir, 'packages/tsconfig/base.json', s => s.replace('true', 'false'));
    assert.deepEqual(reasons(sinceMain(web)).sort(), ['input:packages/tsconfig/base.json', 'input:packages/tsconfig/nextjs.json']);
  });

  test('editing another config in the same package is not affected', () => {
    const { dir, web } = turbo();
    edit(dir, 'packages/tsconfig/react-library.json', s => s.replace('react-jsx', 'preserve'));
    const result = sinceMain(web);
    assert.equal(result.affected, false, explain(web, result));
  });

  // tsc fails on an `extends` it cannot find. A relative one is recorded as missing; a package one is not.
  test('deleting the config the app extends by package name is affected', () => {
    const { dir, web } = turbo();
    remove(dir, 'packages/tsconfig/nextjs.json');
    assert.equal(sinceMain(web).affected, true);
  });

  test('deleting another config in the same package is not affected', () => {
    const { dir, web } = turbo();
    remove(dir, 'packages/tsconfig/react-library.json');
    const result = sinceMain(web);
    assert.equal(result.affected, false, explain(web, result));
  });

  test('jsxImportSource from an extended config picks the JSX runtime', () => {
    const dir = app({
      ...VITE,
      'package.json': { name: 'v', devDependencies: { vite: '6.0.0' }, dependencies: { preact: '10.0.0', react: '19.0.0' } },
      ...pkg('preact', { version: '10.0.0', exports: { '.': './index.mjs', './jsx-runtime': './jsx-runtime.mjs' } }, {
        'index.mjs': 'export const h = 1;\n',
        'jsx-runtime.mjs': 'export const jsx = () => 1;\n',
      }),
      ...pkg('react', { version: '19.0.0', exports: { '.': './index.mjs', './jsx-runtime': './jsx-runtime.mjs' } }, {
        'index.mjs': 'export const x = 1;\n',
        'jsx-runtime.mjs': 'export const jsx = () => 1;\n',
      }),
      'tsconfig.json': { extends: './tsconfig.base.json' },
      'tsconfig.base.json': { compilerOptions: { jsx: 'react-jsx', jsxImportSource: 'preact' } },
      'index.html': '<script type="module" src="/src/main.tsx"></script>\n',
      'src/main.tsx': 'export const App = () => <div>hi</div>;\n',
    });
    assert.equal(loadProject({ cwd: dir }).jsxImportSource, 'preact');
    const keys = liveKeys(dir);
    assert.ok(keys.includes('npm:preact/jsx-runtime.mjs#jsx'), keys.join('\n'));
    assert.ok(!keys.some(k => k.startsWith('npm:react/')), keys.join('\n'));
  });
});

describe('React Router and Remix', () => {
  const reactRouter = () =>
    app(
      {
        'package.json': { name: 'rr', dependencies: { 'react-router': '7.0.0' }, devDependencies: { vite: '6.0.0', '@react-router/dev': '7.0.0' } },
        ...pkg('vite', { version: '6.0.0' }, {}),
        ...pkg('@react-router/dev', { version: '7.0.0', exports: { './routes': './routes.js' } }, {
          'routes.js': 'export const index = f => f;\nexport const route = (p, f) => f;\n',
        }),
        'vite.config.ts': 'export default {};\n',
        'react-router.config.ts': 'export default { ssr: true };\n',
        'app/root.tsx': 'export default function Root() { return null; }\n',
        'app/routes.ts': "import { index, route } from '@react-router/dev/routes';\nexport default [index('routes/home.tsx'), route('about', 'pages/about.tsx')];\n",
        'app/routes/home.tsx': "export default function Home() { return 'home'; }\n",
        'app/pages/about.tsx': "export default function About() { return 'about'; }\n",
        'app/pages/draft.tsx': "export default function Draft() { return 'draft'; }\n",
      },
      { repo: true }
    );

  test('detects framework mode and finds root, routes.ts, route modules and config files', () => {
    const dir = reactRouter();
    const project = loadProject({ cwd: dir });
    assert.equal(project.framework, 'react-router');
    assert.deepEqual(project.entries.map(rel(dir)), [
      'app/pages/about.tsx',
      'app/root.tsx',
      'app/routes.ts',
      'app/routes/home.tsx',
      'react-router.config.ts',
      'vite.config.ts',
    ]);
    assert.ok(project.packages.includes('vite'));
  });

  test('a route module, a module routes.ts names, and react-router.config.ts are affected', () => {
    const dir = reactRouter();
    edit(dir, 'app/routes/home.tsx', s => s.replace("'home'", "'Home'"));
    edit(dir, 'app/pages/about.tsx', s => s.replace("'about'", "'About'"));
    edit(dir, 'react-router.config.ts', s => s.replace('true', 'false'));
    assert.deepEqual(reasons(sinceMain(dir)).sort(), [
      'source:app/pages/about.tsx#About',
      'source:app/routes/home.tsx#Home',
      'source:react-router.config.ts#default',
    ]);
  });

  test('a module in app/ that no route names is not affected', () => {
    const dir = reactRouter();
    edit(dir, 'app/pages/draft.tsx', s => s.replace("'draft'", "'Draft'"));
    const result = sinceMain(dir);
    assert.equal(result.affected, false, explain(dir, result));
  });

  test('a Remix app is detected through @remix-run/dev', () => {
    const dir = app({
      'package.json': { name: 'remix', devDependencies: { '@remix-run/dev': '2.0.0', vite: '5.0.0' } },
      'vite.config.ts': 'export default {};\n',
      'app/root.tsx': 'export default function Root() { return null; }\n',
      'app/routes/_index.tsx': 'export default function Index() { return null; }\n',
      'app/utils.ts': 'export const u = 1;\n',
    });
    const project = loadProject({ cwd: dir });
    assert.equal(project.framework, 'react-router');
    assert.deepEqual(project.entries.map(rel(dir)), ['app/root.tsx', 'app/routes/_index.tsx', 'vite.config.ts']);
  });
});

describe('a Vite app whose entries byakugan cannot find', () => {
  test('the CLI exits 2 when only vite.config.ts is an entry, and hashes once index.html names a script', () => {
    const dir = app({ ...VITE, 'src/main.ts': "console.log('main');\n" });
    const missing = cli('hash', '-C', dir);
    assert.equal(missing.status, 2, missing.stdout);
    assert.match(missing.stderr, /No entry files found/);
    write(dir, 'index.html', '<script type="module" src="/src/main.ts"></script>\n');
    const found = cli('hash', '-C', dir);
    assert.equal(found.status, 0, found.stderr);
    assert.match(found.stdout, /^[0-9a-f]{64}$/m);
  });
});

describe('Nx-style app without its own package.json', () => {
  const nx = () => {
    const lock = { lockfileVersion: 3, packages: { '': {}, 'node_modules/vite': { version: '6.0.0' }, 'node_modules/left-pad': { version: '1.0.0' } } };
    const dir = app(
      {
        'package.json': { name: 'org', private: true, devDependencies: { vite: '6.0.0' }, dependencies: { 'left-pad': '1.0.0' } },
        'package-lock.json': lock,
        'nx.json': {},
        ...pkg('vite', { version: '6.0.0' }, {}),
        'apps/web/project.json': { name: 'web' },
        'apps/web/index.html': '<script type="module" src="/src/main.ts"></script>\n',
        'apps/web/vite.config.ts': 'export default {};\n',
        'apps/web/src/main.ts': "console.log('main');\n",
        'apps/web/public/logo.svg': '<svg/>\n',
      },
      { repo: true }
    );
    return { dir, web: join(dir, 'apps/web'), lock };
  };

  test('reads dependencies from the root package.json', () => {
    const { web } = nx();
    const project = loadProject({ cwd: web });
    assert.equal(project.framework, 'vite');
    assert.deepEqual(project.entries.map(rel(web)), ['src/main.ts', 'vite.config.ts']);
    assert.deepEqual(project.packages, ['vite']);
    assert.ok(project.inputs.map(rel(web)).includes('public/logo.svg'));
  });

  test('a vite bump in the root lockfile is affected, a bump of a package the app does not use is not', () => {
    const { dir, web, lock } = nx();
    writeJson(dir, 'package-lock.json', { ...lock, packages: { ...lock.packages, 'node_modules/left-pad': { version: '1.0.1' } } });
    const unused = sinceMain(web);
    assert.equal(unused.affected, false, explain(web, unused));
    writeJson(dir, 'package-lock.json', { ...lock, packages: { ...lock.packages, 'node_modules/vite': { version: '6.1.0' } } });
    assert.deepEqual(reasons(sinceMain(web)), ['dependency:vite']);
  });
});

describe('workspace package manifests and tsconfig', () => {
  /** apps/web imports @acme/ui. @acme/docs sits in the same workspace and nothing imports it. */
  const mono = () => {
    const dir = app({
      'package.json': { name: 'root', private: true, workspaces: ['apps/*', 'packages/*'] },
      'apps/web/package.json': { name: 'web', dependencies: { '@acme/ui': '*' } },
      'apps/web/index.ts': "import { Button } from '@acme/ui';\nexport const b = Button();\n",
      'packages/ui/package.json': { name: '@acme/ui', version: '0.0.0', exports: { '.': './src/a.ts' } },
      'packages/ui/tsconfig.json': { compilerOptions: { paths: { '~/*': ['./src/v1/*'] } } },
      'packages/ui/src/a.ts': "import { cx } from '~/cx';\nexport const Button = () => cx();\n",
      'packages/ui/src/b.ts': "export const Button = () => 'b';\n",
      'packages/ui/src/v1/cx.ts': "export const cx = () => 'v1';\n",
      'packages/ui/src/v2/cx.ts': "export const cx = () => 'v2';\n",
      'packages/docs/package.json': { name: '@acme/docs', version: '0.0.0', main: './index.ts' },
      'packages/docs/tsconfig.json': { compilerOptions: { strict: true } },
      'packages/docs/index.ts': 'export const d = 1;\n',
    });
    link(dir, '@acme/ui', 'packages/ui');
    link(dir, '@acme/docs', 'packages/docs');
    initRepo(dir);
    return { dir, web: join(dir, 'apps/web') };
  };

  test('retargeting exports in a reached workspace package is affected', () => {
    const { dir, web } = mono();
    edit(dir, 'packages/ui/package.json', s => s.replace('./src/a.ts', './src/b.ts'));
    assert.deepEqual(reasons(sinceMain(web)), ['input:packages/ui/package.json']);
  });

  test('editing package.json of a workspace package the app does not reach is not affected', () => {
    const { dir, web } = mono();
    edit(dir, 'packages/docs/package.json', s => s.replace('./index.ts', './other.ts'));
    const result = sinceMain(web);
    assert.equal(result.affected, false, explain(web, result));
  });

  test('changing paths in a reached workspace package tsconfig is affected', () => {
    const { dir, web } = mono();
    assert.ok(liveKeys(web).includes('packages/ui/src/v1/cx.ts#cx'));
    edit(dir, 'packages/ui/tsconfig.json', s => s.replace('v1', 'v2'));
    assert.deepEqual(reasons(sinceMain(web)), ['input:packages/ui/tsconfig.json']);
  });

  test('editing tsconfig of a workspace package the app does not reach is not affected', () => {
    const { dir, web } = mono();
    edit(dir, 'packages/docs/tsconfig.json', s => s.replace('true', 'false'));
    const result = sinceMain(web);
    assert.equal(result.affected, false, explain(web, result));
  });
});

describe('lockfile parsing', () => {
  const changed = (file: string, a: string, b: string) => {
    const before = parseLockfile(file, a);
    const after = parseLockfile(file, b);
    assert.ok(before && after, `${file} did not parse`);
    return diffVersions(before, after).map(c => c.name);
  };

  test('pnpm v5 keys: a version bump of one package changes only that package', () => {
    const lock = (lodash: string) =>
      `lockfileVersion: 5.4\n\nspecifiers:\n  '@types/node': ^20\n  lodash: ^4\n\ndependencies:\n  '@types/node': 20.0.0\n  lodash: ${lodash}\n\npackages:\n\n  /@types/node/20.0.0:\n    resolution: {integrity: sha512-n}\n    dev: false\n\n  /lodash/${lodash}:\n    resolution: {integrity: sha512-l}\n    dev: false\n`;
    const versions = parseLockfile('pnpm-lock.yaml', lock('4.17.20'));
    assert.deepEqual([...(versions?.keys() ?? [])].sort(), ['@types/node', 'lodash']);
    assert.deepEqual(changed('pnpm-lock.yaml', lock('4.17.20'), lock('4.17.21')), ['lodash']);
    assert.deepEqual(changed('pnpm-lock.yaml', lock('4.17.20'), lock('4.17.20')), []);
  });

  test('pnpm: a new patch hash or integrity at the same version is a change', () => {
    const lock = (hash: string, integrity = 'sha512-l') =>
      `lockfileVersion: '9.0'\n\npatchedDependencies:\n  lodash@4.17.21:\n    hash: ${hash}\n    path: patches/lodash@4.17.21.patch\n\nimporters:\n\n  .:\n    dependencies:\n      lodash:\n        specifier: ^4\n        version: 4.17.21(patch_hash=${hash})\n      left-pad:\n        specifier: ^1\n        version: 1.0.0\n\npackages:\n\n  left-pad@1.0.0:\n    resolution: {integrity: sha512-p}\n\n  lodash@4.17.21:\n    resolution: {integrity: ${integrity}}\n\nsnapshots:\n\n  left-pad@1.0.0: {}\n\n  lodash@4.17.21(patch_hash=${hash}): {}\n`;
    assert.deepEqual(changed('pnpm-lock.yaml', lock('aaaa'), lock('bbbb')), ['lodash']);
    assert.deepEqual(changed('pnpm-lock.yaml', lock('aaaa'), lock('aaaa', 'sha512-other')), ['lodash']);
    assert.deepEqual(changed('pnpm-lock.yaml', lock('aaaa'), lock('aaaa')), []);
  });

  test('pnpm 10 patchedDependencies keyed by name still count through the snapshot key', () => {
    const lock = (hash: string) =>
      `lockfileVersion: '9.0'\n\npatchedDependencies:\n  lodash: ${hash}\n\nimporters:\n\n  .:\n    dependencies:\n      lodash:\n        specifier: ^4\n        version: 4.17.21(patch_hash=${hash})\n\npackages:\n\n  lodash@4.17.21:\n    resolution: {integrity: sha512-l}\n\nsnapshots:\n\n  lodash@4.17.21(patch_hash=${hash}): {}\n`;
    assert.deepEqual(changed('pnpm-lock.yaml', lock('aaaa'), lock('bbbb')), ['lodash']);
  });

  test('pnpm v9 git dependency: a new commit is a change', () => {
    const lock = (sha: string) =>
      `lockfileVersion: '9.0'\n\nimporters:\n\n  .:\n    dependencies:\n      foo:\n        specifier: git+ssh://git@github.com/acme/foo.git\n        version: git+ssh://git@github.com/acme/foo.git#${sha}\n\npackages:\n\n  foo@git+ssh://git@github.com/acme/foo.git#${sha}:\n    resolution: {commit: ${sha}, repo: git@github.com:acme/foo.git, type: git}\n    version: 1.0.0\n\nsnapshots:\n\n  foo@git+ssh://git@github.com/acme/foo.git#${sha}: {}\n`;
    assert.deepEqual(changed('pnpm-lock.yaml', lock('aaa111'), lock('bbb222')), ['foo']);
  });

  test('npm: same version with a new integrity or git commit is a change, an identical entry is not', () => {
    const lock = (lodash: object) => JSON.stringify({ lockfileVersion: 3, packages: { '': {}, 'node_modules/lodash': { version: '4.17.21', ...lodash }, 'node_modules/left-pad': { version: '1.0.0', integrity: 'sha512-p' } } });
    assert.deepEqual(changed('package-lock.json', lock({ integrity: 'sha512-a' }), lock({ integrity: 'sha512-b' })), ['lodash']);
    const git = (sha: string) => lock({ resolved: `git+ssh://git@github.com/acme/lodash.git#${sha}` });
    assert.deepEqual(changed('package-lock.json', git('aaa111'), git('bbb222')), ['lodash']);
    assert.deepEqual(changed('package-lock.json', git('aaa111'), git('aaa111')), []);
  });

  test('yarn v1: a new resolved commit is a change, and an npm: alias counts as the target package', () => {
    const lock = (sha: string, lodash: string) =>
      `# yarn lockfile v1\n\n"foo@github:acme/foo":\n  version "1.0.0"\n  resolved "https://codeload.github.com/acme/foo/tar.gz/${sha}"\n\n"my-lodash@npm:lodash@^4":\n  version "${lodash}"\n  resolved "https://registry.yarnpkg.com/lodash/-/lodash-${lodash}.tgz"\n  integrity sha512-${lodash}\n`;
    assert.deepEqual([...(parseLockfile('yarn.lock', lock('a', '4.17.20'))?.keys() ?? [])].sort(), ['foo', 'lodash']);
    assert.deepEqual(changed('yarn.lock', lock('aaa111', '4.17.20'), lock('bbb222', '4.17.20')), ['foo']);
    assert.deepEqual(changed('yarn.lock', lock('aaa111', '4.17.20'), lock('aaa111', '4.17.21')), ['lodash']);
  });

  test('yarn berry: a new patch or git commit at the same version is a change, an npm: alias counts as the target', () => {
    const lock = (patch: string, sha: string) =>
      `__metadata:\n  version: 8\n\n"foo@https://github.com/acme/foo.git":\n  version: 1.0.0\n  resolution: "foo@https://github.com/acme/foo.git#commit=${sha}"\n  languageName: node\n  linkType: hard\n\n"lodash@patch:lodash@npm%3A^4.17.21#~/.yarn/patches/lodash-npm-4.17.21-${patch}.patch":\n  version: 4.17.21\n  resolution: "lodash@patch:lodash@npm%3A4.17.21#~/.yarn/patches/lodash-npm-4.17.21-${patch}.patch::version=4.17.21&hash=${patch}"\n  checksum: 10/${patch}\n  languageName: node\n  linkType: hard\n\n"my-pad@npm:left-pad@^1":\n  version: 1.0.0\n  resolution: "left-pad@npm:1.0.0"\n  checksum: 10/p\n  languageName: node\n  linkType: hard\n`;
    assert.deepEqual([...(parseLockfile('yarn.lock', lock('a', 'a'))?.keys() ?? [])].sort(), ['foo', 'left-pad', 'lodash']);
    assert.deepEqual(changed('yarn.lock', lock('aaaa', 'aaa111'), lock('bbbb', 'aaa111')), ['lodash']);
    assert.deepEqual(changed('yarn.lock', lock('aaaa', 'aaa111'), lock('aaaa', 'bbb222')), ['foo']);
    assert.deepEqual(changed('yarn.lock', lock('aaaa', 'aaa111'), lock('aaaa', 'aaa111')), []);
  });

  test('bun.lock: a version bump or new git commit is a change, an alias counts as the target', () => {
    const lock = (lodash: string, sha: string) =>
      `{\n  "lockfileVersion": 1,\n  "workspaces": { "": { "name": "a", "dependencies": { "my-lodash": "npm:lodash@^4", "foo": "github:acme/foo" } } },\n  "packages": {\n    "foo": ["foo@github:acme/foo#${sha}", {}, "acme-foo-${sha}"],\n    "my-lodash": ["lodash@${lodash}", "", {}, "sha512-x"],\n  }\n}\n`;
    assert.deepEqual([...(parseLockfile('bun.lock', lock('4.17.20', 'a'))?.keys() ?? [])].sort(), ['foo', 'lodash']);
    assert.deepEqual(changed('bun.lock', lock('4.17.20', 'aaa111'), lock('4.17.21', 'aaa111')), ['lodash']);
    assert.deepEqual(changed('bun.lock', lock('4.17.20', 'aaa111'), lock('4.17.20', 'bbb222')), ['foo']);
    assert.deepEqual(changed('bun.lock', lock('4.17.20', 'aaa111'), lock('4.17.20', 'aaa111')), []);
  });

  test('a lockfile with content but no packages it can read is unparseable', () => {
    assert.equal(parseLockfile('pnpm-lock.yaml', 'lockfileVersion: 5.4\n\npackages:\n\n  odd-key:\n    resolution: {}\n'), undefined);
    assert.equal(parseLockfile('package-lock.json', '{ not json'), undefined);
    assert.equal(parseLockfile('bun.lockb', 'binary'), undefined);
    assert.ok(parseLockfile('package-lock.json', JSON.stringify({ lockfileVersion: 3, packages: { '': {}, 'node_modules/a': { version: '1.0.0' } } })));
  });
});

describe('lockfiles, patches and ranges in git mode', () => {
  /** index.ts uses lodash/partition. left-pad is installed and nothing imports it. */
  const lodashApp = (files: Record<string, string | object> = {}) =>
    app(
      {
        'package.json': { name: 'a', dependencies: { lodash: '^4.17.0', 'left-pad': '^1.0.0', '@acme/fmt': '^1.0.0' } },
        'index.ts': "import partition from 'lodash/partition';\nimport { fmt } from '@acme/fmt';\nexport const out = fmt(partition([1, 2], Boolean));\n",
        ...pkg('lodash', { version: '4.17.20' }, { 'partition.js': 'module.exports = () => 1;\n' }),
        ...pkg('left-pad', { version: '1.0.0', main: 'index.js' }, { 'index.js': 'module.exports = 1;\n' }),
        ...pkg('@acme/fmt', { version: '1.0.0', main: 'index.js' }, { 'index.js': 'exports.fmt = x => x;\n' }),
        ...files,
      },
      { repo: true }
    );

  const npmLock = (versions: Record<string, object>) => ({
    lockfileVersion: 3,
    packages: { '': {}, ...Object.fromEntries(Object.entries(versions).map(([name, entry]) => [`node_modules/${name}`, entry])) },
  });
  const LOCK = { lodash: { version: '4.17.20', integrity: 'sha512-l' }, 'left-pad': { version: '1.0.0', integrity: 'sha512-p' }, '@acme/fmt': { version: '1.0.0' } };

  test('same version with a new integrity is affected for a used package, not for an unused one', () => {
    const dir = lodashApp({ 'package-lock.json': npmLock(LOCK) });
    writeJson(dir, 'package-lock.json', npmLock({ ...LOCK, 'left-pad': { version: '1.0.0', integrity: 'sha512-other' } }));
    const unused = sinceMain(dir);
    assert.equal(unused.affected, false, explain(dir, unused));
    assert.deepEqual(unused.ignored.map(i => i.path), ['package-lock.json']);
    writeJson(dir, 'package-lock.json', npmLock({ ...LOCK, lodash: { version: '4.17.20', integrity: 'sha512-other' } }));
    const used = sinceMain(dir);
    assert.deepEqual(reasons(used), ['dependency:lodash']);
    assert.match(used.reasons[0].detail, /same version/);
  });

  test('pnpm v5 lockfile: a bump of a used package is affected, of an unused one is not', () => {
    const lock = (lodash: string, pad: string) =>
      `lockfileVersion: 5.4\n\nspecifiers:\n  left-pad: ^1.0.0\n  lodash: ^4.17.0\n\ndependencies:\n  left-pad: ${pad}\n  lodash: ${lodash}\n\npackages:\n\n  /left-pad/${pad}:\n    resolution: {integrity: sha512-p}\n    dev: false\n\n  /lodash/${lodash}:\n    resolution: {integrity: sha512-l}\n    dev: false\n`;
    const dir = lodashApp({ 'pnpm-lock.yaml': lock('4.17.20', '1.0.0') });
    write(dir, 'pnpm-lock.yaml', lock('4.17.20', '1.0.1'));
    const unused = sinceMain(dir);
    assert.equal(unused.affected, false, explain(dir, unused));
    write(dir, 'pnpm-lock.yaml', lock('4.17.21', '1.0.0'));
    assert.deepEqual(reasons(sinceMain(dir)), ['dependency:lodash']);
  });

  test('pnpm patch hash change for a used package is affected', () => {
    const lock = (hash: string) =>
      `lockfileVersion: '9.0'\n\npatchedDependencies:\n  lodash@4.17.20:\n    hash: ${hash}\n    path: patches/lodash@4.17.20.patch\n\nimporters:\n\n  .:\n    dependencies:\n      lodash:\n        specifier: ^4.17.0\n        version: 4.17.20(patch_hash=${hash})\n\npackages:\n\n  lodash@4.17.20:\n    resolution: {integrity: sha512-l}\n\nsnapshots:\n\n  lodash@4.17.20(patch_hash=${hash}): {}\n`;
    const dir = lodashApp({ 'pnpm-lock.yaml': lock('aaaa') });
    write(dir, 'pnpm-lock.yaml', lock('bbbb'));
    assert.deepEqual(reasons(sinceMain(dir)), ['dependency:lodash']);
  });

  test('an unparseable lockfile is affected', () => {
    const dir = lodashApp({ 'package-lock.json': npmLock(LOCK) });
    write(dir, 'package-lock.json', '{ "lockfileVersion": 3, "packages": {');
    const result = sinceMain(dir);
    assert.deepEqual(reasons(result), ['dependency:package-lock.json']);
    assert.match(result.reasons[0].detail, /could not be parsed/);
  });

  test('a patch-package patch counts when the patched package is used', () => {
    const dir = lodashApp({
      'package-lock.json': npmLock(LOCK),
      'patches/lodash+4.17.20.patch': 'one\n',
      'patches/left-pad+1.0.0.patch': 'one\n',
      'patches/@acme+fmt+1.0.0.patch': 'one\n',
    });
    write(dir, 'patches/left-pad+1.0.0.patch', 'two\n');
    const unused = sinceMain(dir);
    assert.equal(unused.affected, false, explain(dir, unused));
    write(dir, 'patches/lodash+4.17.20.patch', 'two\n');
    write(dir, 'patches/@acme+fmt+1.0.0.patch', 'two\n');
    assert.deepEqual(reasons(sinceMain(dir)).sort(), ['dependency:@acme/fmt', 'dependency:lodash']);
  });

  test('a pnpm patch counts when the patched package is used, scoped names included', () => {
    const dir = lodashApp({
      'patches/lodash@4.17.20.patch': 'one\n',
      'patches/left-pad@1.0.0.patch': 'one\n',
      'patches/@acme__fmt@1.0.0.patch': 'one\n',
      'patches/@acme__other@1.0.0.patch': 'one\n',
    });
    write(dir, 'patches/left-pad@1.0.0.patch', 'two\n');
    write(dir, 'patches/@acme__other@1.0.0.patch', 'two\n');
    const unused = sinceMain(dir);
    assert.equal(unused.affected, false, explain(dir, unused));
    write(dir, 'patches/lodash@4.17.20.patch', 'two\n');
    write(dir, 'patches/@acme__fmt@1.0.0.patch', 'two\n');
    assert.deepEqual(reasons(sinceMain(dir)).sort(), ['dependency:@acme/fmt', 'dependency:lodash']);
  });

  test('without a lockfile, a dependency range change in package.json is affected', () => {
    const dir = lodashApp();
    edit(dir, 'package.json', s => s.replace('^4.17.0', '^4.17.21'));
    assert.deepEqual(reasons(sinceMain(dir)), ['input:package.json']);
  });

  test('with a lockfile, a dependency range change in package.json alone is not affected', () => {
    const dir = lodashApp({ 'package-lock.json': npmLock(LOCK) });
    edit(dir, 'package.json', s => s.replace('^4.17.0', '^4.17.21'));
    const result = sinceMain(dir);
    assert.equal(result.affected, false, explain(dir, result));
  });
});

describe('export conditions', () => {
  const viteApp = (deps: Record<string, string | object>, source: string) =>
    app({ ...VITE, 'index.html': '<script type="module" src="/src/main.ts"></script>\n', 'src/main.ts': source, ...deps });

  test('an ES import of { require, import } resolves to the ES build', () => {
    const dir = viteApp(
      pkg('dual', { exports: { '.': { types: './index.d.ts', require: './index.cjs', import: './index.mjs' } } }, {
        'index.cjs': 'exports.f = () => "cjs";\n',
        'index.mjs': 'export const f = () => "esm";\n',
        'index.d.ts': 'export declare const f: () => string;\n',
      }),
      "import { f } from 'dual';\nconsole.log(f());\n"
    );
    assert.ok(liveKeys(dir).includes('npm:dual/index.mjs#f'));
    const before = fingerprintOf(dir);
    write(dir, 'node_modules/dual/index.d.ts', 'export declare const f: () => number;\n');
    assert.equal(fingerprintOf(dir), before);
    write(dir, 'node_modules/dual/index.mjs', 'export const f = () => "patched";\n');
    assert.notEqual(fingerprintOf(dir), before);
  });

  test('the browser field, as a string and as a map, picks the browser file', () => {
    const dir = viteApp(
      {
        ...pkg('iso', { main: './node.js', browser: './browser.js' }, { 'node.js': 'export const g = 1;\n', 'browser.js': 'export const g = 2;\n', 'unused.js': 'export const u = 1;\n' }),
        ...pkg('iso2', { module: './index.js', browser: { './impl-node.js': './impl-browser.js' } }, {
          'index.js': "export { h } from './impl-node.js';\n",
          'impl-node.js': 'export const h = 1;\n',
          'impl-browser.js': 'export const h = 2;\n',
        }),
      },
      "import { g } from 'iso';\nimport { h } from 'iso2';\nconsole.log(g, h);\n"
    );
    const keys = liveKeys(dir);
    assert.ok(keys.includes('npm:iso/browser.js#g'), keys.join('\n'));
    assert.ok(keys.includes('npm:iso2/impl-browser.js#h'), keys.join('\n'));
    assert.ok(!keys.some(k => k.startsWith('npm:iso/unused.js')));
  });

  // One package per condition: within one `exports` object the first matching key wins, which would hide the others.
  const conditional = {
    ...pkg('rsc', { exports: { '.': { 'react-server': './rsc.js', default: './default.js' } } }, { 'rsc.js': 'export const r = 1;\n', 'default.js': 'export const r = 2;\n' }),
    ...pkg('edge', { exports: { '.': { 'edge-light': './edge.js', default: './default.js' } } }, { 'edge.js': 'export const e = 1;\n', 'default.js': 'export const e = 2;\n' }),
    ...pkg('worker', { exports: { '.': { workerd: './workerd.js', default: './default.js' } } }, { 'workerd.js': 'export const w = 1;\n', 'default.js': 'export const w = 2;\n' }),
  };
  const IMPORTS = "import { r } from 'rsc';\nimport { e } from 'edge';\nimport { w } from 'worker';\n";
  const condKeys = (dir: string) => liveKeys(dir).filter(k => /^npm:(rsc|edge|worker)\//.test(k) && !k.includes('/default.js'));

  test('a Next.js app uses react-server and edge-light builds too', () => {
    const dir = app({ ...NEXT, 'tsconfig.json': {}, ...conditional, 'app/page.tsx': `${IMPORTS}export default function Page() { return r + e + w; }\n` });
    assert.ok(condKeys(dir).includes('npm:rsc/rsc.js#r'));
    assert.ok(condKeys(dir).includes('npm:edge/edge.js#e'));
  });

  test('a Cloudflare Worker uses the workerd build, not react-server', () => {
    const dir = app({
      'package.json': { name: 'w', devDependencies: { wrangler: '4.0.0' } },
      'wrangler.jsonc': '{ "name": "w", "main": "src/index.ts" }',
      ...conditional,
      'src/index.ts': `${IMPORTS}export default { fetch: () => new Response(String(r + e + w)) };\n`,
    });
    assert.ok(condKeys(dir).includes('npm:worker/workerd.js#w'));
    assert.ok(!condKeys(dir).includes('npm:rsc/rsc.js#r'));
  });

  test('a Vite app uses neither react-server nor edge builds', () => {
    const dir = viteApp(conditional, `${IMPORTS}console.log(r, e, w);\n`);
    assert.deepEqual(condKeys(dir), []);
    assert.ok(liveKeys(dir).includes('npm:edge/default.js#e'));
  });
});

describe('Vite index.html', () => {
  test('a stylesheet linked from index.html counts, one nobody links does not', () => {
    const dir = app(
      {
        ...VITE,
        'index.html': '<link rel="stylesheet" href="/src/style.css">\n<script type="module" src="/src/main.ts"></script>\n',
        'src/main.ts': "console.log('main');\n",
        'src/style.css': 'body { color: red; }\n',
        'src/unlinked.css': 'body { color: red; }\n',
      },
      { repo: true }
    );
    edit(dir, 'src/unlinked.css', s => s.replace('red', 'blue'));
    const unlinked = sinceMain(dir);
    assert.equal(unlinked.affected, false, explain(dir, unlinked));
    edit(dir, 'src/style.css', s => s.replace('red', 'blue'));
    assert.deepEqual(reasons(sinceMain(dir)), ['source:src/style.css']);
  });

  test('scripts of an HTML page vite.config names are entries, those of a page it does not name are not', () => {
    const dir = app({
      ...VITE,
      'vite.config.ts':
        "import { resolve } from 'node:path';\nexport default { build: { rollupOptions: { input: { main: resolve(__dirname, 'index.html'), admin: resolve(__dirname, 'admin/index.html') } } } };\n",
      'index.html': '<script type="module" src="/src/main.ts"></script>\n',
      'admin/index.html': '<script type="module" src="/src/admin.ts"></script>\n',
      'drafts/index.html': '<script type="module" src="/src/draft.ts"></script>\n',
      'src/main.ts': "console.log('main');\n",
      'src/admin.ts': "console.log('admin');\n",
      'src/draft.ts': "console.log('draft');\n",
    });
    const entries = loadProject({ cwd: dir }).entries.map(rel(dir));
    assert.ok(entries.includes('src/admin.ts'), entries.join('\n'));
    assert.ok(!entries.includes('src/draft.ts'), entries.join('\n'));
  });
});

describe('build settings that are not code', () => {
  test('postcss.config.json, babel.config.json and browserslist are inputs, components.json is not', () => {
    const dir = app({
      ...NEXT,
      'tsconfig.json': {},
      'app/page.tsx': "export default function Page() { return 'page'; }\n",
      'postcss.config.json': { plugins: { autoprefixer: {} } },
      'babel.config.json': { presets: ['next/babel'] },
      browserslist: '> 1%\n',
      'components.json': {},
    });
    const keys = liveKeys(dir);
    for (const input of ['postcss.config.json', 'babel.config.json', 'browserslist']) assert.ok(keys.includes(input), `${input} missing`);
    assert.ok(!keys.includes('components.json'));
  });

  test('pageExtensions adds route files, a non-route file with that extension stays out', () => {
    const dir = app({
      ...NEXT,
      'tsconfig.json': {},
      'next.config.ts': "export default { pageExtensions: ['page.tsx'] };\n",
      'app/page.page.tsx': "export default function Page() { return 'page'; }\n",
      'app/helper.page.tsx': "export default function Helper() { return 'helper'; }\n",
    });
    const entries = loadProject({ cwd: dir }).entries.map(rel(dir));
    assert.ok(entries.includes('app/page.page.tsx'), entries.join('\n'));
    assert.ok(!entries.includes('app/helper.page.tsx'), entries.join('\n'));
  });

  test('a caniuse-lite bump is affected when autoprefixer reads it, not otherwise', () => {
    const lock = (caniuse: string) => ({ lockfileVersion: 3, packages: { '': {}, 'node_modules/next': { version: '15.0.0' }, 'node_modules/caniuse-lite': { version: caniuse } } });
    const make = (devDependencies: Record<string, string>) =>
      app(
        {
          ...NEXT,
          'package.json': { name: 'web', dependencies: { next: '15.0.0' }, devDependencies },
          ...pkg('autoprefixer', { version: '10.4.20' }, {}),
          ...pkg('caniuse-lite', { version: '1.0.30001600' }, {}),
          'tsconfig.json': {},
          'app/page.tsx': "export default function Page() { return 'page'; }\n",
          'package-lock.json': lock('1.0.30001600'),
        },
        { repo: true }
      );
    const without = make({});
    writeJson(without, 'package-lock.json', lock('1.0.30001700'));
    const result = sinceMain(without);
    assert.equal(result.affected, false, explain(without, result));
    const withAutoprefixer = make({ autoprefixer: '10.4.20' });
    writeJson(withAutoprefixer, 'package-lock.json', lock('1.0.30001700'));
    assert.deepEqual(reasons(sinceMain(withAutoprefixer)), ['dependency:caniuse-lite']);
  });
});

describe('framework of a workspace app with its own package.json', () => {
  /** The root declares vite (for vitest) and typescript. apps/api is a plain server with its own package.json. */
  const rootTools = () => {
    const dir = app(
      {
        'package.json': { name: 'root', private: true, workspaces: ['apps/*'], devDependencies: { vite: '6.0.0', typescript: '5.0.0' } },
        ...pkg('vite', { version: '6.0.0' }, {}),
        ...pkg('typescript', { version: '5.0.0' }, {}),
        'apps/api/package.json': { name: 'api' },
        'apps/api/src/index.ts': "import { h } from './h';\nexport default h;\n",
        'apps/api/src/h.ts': "export const h = 'old';\n",
        'apps/api/src/unused.ts': "export const u = 'old';\n",
      },
      { repo: true }
    );
    return { dir, api: join(dir, 'apps/api') };
  };

  test('comes from the app, so a root vite does not hide the server entry', () => {
    const { dir, api } = rootTools();
    const project = loadProject({ cwd: api });
    assert.equal(project.framework, 'none');
    assert.deepEqual(project.entries.map(rel(api)), ['src/index.ts']);
    edit(dir, 'apps/api/src/h.ts', s => s.replace('old', 'new'));
    assert.deepEqual(reasons(sinceMain(api)), ['source:apps/api/src/h.ts#h']);
  });

  test('a file the server does not import is not affected, and root tools are still tracked', () => {
    const { dir, api } = rootTools();
    assert.ok(loadProject({ cwd: api }).packages.includes('typescript'));
    edit(dir, 'apps/api/src/unused.ts', s => s.replace('old', 'new'));
    const result = sinceMain(api);
    assert.equal(result.affected, false, explain(api, result));
  });
});

describe('a React Router app whose tools the root declares', () => {
  /** The root declares vite and @react-router/dev. apps/web declares only react-router, and has react-router.config.ts. */
  const rootRouter = () => {
    const dir = app(
      {
        'package.json': { name: 'root', private: true, workspaces: ['apps/*'], devDependencies: { vite: '6.0.0', '@react-router/dev': '7.0.0' } },
        ...pkg('vite', { version: '6.0.0' }, {}),
        ...pkg('@react-router/dev', { version: '7.0.0' }, {}),
        'apps/web/package.json': { name: 'web', dependencies: { 'react-router': '7.0.0' } },
        'apps/web/react-router.config.ts': 'export default { ssr: true };\n',
        'apps/web/vite.config.ts': 'export default {};\n',
        'apps/web/app/root.tsx': "export default function Root() {\n  return 'old';\n}\n",
        'apps/web/app/unused.ts': "export const u = 'old';\n",
      },
      { repo: true }
    );
    return { dir, web: join(dir, 'apps/web') };
  };

  test('is a React Router app, and an edit to its root route is affected', () => {
    const { dir, web } = rootRouter();
    assert.equal(loadProject({ cwd: web }).framework, 'react-router');
    edit(dir, 'apps/web/app/root.tsx', s => s.replace('old', 'new'));
    assert.deepEqual(reasons(sinceMain(web)), ['source:apps/web/app/root.tsx#Root']);
  });

  test('a file no route imports is not affected', () => {
    const { dir, web } = rootRouter();
    edit(dir, 'apps/web/app/unused.ts', s => s.replace('old', 'new'));
    const result = sinceMain(web);
    assert.equal(result.affected, false, explain(web, result));
  });
});

describe('a browser map in a workspace package', () => {
  /** @acme/env maps impl-node.ts to impl-browser.ts for browsers. The Next.js server still loads impl-node.ts. */
  const browserMap = () => {
    const dir = app({
      'package.json': { name: 'root', private: true, workspaces: ['apps/*', 'packages/*'] },
      ...pkg('next', { version: '15.0.0' }, {}),
      'apps/web/package.json': { name: 'web', dependencies: { next: '15.0.0', '@acme/env': '*' } },
      'apps/web/tsconfig.json': {},
      'apps/web/app/page.tsx': "import { env } from '@acme/env';\nexport default function Page() { return env(); }\n",
      'packages/env/package.json': { name: '@acme/env', version: '0.0.0', main: './src/index.ts', browser: { './src/impl-node.ts': './src/impl-browser.ts' } },
      'packages/env/src/index.ts': "export { env } from './impl-node';\n",
      'packages/env/src/impl-node.ts': "export const env = () => 'node';\n",
      'packages/env/src/impl-browser.ts': "export const env = () => 'browser';\n",
      'packages/env/src/unused.ts': "export const u = 'old';\n",
    });
    link(dir, '@acme/env', 'packages/env');
    initRepo(dir);
    return { dir, web: join(dir, 'apps/web') };
  };

  test('keeps the server file live next to the browser one', () => {
    const { dir, web } = browserMap();
    const keys = liveKeys(web);
    assert.ok(keys.includes('packages/env/src/impl-node.ts#env'), keys.join('\n'));
    assert.ok(keys.includes('packages/env/src/impl-browser.ts#env'), keys.join('\n'));
    edit(dir, 'packages/env/src/impl-node.ts', s => s.replace("'node'", "'server'"));
    assert.deepEqual(reasons(sinceMain(web)), ['source:packages/env/src/impl-node.ts#env']);
  });

  test('a file of that package nobody imports is not affected', () => {
    const { dir, web } = browserMap();
    edit(dir, 'packages/env/src/unused.ts', s => s.replace('old', 'new'));
    const result = sinceMain(web);
    assert.equal(result.affected, false, explain(web, result));
  });
});

describe('unresolved imports that look like package names', () => {
  test('a tsconfig paths alias shaped like a scoped package fails closed when its target is gone', () => {
    const dir = app(
      {
        ...NEXT,
        'tsconfig.json': { compilerOptions: { paths: { '@components/*': ['./src/components/*'] } } },
        'app/page.tsx': "import { B } from '@components/B';\nexport default function Page() { return B; }\n",
        'src/components/B.ts': "export const B = 'old';\n",
        'src/components/Unused.ts': "export const U = 'old';\n",
      },
      { repo: true }
    );
    edit(dir, 'src/components/Unused.ts', s => s.replace('old', 'new'));
    const unused = sinceMain(dir);
    assert.equal(unused.affected, false, explain(dir, unused));
    remove(dir, 'src/components/B.ts');
    assert.ok(reasons(sinceMain(dir)).includes('unresolved:app/page.tsx -> @components/B'));
  });

  test('a scoped-looking alias only vite.config names fails closed', () => {
    const dir = app(
      {
        ...VITE,
        'vite.config.ts': "export default { resolve: { alias: { '@lib': '/src/lib' } } };\n",
        'index.html': '<script type="module" src="/src/main.ts"></script>\n',
        'src/main.ts': "import { msg } from '@lib/msg';\nconsole.log(msg);\n",
        'src/lib/msg.ts': "export const msg = 'old';\n",
      },
      { repo: true }
    );
    edit(dir, 'src/lib/msg.ts', s => s.replace('old', 'new'));
    assert.deepEqual(reasons(sinceMain(dir)), ['unresolved:src/main.ts -> @lib/msg']);
  });

  test('an undeclared package that is installed, such as a hoisted transitive one, does not warn', () => {
    const dir = app(
      {
        ...NEXT,
        'tsconfig.json': {},
        ...pkg('scheduler', { version: '0.25.0', main: 'index.js' }, { 'index.js': 'exports.s = 1;\n' }),
        'app/page.tsx': "import { s } from 'scheduler';\nexport default function Page() { return s; }\n",
        'README.md': 'a\n',
      },
      { repo: true }
    );
    assert.deepEqual(analyze({ cwd: dir }).warnings, []);
    assert.ok(liveKeys(dir).includes('npm:scheduler/index.js'));
    write(dir, 'README.md', 'b\n');
    const result = sinceMain(dir);
    assert.equal(result.affected, false, explain(dir, result));
  });

  test('a workspace: dependency that is not linked, or a link whose target is gone, warns', () => {
    const files = {
      'package.json': { name: 'root', private: true, workspaces: ['apps/*', 'packages/*'] },
      'apps/web/package.json': { name: 'web', dependencies: { '@acme/ui': 'workspace:*' } },
      'apps/web/index.ts': "import { Button } from '@acme/ui';\nexport const b = Button();\n",
    };
    const unlinked = app(files);
    assert.ok(analyze({ cwd: join(unlinked, 'apps/web') }).warnings.some(w => w.includes('"@acme/ui"')));
    const dangling = app({ ...files, 'apps/web/package.json': { name: 'web', dependencies: { '@acme/ui': '*' } } });
    link(dangling, '@acme/ui', 'packages/gone');
    assert.ok(analyze({ cwd: join(dangling, 'apps/web') }).warnings.some(w => w.includes('"@acme/ui"')));
  });

  test('an unresolved import that only import type asks for warns but is not affected', () => {
    const dir = app(
      {
        ...NEXT,
        'tsconfig.json': {},
        'app/page.tsx': "import type { Route } from './+types/page';\nexport default function Page(props: Route) { return props; }\n",
        'README.md': 'a\n',
      },
      { repo: true }
    );
    assert.ok(analyze({ cwd: dir }).warnings.some(w => w.includes('"./+types/page"')));
    write(dir, 'README.md', 'b\n');
    const result = sinceMain(dir);
    assert.equal(result.affected, false, explain(dir, result));
  });

  test('the same import without type is affected', () => {
    const dir = app(
      {
        ...NEXT,
        'tsconfig.json': {},
        'app/page.tsx': "import { Route } from './+types/page';\nexport default function Page() { return Route; }\n",
        'README.md': 'a\n',
      },
      { repo: true }
    );
    write(dir, 'README.md', 'b\n');
    assert.deepEqual(reasons(sinceMain(dir)), ['unresolved:app/page.tsx -> ./+types/page']);
  });
});

describe('"virtual" in byakugan.json', () => {
  const plugins = (virtual?: string[]) =>
    app(
      {
        ...VITE,
        ...(virtual ? { 'byakugan.json': { virtual } } : {}),
        'index.html': '<script type="module" src="/src/main.ts"></script>\n',
        'src/main.ts': "import IconHome from '~icons/mdi/home';\nimport routes from '~react-pages';\nconsole.log(IconHome, routes);\n",
        'README.md': 'a\n',
      },
      { repo: true }
    );
  const warned = (dir: string) => analyze({ cwd: dir }).warnings.map(w => /cannot resolve "([^"]+)"/.exec(w)?.[1]);

  test('exempts the plugin modules it matches', () => {
    const dir = plugins(['~icons/**', '~react-pages']);
    assert.deepEqual(warned(dir), []);
    write(dir, 'README.md', 'b\n');
    const result = sinceMain(dir);
    assert.equal(result.affected, false, explain(dir, result));
  });

  test('leaves every specifier it does not match failing closed', () => {
    assert.deepEqual(warned(plugins()), ['~icons/mdi/home', '~react-pages']);
    // `*` stops at a slash, like any glob.
    const dir = plugins(['~icons/*']);
    assert.deepEqual(warned(dir), ['~icons/mdi/home', '~react-pages']);
    write(dir, 'README.md', 'b\n');
    assert.equal(sinceMain(dir).affected, true);
  });
});

describe('pnpm git dependencies before lockfile v9', () => {
  const changed = (a: string, b: string) => diffVersions(parseLockfile('pnpm-lock.yaml', a)!, parseLockfile('pnpm-lock.yaml', b)!).map(c => c.name);
  const v6 = (sha: string, other = 'ccc333') =>
    `lockfileVersion: '6.0'\n\ndependencies:\n  is-positive:\n    specifier: github:kevva/is-positive\n    version: github.com/kevva/is-positive/${sha}\n  is-negative:\n    specifier: github:kevva/is-negative\n    version: github.com/kevva/is-negative/${other}\n\npackages:\n\n  github.com/kevva/is-negative/${other}:\n    resolution: {tarball: https://codeload.github.com/kevva/is-negative/tar.gz/${other}}\n    name: is-negative\n    version: 2.0.0\n    dev: false\n\n  github.com/kevva/is-positive/${sha}:\n    resolution: {tarball: https://codeload.github.com/kevva/is-positive/tar.gz/${sha}}\n    name: is-positive\n    version: 3.1.0\n    dev: false\n`;
  const v5 = (sha: string) =>
    `lockfileVersion: 5.4\n\nspecifiers:\n  is-positive: github:kevva/is-positive\n\ndependencies:\n  is-positive: github.com/kevva/is-positive/${sha}\n\npackages:\n\n  github.com/kevva/is-positive/${sha}:\n    resolution: {tarball: https://codeload.github.com/kevva/is-positive/tar.gz/${sha}}\n    name: is-positive\n    version: 3.1.0\n    dev: false\n`;

  test('a new commit counts under the package name from the name: field', () => {
    assert.deepEqual(changed(v6('aaa111'), v6('bbb222')), ['is-positive']);
    assert.ok(changed(v5('aaa111'), v5('bbb222')).includes('is-positive'));
    assert.deepEqual(changed(v6('aaa111'), v6('aaa111')), []);
  });

  test('in git mode, a new commit of the used git package is affected, of an unused one is not', () => {
    const dir = app(
      {
        'package.json': { name: 'a', dependencies: { 'is-positive': 'github:kevva/is-positive', 'is-negative': 'github:kevva/is-negative' } },
        'index.ts': "import isPositive from 'is-positive';\nexport const out = isPositive(1);\n",
        ...pkg('is-positive', { version: '3.1.0', main: 'index.js' }, { 'index.js': 'module.exports = n => n > 0;\n' }),
        ...pkg('is-negative', { version: '2.0.0', main: 'index.js' }, { 'index.js': 'module.exports = n => n < 0;\n' }),
        'pnpm-lock.yaml': v6('aaa111'),
      },
      { repo: true }
    );
    write(dir, 'pnpm-lock.yaml', v6('aaa111', 'ddd444'));
    const unused = sinceMain(dir);
    assert.equal(unused.affected, false, explain(dir, unused));
    write(dir, 'pnpm-lock.yaml', v6('bbb222'));
    assert.deepEqual(reasons(sinceMain(dir)), ['dependency:is-positive']);
  });
});

describe('edge and worker conditions are separate', () => {
  /** One package with an edge-light and a workerd build, in the given order. */
  const db = (order: string[]) =>
    pkg('db', { exports: { '.': { ...Object.fromEntries(order.map(c => [c, `./${c}.js`])), default: './default.js' } } }, {
      'edge-light.js': 'export const q = 1;\n',
      'workerd.js': 'export const q = 2;\n',
      'default.js': 'export const q = 3;\n',
    });
  const dbKeys = (dir: string) => liveKeys(dir).filter(k => k.startsWith('npm:db/') && !k.includes('default.js'));

  for (const order of [['edge-light', 'workerd'], ['workerd', 'edge-light']]) {
    test(`with ${order.join(' before ')}, Next.js middleware gets edge-light and a Worker gets workerd`, () => {
      const next = app({ ...NEXT, 'tsconfig.json': {}, ...db(order), 'middleware.ts': "import { q } from 'db';\nexport function middleware() { return q; }\n" });
      assert.deepEqual(dbKeys(next), ['npm:db/edge-light.js#q']);
      const worker = app({
        'package.json': { name: 'w', devDependencies: { wrangler: '4.0.0' } },
        'wrangler.jsonc': '{ "name": "w", "main": "src/index.ts" }',
        ...db(order),
        'src/index.ts': "import { q } from 'db';\nexport default { fetch: () => new Response(String(q)) };\n",
      });
      assert.deepEqual(dbKeys(worker), ['npm:db/workerd.js#q']);
    });
  }
});

describe('deleting a tsconfig the app extends from outside its directory', () => {
  /** apps/web extends a config in the repository root. The page has no imports, so no resolver error reports it. */
  const extendsRoot = (specifier: string) =>
    app(
      {
        'package.json': { name: 'root', private: true, workspaces: ['apps/*'] },
        'tsconfig.base.json': { compilerOptions: { strict: true } },
        'tsconfig.other.json': { compilerOptions: { strict: false } },
        ...pkg('next', { version: '15.0.0' }, {}),
        'apps/web/package.json': { name: 'web', dependencies: { next: '15.0.0' } },
        'apps/web/tsconfig.json': { extends: specifier },
        'apps/web/app/page.tsx': "export default function Page() { return 'page'; }\n",
      },
      { repo: true }
    );

  test('is affected when extends leaves out .json', () => {
    const dir = extendsRoot('../../tsconfig.base');
    remove(dir, 'tsconfig.base.json');
    assert.equal(sinceMain(join(dir, 'apps/web')).affected, true);
  });

  test('is affected when extends names the .json file', () => {
    const dir = extendsRoot('../../tsconfig.base.json');
    remove(dir, 'tsconfig.base.json');
    assert.equal(sinceMain(join(dir, 'apps/web')).affected, true);
  });

  test('deleting a tsconfig nothing extends is not affected', () => {
    const dir = extendsRoot('../../tsconfig.base');
    remove(dir, 'tsconfig.other.json');
    const web = join(dir, 'apps/web');
    const result = sinceMain(web);
    assert.equal(result.affected, false, explain(web, result));
  });
});

describe('Next.js modules a tsconfig alias replaces', () => {
  /** tsconfig maps server-only to a local shim, which the page imports for its side effect. */
  const shimmed = (paths: object) =>
    app(
      {
        ...NEXT,
        'tsconfig.json': { compilerOptions: { paths } },
        'app/page.tsx': "import 'server-only';\nexport default function Page() { return 'page'; }\n",
        'src/shims/server-only.ts': "console.log('shim');\n",
      },
      { repo: true }
    );

  // The page now gets Next.js's own copy, and the shim's side effect is gone.
  test('deleting a local server-only shim a tsconfig alias names is affected', () => {
    const dir = shimmed({ 'server-only': ['./src/shims/server-only.ts'] });
    remove(dir, 'src/shims/server-only.ts');
    assert.equal(sinceMain(dir).affected, true);
  });

  test('an unresolved server-only import with no alias is not affected', () => {
    const dir = shimmed({});
    const result = sinceMain(dir);
    assert.equal(result.affected, false, explain(dir, result));
  });
});

// Older than the changes under review: the same shape as `lib/util.ts` deleted while
// `lib/util/index.ts` answers, but across tsconfig paths targets.
describe('tsconfig paths with two targets', () => {
  const twoTargets = () =>
    app(
      {
        'package.json': { name: 'app', type: 'module' },
        'byakugan.json': { entry: ['src/main.ts'] },
        'tsconfig.json': { compilerOptions: { paths: { '@/*': ['./src/*', './fallback/*'] } } },
        'src/main.ts': "import { v } from '@/lib/v';\nconsole.log(v);\n",
        'src/lib/v.ts': "export const v = 'src';\n",
        'fallback/lib/v.ts': "export const v = 'fallback';\n",
      },
      { repo: true }
    );

  test('deleting the first target so that the import falls back to the second is affected', () => {
    const dir = twoTargets();
    const before = fingerprintOf(dir);
    remove(dir, 'src/lib/v.ts');
    assert.notEqual(fingerprintOf(dir), before);
    assert.equal(sinceMain(dir).affected, true);
  });

  test('deleting the second target while the first one answers is not affected', () => {
    const dir = twoTargets();
    remove(dir, 'fallback/lib/v.ts');
    const result = sinceMain(dir);
    assert.equal(result.affected, false, explain(dir, result));
  });
});

describe('bun.lock integrity', () => {
  const lock = (integrity: string) =>
    `{\n  "lockfileVersion": 1,\n  "workspaces": { "": { "name": "a", "dependencies": { "lodash": "^4" } } },\n  "packages": {\n    "lodash": ["lodash@4.17.21", "", {}, "${integrity}"],\n  }\n}\n`;

  test('a new integrity at the same version is a change, the same one is not', () => {
    const changed = (a: string, b: string) => diffVersions(parseLockfile('bun.lock', a)!, parseLockfile('bun.lock', b)!).map(c => c.name);
    assert.deepEqual(changed(lock('sha512-a'), lock('sha512-b')), ['lodash']);
    assert.deepEqual(changed(lock('sha512-a'), lock('sha512-a')), []);
  });
});

describe('JSON files with a UTF-8 byte order mark', () => {
  const BOM = '﻿';
  const bomApp = () =>
    app(
      {
        ...NEXT,
        'node_modules/next/package.json': `${BOM}{ "name": "next", "version": "15.0.0" }\n`,
        'package.json': `${BOM}${JSON.stringify({ name: 'web', dependencies: { next: '15.0.0' } })}\n`,
        'tsconfig.json': `${BOM}${JSON.stringify({ compilerOptions: { paths: { '@/*': ['./src/*'] } } })}\n`,
        'byakugan.json': `${BOM}${JSON.stringify({ entry: ['scripts/seed.ts'] })}\n`,
        'scripts/seed.ts': 'export const seed = 1;\n',
        'app/page.tsx': "import { v } from '@/v';\nexport default function Page() { return v; }\n",
        'src/v.ts': "export const v = 'old';\n",
        'src/unused.ts': "export const u = 'old';\n",
      },
      { repo: true }
    );

  test('are read: framework, byakugan.json entries and tsconfig paths all apply', () => {
    const dir = bomApp();
    const project = loadProject({ cwd: dir });
    assert.equal(project.framework, 'next');
    assert.deepEqual(project.entries.map(rel(dir)), ['app/page.tsx', 'scripts/seed.ts']);
    assert.deepEqual(project.packages, ['next']);
    edit(dir, 'src/v.ts', s => s.replace('old', 'new'));
    assert.deepEqual(reasons(sinceMain(dir)), ['source:src/v.ts#v']);
  });

  test('a file nobody imports stays unaffected', () => {
    const dir = bomApp();
    edit(dir, 'src/unused.ts', s => s.replace('old', 'new'));
    const result = sinceMain(dir);
    assert.equal(result.affected, false, explain(dir, result));
  });
});
