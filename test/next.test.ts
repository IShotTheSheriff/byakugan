import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { affected, analyze, loadProject } from '../src/index.ts';
import { commitAll, edit, initRepo, write } from './helpers.ts';

/** A Next.js app with the patterns that do not show up as static imports. */
const nextApp = () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'byakugan-next-')));
  const files: Record<string, string> = {
    'package.json': JSON.stringify({
      name: 'shop',
      dependencies: { next: '16.0.0', react: '19.0.0', 'next-intl': '4.0.0', 'style-only': '1.0.0' },
      devDependencies: { '@tailwindcss/postcss': '4.0.0', '@svgr/webpack': '8.0.0' },
    }),
    '.gitignore': 'node_modules/\n',
    'node_modules/next/package.json': '{ "name": "next", "version": "16.0.0" }',
    'node_modules/next/font/local.js': 'module.exports = function localFont(options) { return { variable: "--font" }; };\n',
    'node_modules/react/package.json': '{ "name": "react", "version": "19.0.0" }',
    'node_modules/react/index.js': 'exports.useState = function () {};\n',
    'node_modules/next-intl/package.json': '{ "name": "next-intl", "version": "4.0.0" }',
    'node_modules/style-only/package.json': '{ "name": "style-only", "version": "1.0.0", "exports": { ".": { "style": "./dist/style.css" } } }',
    'node_modules/style-only/dist/style.css': '.fade { opacity: 0; }\n',
    'node_modules/@tailwindcss/postcss/package.json': '{ "name": "@tailwindcss/postcss", "version": "4.0.0" }',
    'node_modules/@svgr/webpack/package.json': '{ "name": "@svgr/webpack", "version": "8.0.0" }',
    'next.config.ts': [
      "import { join } from 'node:path';",
      "export default {",
      "  turbopack: { rules: { '*.svg': { loaders: ['@svgr/webpack'], as: '*.js' } } },",
      "  sassOptions: { includePaths: [join(__dirname, 'src')] },",
      '};',
      '',
    ].join('\n'),
    'postcss.config.mjs': "export default { plugins: { '@tailwindcss/postcss': {} } };\n",
    'app/layout.tsx': "import './globals.css';\nimport './theme.scss';\nimport { brand } from './fonts';\n\nexport default function Layout({ children }) {\n  return <html className={brand.variable}>{children}</html>;\n}\n",
    'app/globals.css': '@import "style-only";\nbody { background: url("./bg.png"), url(/hero.png); }\n',
    'app/bg.png': 'png bytes\n',
    'app/theme.scss': "@use 'tokens';\n",
    'app/_tokens.scss': '$brand: red;\n',
    'app/fonts.ts': "import localFont from 'next/font/local';\n\nexport const brand = localFont({ src: './fonts/brand.woff2' });\n",
    'app/fonts/brand.woff2': 'brand font\n',
    'app/fonts/spare.woff2': 'spare font\n',
    'app/page.tsx': "import { save } from './actions';\nimport { formatPrice } from './lib';\n\nexport default function Home() {\n  return <form action={save}>{formatPrice(1)}</form>;\n}\n",
    'app/actions.ts': "'use server';\n\nexport async function save() { return 'saved'; }\n\nexport async function remove() { return 'removed'; }\n",
    'app/lib.ts': "export const formatPrice = (n: number) => '$' + n;\nexport const formatTax = (n: number) => n * 0.23;\n",
    'app/[locale]/page.tsx':
      'export default async function Page({ params }) {\n  const { locale } = await params;\n  const messages = (await import(`../../messages/${locale}.json`)).default;\n  return <p>{messages.hello}</p>;\n}\n',
    'messages/en.json': '{ "hello": "Hello" }\n',
    'messages/pl.json': '{ "hello": "Cześć" }\n',
    'data/other.json': '{ "unrelated": true }\n',
    'app/legacy/page.tsx': "export default async function Legacy({ lang }) {\n  const strings = await import('./locales/' + lang + '.js');\n  return <p>{strings.title}</p>;\n}\n",
    'app/legacy/locales/en.js': "export const title = 'Title';\n",
    'app/blog/[slug]/page.tsx': [
      "import { readFile } from 'node:fs/promises';",
      "import { join } from 'node:path';",
      '',
      'export default async function Post({ params }) {',
      '  const { slug } = await params;',
      "  return <article>{await readFile(join(process.cwd(), 'content', 'posts', `${slug}.md`), 'utf8')}</article>;",
      '}',
      '',
    ].join('\n'),
    'content/posts/first.md': '# First\n',
    'content/drafts/draft.md': '# Draft\n',
    'app/worker/page.tsx': "export default function Page() {\n  new Worker(new URL('./worker.ts', import.meta.url));\n  return null;\n}\n",
    'app/worker/worker.ts': "self.onmessage = () => self.postMessage('pong');\n",
    'app/computed/page.tsx': 'export default async function Page({ name }) {\n  return (await import(name)).default;\n}\n',
    'app/global-not-found.tsx': 'export default function GlobalNotFound() { return null; }\n',
    'i18n/request.ts': "export default async function config() { return { locale: 'en' }; }\n",
    'src/unrelated.ts': 'export const unrelated = 1;\n',
  };
  for (const [path, content] of Object.entries(files)) write(dir, path, content);
  return dir;
};

