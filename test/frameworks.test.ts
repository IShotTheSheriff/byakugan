import assert from 'node:assert/strict';
import { mkdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { affected, analyze, loadProject } from '../src/index.ts';
import { app, write } from './helpers.ts';

const keysOf = (dir: string) => [...analyze({ cwd: dir }).live.keys()];

const sveltekit = {
  'package.json': { name: 'kit', private: true, type: 'module', devDependencies: { '@sveltejs/kit': '2.0.0', svelte: '5.0.0', vite: '6.0.0' } },
  '.gitignore': 'node_modules/\n.svelte-kit/\n',
  'svelte.config.js': 'export default { kit: {} };\n',
  'vite.config.ts': "import { sveltekit } from '@sveltejs/kit/vite';\nexport default { plugins: [sveltekit()] };\n",
  'tsconfig.json': { extends: './.svelte-kit/tsconfig.json' },
  '.svelte-kit/tsconfig.json': { compilerOptions: { paths: { $lib: ['../src/lib'], '$lib/*': ['../src/lib/*'] } } },
  'src/app.html': '<html>%sveltekit.body%</html>\n',
  'src/routes/+page.svelte': "<script lang=\"ts\">\n  import { page } from '$app/state';\n  import { price } from '$lib/money';\n  import { PUBLIC_SHOP, SECRET_KEY } from '$env/static/private';\n</script>\n\n<p>{price(2)} {page.url} {PUBLIC_SHOP} {SECRET_KEY}</p>\n",
  'src/routes/+page.server.ts': "import { price } from '$lib/money';\nexport const load = () => ({ total: price(3) });\n",
  'src/hooks.server.ts': 'export const handle = ({ event, resolve }: any) => resolve(event);\n',
  'src/lib/money.ts': 'export const price = (n: number) => n * 2;\nexport const tax = (n: number) => n * 0.2;\n',
};

describe('SvelteKit', () => {
  test('routes, hooks and configs are entries, app.html an input', () => {
    const project = loadProject({ cwd: app(sveltekit) });
    assert.equal(project.framework, 'sveltekit');
    const rel = (f: string) => f.slice(project.dir.length + 1);
    assert.deepEqual(project.entries.map(rel), ['src/hooks.server.ts', 'src/routes/+page.server.ts', 'src/routes/+page.svelte', 'svelte.config.js', 'vite.config.ts']);
    assert.ok(project.inputs.map(rel).includes('src/app.html'));
  });

  test('$lib resolves even before svelte-kit sync writes its tsconfig, and $app is no unresolved import', () => {
    const dir = app({ ...sveltekit, '.svelte-kit/tsconfig.json': '{}' });
    const graph = analyze({ cwd: dir });
    assert.ok(graph.isLive('src/lib/money.ts#price'));
    assert.ok(!graph.isLive('src/lib/money.ts#tax'));
    assert.deepEqual(graph.unresolved.filter(u => graph.isProjectImport(u)), []);
  });

  test('a value from $env/static counts, whatever its name', () => {
    const dir = app(sveltekit);
    const saved = process.env.SECRET_KEY;
    try {
      process.env.SECRET_KEY = 'a';
      const a = analyze({ cwd: dir }).fingerprint();
      process.env.SECRET_KEY = 'b';
      assert.notEqual(analyze({ cwd: dir }).fingerprint(), a);
    } finally {
      if (saved === undefined) delete process.env.SECRET_KEY;
      else process.env.SECRET_KEY = saved;
    }
  });

  test('git mode: a helper a route uses counts, an unused one and the generated tsconfig do not', () => {
    const changed = app(sveltekit, { repo: true });
    write(changed, 'src/lib/money.ts', 'export const price = (n: number) => n * 3;\nexport const tax = (n: number) => n * 0.2;\n');
    assert.equal(affected({ cwd: changed, base: 'main' }).affected, true);
    // svelte-kit sync writes the tsconfig after checkout; git ignores it.
    const { '.svelte-kit/tsconfig.json': generated, ...tracked } = sveltekit;
    const unused = app(tracked, { repo: true });
    write(unused, '.svelte-kit/tsconfig.json', JSON.stringify(generated));
    write(unused, 'src/lib/money.ts', 'export const price = (n: number) => n * 2;\nexport const tax = (n: number) => n * 0.3;\n');
    const result = affected({ cwd: unused, base: 'main' });
    assert.equal(result.affected, false, JSON.stringify(result.reasons));
  });
});

describe('Nuxt', () => {
  const nuxt = (src: string) => ({
    'package.json': { name: 'shop', private: true, type: 'module', dependencies: { nuxt: '4.0.0', vue: '3.5.0' } },
    'nuxt.config.ts': "export default defineNuxtConfig({ modules: [] });\n",
    [`${src}app.vue`]: '<template><NuxtPage /></template>\n',
    [`${src}pages/index.vue`]: "<script setup lang=\"ts\">\nimport { price } from '~/utils/money';\nimport { useCart } from '#imports';\n</script>\n<template><p>{{ price(2) }}</p></template>\n",
    [`${src}components/Card.vue`]: '<template><div>card</div></template>\n',
    [`${src}utils/money.ts`]: 'export const price = (n: number) => n * 2;\n',
    'server/api/hello.ts': "export default defineEventHandler(() => 'hi');\n",
  });

  for (const src of ['', 'app/']) {
    test(`pages, auto-imported components and server routes are entries (srcDir "${src || '.'}")`, () => {
      const dir = app(nuxt(src));
      const project = loadProject({ cwd: dir });
      assert.equal(project.framework, 'nuxt');
      const keys = keysOf(dir);
      for (const key of [`${src}app.vue`, `${src}pages/index.vue`, `${src}components/Card.vue`, `${src}utils/money.ts#price`, 'server/api/hello.ts#default']) assert.ok(keys.includes(key), key);
      const graph = analyze({ cwd: dir });
      assert.deepEqual(graph.unresolved.filter(u => graph.isProjectImport(u)), [], 'the ~ alias and #imports resolve');
    });

    test(`a stylesheet nuxt.config names through ~ counts, one it does not name does not (srcDir "${src || '.'}")`, () => {
      const files = {
        ...nuxt(src),
        'nuxt.config.ts': "export default defineNuxtConfig({ css: ['~/assets/main.css'] });\n",
        [`${src}assets/main.css`]: 'body { color: red; }\n',
        [`${src}assets/other.css`]: 'body { color: blue; }\n',
      };
      const keys = keysOf(app(files));
      assert.ok(keys.includes(`${src}assets/main.css`));
      assert.ok(!keys.includes(`${src}assets/other.css`));
      const dir = app(files, { repo: true });
      move(dir, `${src}assets/main.css`);
      assert.equal(affected({ cwd: dir, base: 'main' }).affected, true, 'deleting it counts');
    });
  }

  test('with @nuxt/content, files in content/ are inputs', () => {
    const files = nuxt('app/');
    const withContent = { ...files, 'package.json': { ...files['package.json'], dependencies: { nuxt: '4.0.0', vue: '3.5.0', '@nuxt/content': '3.0.0' } }, 'content/index.md': '# Hi\n' };
    assert.ok(keysOf(app(withContent)).includes('content/index.md'));
    assert.ok(!keysOf(app({ ...files, 'content/index.md': '# Hi\n' })).includes('content/index.md'));
  });
});

describe('Astro', () => {
  const astro = {
    'package.json': { name: 'site', private: true, type: 'module', dependencies: { astro: '5.0.0' } },
    'astro.config.mjs': "export default {};\n",
    'src/pages/index.astro': "---\nimport Layout from '../layouts/Layout.astro';\nimport { getCollection } from 'astro:content';\nimport { title } from '../lib/site';\n---\n<Layout>{title}</Layout>\n",
    'src/layouts/Layout.astro': '<html><slot /></html>\n',
    'src/lib/site.ts': "export const title = 'site';\nexport const unused = 1;\n",
    'src/components/Unused.astro': '<p>unused</p>\n',
    'src/content/posts/a.md': '# a\n',
  };

  test('pages are entries, the layout and helper they import count, an unused component does not', () => {
    const dir = app(astro);
    assert.equal(loadProject({ cwd: dir }).framework, 'astro');
    const keys = keysOf(dir);
    for (const key of ['src/pages/index.astro', 'src/layouts/Layout.astro', 'src/lib/site.ts#title', 'src/content/posts/a.md']) assert.ok(keys.includes(key), key);
    assert.ok(!keys.includes('src/components/Unused.astro'));
    assert.ok(!keys.includes('src/lib/site.ts#unused'));
  });
});

describe('React Native and Expo', () => {
  const expo = {
    'package.json': { name: 'mobile', private: true, main: 'expo-router/entry', dependencies: { expo: '53.0.0', 'expo-router': '5.0.0', 'react-native': '0.79.0' } },
    '.gitignore': 'node_modules/\n',
    'app.json': { expo: { name: 'mobile' } },
    'app/index.tsx': "import { Button } from '../components/Button';\nimport { label } from '../lib/text';\nexport default function Home() { return <Button title={label} />; }\n",
    'components/Button.tsx': "export const Button = (p: { title: string }) => 'default';\n",
    'components/Button.ios.tsx': "export const Button = (p: { title: string }) => 'ios';\n",
    'components/Button.android.tsx': "export const Button = (p: { title: string }) => 'android';\n",
    'lib/text.ts': "export const label = 'hi';\n",
    'lib/text.web.ts': "export const label = 'hi web';\n",
    'lib/unused.ts': "export const x = 1;\n",
  };

  test('Expo Router files are entries and every platform variant of an import counts', () => {
    const dir = app(expo);
    assert.equal(loadProject({ cwd: dir }).framework, 'react-native');
    const keys = keysOf(dir);
    for (const key of ['app/index.tsx#Home', 'components/Button.tsx#Button', 'components/Button.ios.tsx#Button', 'components/Button.android.tsx#Button', 'lib/text.ts#label', 'lib/text.web.ts#label']) assert.ok(keys.includes(key), key);
    assert.ok(!keys.some(k => k.startsWith('lib/unused.ts')));
  });

  test('git mode: an edit to the iOS variant counts', () => {
    const dir = app(expo, { repo: true });
    write(dir, 'components/Button.ios.tsx', "export const Button = (p: { title: string }) => 'ios!';\n");
    assert.deepEqual(affected({ cwd: dir, base: 'main' }).reasons.map(r => r.key), ['components/Button.ios.tsx#Button']);
  });

  test('a variant in another extension counts: Button.ios.js next to Button.tsx', () => {
    const { 'components/Button.ios.tsx': _, ...rest } = expo;
    const dir = app({ ...rest, 'components/Button.ios.js': "export const Button = () => 'ios js';\n" });
    const keys = keysOf(dir);
    for (const key of ['components/Button.ios.js#Button', 'components/Button.tsx#Button', 'components/Button.android.tsx#Button']) assert.ok(keys.includes(key), key);
  });

  test('git mode: deleting a platform variant counts, deleting an unused file does not', () => {
    const dir = app(expo, { repo: true });
    move(dir, 'components/Button.ios.tsx');
    assert.equal(affected({ cwd: dir, base: 'main' }).affected, true);
    const other = app(expo, { repo: true });
    move(other, 'lib/unused.ts');
    assert.equal(affected({ cwd: other, base: 'main' }).affected, false);
  });
});

/** Moves `path` out of the project, as a deletion git sees. */
const move = (dir: string, path: string) => {
  mkdirSync(join(dir, '..', 'moved'), { recursive: true });
  renameSync(join(dir, path), join(dir, '..', 'moved', path.replaceAll('/', '_')));
};