const keysOf = (dir: string) => [...analyze({ cwd: dir }).live.keys()];
const fingerprint = (dir: string) => analyze({ cwd: dir }).fingerprint();

describe('Next.js conventions without imports', () => {
  const dir = nextApp();

  test('global-not-found and next-intl request config are entries', () => {
    const entries = loadProject({ cwd: dir }).entries.map(e => e.slice(dir.length + 1));
    assert.ok(entries.includes('app/global-not-found.tsx'));
    assert.ok(entries.includes('i18n/request.ts'));
  });

  test('packages named in config strings are tracked by version', () => {
    const { packages } = loadProject({ cwd: dir });
    assert.ok(packages.includes('@svgr/webpack'), 'turbopack loader in next.config');
    assert.ok(packages.includes('@tailwindcss/postcss'), 'PostCSS plugin key');
  });

  test('computed imports, font files, fs reads and workers reach their files', () => {
    const keys = keysOf(dir);
    for (const key of [
      'messages/en.json',
      'messages/pl.json',
      'app/legacy/locales/en.js#title',
      'content/posts/first.md',
      'app/fonts/brand.woff2',
      'app/worker/worker.ts',
      'npm:style-only/dist/style.css',
      'app/_tokens.scss',
      'app/bg.png',
    ]) {
      assert.ok(keys.includes(key), key);
    }
    for (const key of ['data/other.json', 'content/drafts/draft.md', 'app/fonts/spare.woff2', 'src/unrelated.ts#unrelated']) {
      assert.ok(!keys.includes(key), key);
    }
  });

  test('an import with a computed specifier is reported', () => {
    const { warnings } = analyze({ cwd: dir });
    assert.ok(warnings.some(w => w.startsWith('app/computed/page.tsx: cannot follow an import with a computed specifier')), warnings.join('\n'));
  });

  test('every export of a "use server" file counts; a plain module keeps per-export precision', () => {
    const app = nextApp();
    const before = fingerprint(app);
    edit(app, 'app/lib.ts', s => s.replace('0.23', '0.08'));
    assert.equal(fingerprint(app), before);
    edit(app, 'app/actions.ts', s => s.replace("'removed'", "'deleted'"));
    assert.notEqual(fingerprint(app), before);
  });
});

describe("'use client' modules", () => {
  const client = (unused: string) => `'use client';\nexport const Used = () => <b>used</b>;\nexport const Unused = () => <i>${unused}</i>;\n`;
  const project = (page: string, extra: Record<string, string> = {}) => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'byakugan-client-')));
    const files: Record<string, string> = {
      'package.json': JSON.stringify({ name: 'shop', dependencies: { next: '16.0.0', react: '19.0.0' } }),
      'node_modules/next/package.json': '{ "name": "next", "version": "16.0.0" }',
      'node_modules/react/package.json': '{ "name": "react", "version": "19.0.0" }',
      'node_modules/react/jsx-runtime.js': 'exports.jsx = function () {};\n',
      'app/page.tsx': page,
      'ui/widget.tsx': client('one'),
      ...extra,
    };
    for (const [path, content] of Object.entries(files)) write(dir, path, content);
    return dir;
  };
  const moves = (dir: string) => {
    const before = fingerprint(dir);
    write(dir, 'ui/widget.tsx', client('two'));
    return fingerprint(dir) !== before;
  };
  const serverPage = "import { Used } from '../ui/widget';\nexport default function Page() { return <Used />; }\n";
  const strict = { 'byakugan.json': JSON.stringify({ mode: 'strict' }) };

  test('strict: an unused export counts when a server component imports the module, since Next.js ships it whole', () => {
    assert.equal(moves(project(serverPage, strict)), true);
  });

  test('behavior, the default: it does not count, since nothing runs it', () => {
    assert.equal(moves(project(serverPage)), false);
  });

  test('behavior: the export the server component renders still counts', () => {
    const dir = project(serverPage);
    const before = fingerprint(dir);
    write(dir, 'ui/widget.tsx', client('one').replace('used', 'changed'));
    assert.notEqual(fingerprint(dir), before);
  });

  test('the mode can come from the caller, over byakugan.json', () => {
    const dir = project(serverPage);
    const before = analyze({ cwd: dir, config: { mode: 'strict' } }).fingerprint();
    write(dir, 'ui/widget.tsx', client('two'));
    assert.notEqual(analyze({ cwd: dir, config: { mode: 'strict' } }).fingerprint(), before);
  });

  test('an unknown mode is rejected', () => {
    assert.throws(() => analyze({ cwd: project(serverPage, { 'byakugan.json': JSON.stringify({ mode: 'bytes' }) }) }), /"mode" must be one of behavior, strict/);
  });

  test('strict: it counts through a barrel and a server-side helper too', () => {
    const page = "import { Panel } from '../ui/panel';\nexport default function Page() { return <Panel />; }\n";
    const extra = {
      'ui/panel.tsx': "import { Used } from './index';\nexport const Panel = () => <Used />;\n",
      'ui/index.ts': "export * from './widget';\n",
      ...strict,
    };
    assert.equal(moves(project(page, extra)), true);
  });

  test('strict: it does not count when only client modules import the module', () => {
    assert.equal(moves(project(`'use client';\n${serverPage}`, strict)), false);
  });

  test('strict: it does not count outside Next.js', () => {
    const dir = project(serverPage, { 'byakugan.json': JSON.stringify({ mode: 'strict', framework: 'none', entry: ['app/page.tsx'] }) });
    assert.equal(moves(dir), false);
  });
});

describe('git mode for files reached by pattern', () => {
  const repo = () => {
    const dir = nextApp();
    initRepo(dir);
    return dir;
  };
  const since = (dir: string) => affected({ cwd: dir, base: 'main' });

  test('a deleted message file matched by a computed import is affected', () => {
    const dir = repo();
    rmSync(join(dir, 'messages/pl.json'));
    const result = since(dir);
    assert.ok(result.affected);
    assert.equal(result.reasons[0].key, 'messages/pl.json');
    assert.match(result.reasons[0].detail, /computed import/);
  });

  test('a new message file is affected, a new file elsewhere is not', () => {
    const dir = repo();
    write(dir, 'data/more.json', '{}\n');
    assert.equal(since(dir).affected, false);
    write(dir, 'messages/de.json', '{ "hello": "Hallo" }\n');
    assert.equal(since(dir).affected, true);
  });

  test('posts under a directory the code reads count; drafts next to it do not', () => {
    const dir = repo();
    edit(dir, 'content/drafts/draft.md', s => s.replace('Draft', 'Draft 2'));
    assert.equal(since(dir).affected, false);
    write(dir, 'content/posts/second.md', '# Second\n');
    assert.equal(since(dir).affected, true);
    commitAll(dir, 'second post');
    rmSync(join(dir, 'content/posts/first.md'));
    const result = affected({ cwd: dir, base: 'HEAD' });
    assert.ok(result.affected);
    assert.match(result.reasons[0].detail, /directory the code reads/);
  });

  test('a deleted page is affected: it leaves the graph, but it was an entry', () => {
    const dir = repo();
    rmSync(join(dir, 'app/global-not-found.tsx'));
    const result = since(dir);
    assert.ok(result.affected);
    assert.equal(result.reasons[0].key, 'app/global-not-found.tsx');
    assert.match(result.reasons[0].detail, /it was an entry/);
  });

  test('a deleted font file is affected, a deleted spare font is not', () => {
    const dir = repo();
    rmSync(join(dir, 'app/fonts/spare.woff2'));
    assert.equal(since(dir).affected, false);
    rmSync(join(dir, 'app/fonts/brand.woff2'));
    const result = since(dir);
    assert.ok(result.affected);
    assert.match(result.reasons[0].detail, /refers to this path/);
  });
});
