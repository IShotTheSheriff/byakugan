# Frameworks and workspaces

This page shows how byakugan finds entries and hidden inputs in each framework it detects, and how it picks the apps of a workspace. Every row comes from a test. [frameworks.md](../frameworks.md) has the short version with results from real projects.

[All examples](README.md)

## Next.js `'use server'` files

Every export of a `'use server'` file counts, imported or not. Next.js may register each one as a server action endpoint. A plain module next to it keeps per-export precision.

```ts
// app/page.tsx
import { save } from './actions';
import { formatPrice } from './lib';

// app/actions.ts
'use server';
export async function save() { return 'saved'; }
export async function remove() { return 'removed'; }

// app/lib.ts
export const formatPrice = (n: number) => '$' + n;
export const formatTax = (n: number) => n * 0.23;
```

| Change | Result | Test |
| --- | --- | --- |
| Change `0.23` to `0.08` in `formatTax`, an export nobody imports | unaffected | [next.test.ts:121](../../test/next.test.ts#L121) |
| Change `'removed'` to `'deleted'` in `remove`, an export nobody imports | affected | [next.test.ts:121](../../test/next.test.ts#L121) |

## Next.js `'use client'` modules and `strict`

When a server component imports a `'use client'` module, Next.js ships that module to the browser whole. The default `behavior` mode counts only the exports the app can run. `strict` mode counts every export, since every one of them ends up in the bundle.

```tsx
// ui/widget.tsx
'use client';
export const Used = () => <b>used</b>;
export const Unused = () => <i>one</i>;

// app/page.tsx, a server component
import { Used } from '../ui/widget';
export default function Page() { return <Used />; }
```

| Change | Result | Test |
| --- | --- | --- |
| Change `one` to `two` in `Unused` | affected (strict) | [next.test.ts:155](../../test/next.test.ts#L155), [cli.test.ts:187](../../test/cli.test.ts#L187) |
| The same edit in `behavior` mode | unaffected | [next.test.ts:159](../../test/next.test.ts#L159), [cli.test.ts:194](../../test/cli.test.ts#L194) |
| Change the text of `Used` in `behavior` mode | affected | [next.test.ts:163](../../test/next.test.ts#L163) |
| Change `Unused` with `strict` passed by the caller instead of byakugan.json | affected (strict) | [next.test.ts:170](../../test/next.test.ts#L170) |
| Change `Unused` when the page reaches `widget` through `ui/panel.tsx` and an `export *` barrel `ui/index.ts` | affected (strict) | [next.test.ts:181](../../test/next.test.ts#L181) |
| Change `Unused` when the page is itself `'use client'` | unaffected (strict) | [next.test.ts:191](../../test/next.test.ts#L191) |
| Change `Unused` with `framework: 'none'` | unaffected (strict) | [next.test.ts:195](../../test/next.test.ts#L195) |

Only an import that crosses from a server module into a client module triggers the rule. Client modules that import each other keep per-export precision.

## Next.js files reached without a static import

A Next.js app reads many files that no `import` statement names. byakugan follows computed `import()` calls, `fs` reads under `process.cwd()`, `new URL(..., import.meta.url)`, `localFont({ src })` paths and `url()` in stylesheets.

```tsx
// app/[locale]/page.tsx
const messages = (await import(`../../messages/${locale}.json`)).default;

// app/legacy/page.tsx
const strings = await import('./locales/' + lang + '.js');

// app/blog/[slug]/page.tsx
await readFile(join(process.cwd(), 'content', 'posts', `${slug}.md`), 'utf8');

// app/worker/page.tsx
new Worker(new URL('./worker.ts', import.meta.url));

// app/fonts.ts
export const brand = localFont({ src: './fonts/brand.woff2' });

// app/computed/page.tsx
return (await import(name)).default;
```

```css
/* app/globals.css */
@import "style-only";
body { background: url("./bg.png"), url(/hero.png); }
```

The project also holds `messages/en.json`, `messages/pl.json`, `data/other.json`, `content/posts/first.md`, `content/drafts/draft.md`, `app/fonts/spare.woff2`, `app/global-not-found.tsx` and `i18n/request.ts`.

| Change | Result | Test |
| --- | --- | --- |
| Build the graph | `messages/en.json`, `messages/pl.json`, `app/legacy/locales/en.js#title`, `content/posts/first.md`, `app/fonts/brand.woff2`, `app/worker/worker.ts`, `npm:style-only/dist/style.css` and `app/bg.png` are live. `data/other.json`, `content/drafts/draft.md` and `app/fonts/spare.woff2` are not | [next.test.ts:96](../../test/next.test.ts#L96) |
| Build the graph | warns `cannot follow an import with a computed specifier` for `import(name)` | [next.test.ts:116](../../test/next.test.ts#L116) |
| Delete `messages/pl.json` | affected, reason `messages/pl.json`, detail names the computed import | [next.test.ts:209](../../test/next.test.ts#L209) |
| Add `data/more.json` | unaffected | [next.test.ts:218](../../test/next.test.ts#L218) |
| Add `messages/de.json` | affected | [next.test.ts:218](../../test/next.test.ts#L218) |
| Edit `content/drafts/draft.md` | unaffected | [next.test.ts:226](../../test/next.test.ts#L226) |
| Add `content/posts/second.md` | affected | [next.test.ts:226](../../test/next.test.ts#L226) |
| Delete `content/posts/first.md` | affected, detail names the directory the code reads | [next.test.ts:226](../../test/next.test.ts#L226) |
| Delete `app/fonts/spare.woff2` | unaffected | [next.test.ts:248](../../test/next.test.ts#L248) |
| Delete `app/fonts/brand.woff2` | affected, detail says code refers to this path | [next.test.ts:248](../../test/next.test.ts#L248) |

The `readFile` call reaches every file under `content/posts/` and nothing in `content/drafts/` next to it. A new post counts with no code change at all.

`import(name)` gives byakugan no pattern to match, so it warns. [limits.md](../limits.md) covers computed imports, and `inputs` in byakugan.json can list the files by hand.

## Next.js entries and tracked packages

Next.js loads some files by name, and some packages only appear as strings in config files.

```ts
// next.config.ts
export default {
  turbopack: { rules: { '*.svg': { loaders: ['@svgr/webpack'], as: '*.js' } } },
};

// postcss.config.mjs
export default { plugins: { '@tailwindcss/postcss': {} } };
```

| Change | Result | Test |
| --- | --- | --- |
| Load the project | `app/global-not-found.tsx` and the next-intl config `i18n/request.ts` are entries | [next.test.ts:84](../../test/next.test.ts#L84) |
| Load the project | `@svgr/webpack` and `@tailwindcss/postcss` are tracked by version | [next.test.ts:90](../../test/next.test.ts#L90) |
| Delete `app/global-not-found.tsx` | affected, reason `app/global-not-found.tsx`, detail says it was an entry | [next.test.ts:239](../../test/next.test.ts#L239) |

## Vite

Vite starts from `<script type="module">` tags in `index.html`. byakugan reads the same tags, plus the stylesheets the page links and the pages `vite.config.ts` lists in `rollupOptions.input`.

```html
<!-- index.html -->
<script type="module" src="/src/main.tsx"></script>
```

```ts
// src/main.tsx
import { App } from './App';
import './index.css';

// src/App.tsx
import { title } from './copy';

// src/copy.ts
export const title = 'Hello';
export const footer = 'Bye';
```

| Change | Result | Test |
| --- | --- | --- |
| Build the graph | entries `src/main.tsx` and `vite.config.ts`. `src/index.css`, `index.html` and `public/robots.txt` are live, `copy.ts#footer` is not | [vite.test.ts:22](../../test/vite.test.ts#L22) |
| Change `footer` from `'Bye'` to `'Ciao'` | unaffected | [vite.test.ts:35](../../test/vite.test.ts#L35) |
| Change `title` from `'Hello'` to `'Hi'` | affected | [vite.test.ts:35](../../test/vite.test.ts#L35) |

A stylesheet counts when `index.html` links it.

```html
<!-- index.html -->
<link rel="stylesheet" href="/src/style.css">
```

| Change | Result | Test |
| --- | --- | --- |
| Edit `src/unlinked.css`, which no page links | unaffected | [resolution.test.ts:713](../../test/resolution.test.ts#L713) |
| Edit `src/style.css` | affected, reason `source:src/style.css` | [resolution.test.ts:713](../../test/resolution.test.ts#L713) |

For a multi-page app, `vite.config.ts` lists `index.html` and `admin/index.html` in `rollupOptions.input`, and `drafts/index.html` also exists.

| Change | Result | Test |
| --- | --- | --- |
| Load the project | `src/admin.ts` from `admin/index.html` is an entry. `src/draft.ts` from `drafts/index.html` is not | [resolution.test.ts:731](../../test/resolution.test.ts#L731) |

## Hono on Cloudflare Workers

The `main` field of the wrangler config is the entry. The config itself and the `assets.directory` it names are inputs. byakugan tracks the `wrangler` version, since wrangler bundles the worker.

```jsonc
// wrangler.jsonc
{ "main": "src/worker.ts", "compatibility_date": "2026-01-01", "assets": { "directory": "./static" } }
```

```ts
// src/worker.ts
import { Hono } from 'hono';
import { env } from 'cloudflare:workers';
import { Database } from 'bun:sqlite';
import { routes } from './routes';

// src/routes.ts
export const routes = (env, db) => [env, db];
export const unused = () => 'unused';
```

| Change | Result | Test |
| --- | --- | --- |
| Build the graph | entry `src/worker.ts`. `wrangler.jsonc`, `static/logo.svg`, `routes.ts#routes` and `npm:hono/index.js#Hono` are live, `routes.ts#unused` is not, `wrangler` is tracked | [hono.test.ts:36](../../test/hono.test.ts#L36) |
| Build the graph | `cloudflare:workers` and `bun:sqlite` are not reported as unresolved | [hono.test.ts:46](../../test/hono.test.ts#L46) |
| Edit `README.md` | unaffected | [hono.test.ts:50](../../test/hono.test.ts#L50) |
| Change `compatibility_date` in `wrangler.jsonc` | affected | [hono.test.ts:50](../../test/hono.test.ts#L50) |

## Hono on Node.js

When `package.json` names no entry, byakugan takes `src/index.ts`, `src/server.ts` or `src/app.ts`. `serveStatic` makes its `root` directory and its `path` file part of the graph.

```ts
// src/server.ts
export const app = new Hono()
  .use('*', cors())
  .use('/static/*', serveStatic({ root: './public' }))
  .get('/favicon.ico', serveStatic({ path: './assets/favicon.ico' }));
```

| Change | Result | Test |
| --- | --- | --- |
| Load the project | `src/server.ts` is the entry | [hono.test.ts:73](../../test/hono.test.ts#L73) |
| Build the graph | `public/site.css` and `assets/favicon.ico` are live, `assets/other.ico` is not | [hono.test.ts:78](../../test/hono.test.ts#L78) |
| Add `public/robots.txt` | affected | [hono.test.ts:78](../../test/hono.test.ts#L78) |

## HonoX and `import.meta.glob`

HonoX's entries are `app/server.ts`, `app/client.ts`, the files under `app/routes/` and the client inputs `vite.config.ts` names. HonoX finds routes with `import.meta.glob`, and byakugan follows that call in any file, negative patterns included.

```ts
// vite.config.ts
export default { plugins: [{ client: { input: ['/app/client.ts', '/app/style.css'] } }] };

// app/server.ts
export default import.meta.glob(['/app/pages/*.ts', '!/app/pages/_draft.ts'], { eager: true });
```

| Change | Result | Test |
| --- | --- | --- |
| Load the project | `app/server.ts`, `app/client.ts`, `app/routes/index.tsx` and `app/style.css` are entries | [hono.test.ts:104](../../test/hono.test.ts#L104) |
| Build the graph | `app/pages/home.ts#title` is live, `app/pages/_draft.ts#title` is not | [hono.test.ts:110](../../test/hono.test.ts#L110) |
| Delete `app/pages/home.ts` | affected, reason `app/pages/home.ts`, detail names the computed import | [hono.test.ts:116](../../test/hono.test.ts#L116) |
| Delete `app/routes/index.tsx` | affected, reason `app/routes/index.tsx`, detail says it was an entry | [hono.test.ts:116](../../test/hono.test.ts#L116) |

## Hono RPC across two apps

A Hono RPC client imports only the server's type. byakugan follows `import type` through types alone, so the client gets the route declarations, the handlers and the helpers whose return values shape a response. The server's bootstrap code stays out, and so do packages only that code imports. A package the client reaches only through types counts as `npm:<pkg>#<types>`.

```ts
// apps/api/src/index.ts
import 'dotenv/config';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { products } from './products';
const app = new Hono().route('/products', products);
export type AppType = typeof app;
serve({ fetch: app.fetch, port: 3001 });

// apps/api/src/products.ts
import { z } from 'zod';
import { listProducts } from './db';
export const products = new Hono().get('/', c => c.json(listProducts(z.string())));

// apps/api/src/db.ts
export const listProducts = (schema: unknown) => [{ id: '1', schema }];
export const resetDatabase = () => 'reset';

// apps/web/src/main.ts
import { hc } from 'hono/client';
import type { AppType } from '@acme/api';
export const client = hc<AppType>('/');
```

| Change | Result | Test |
| --- | --- | --- |
| Build the graph for `apps/web` | `index.ts#AppType`, `products.ts#products` and `npm:zod#<types>` are live. `index.ts#<module>`, `db.ts#resetDatabase` and anything from `@hono/node-server` or `dotenv` are not | [hono.test.ts:181](../../test/hono.test.ts#L181) |
| Change the port to 3002, drop `import 'dotenv/config'`, bump `@hono/node-server` in the lockfile and edit `resetDatabase`, all at once | `apps/web` unaffected | [hono.test.ts:193](../../test/hono.test.ts#L193) |
| Change `id: '1'` to `id: 1` in `listProducts` | `apps/web` affected | [hono.test.ts:193](../../test/hono.test.ts#L193) |
| Bump `zod` in the lockfile | `apps/web` affected, reasons exactly `['zod']` | [hono.test.ts:193](../../test/hono.test.ts#L193) |
| Drop `import 'dotenv/config'` | `apps/api` affected | [hono.test.ts:207](../../test/hono.test.ts#L207) |
| Bump `@hono/node-server` in the lockfile | `apps/api` affected | [hono.test.ts:207](../../test/hono.test.ts#L207) |

The `listProducts` edit changes the inferred `AppType`, so the client counts it even though it never runs server code. There is no type checker, so a handler body edit counts even when the response type stays the same. See [limits.md](../limits.md).

## SvelteKit

Routes, hooks and config files are entries. `$lib` resolves before `svelte-kit sync` writes `.svelte-kit/tsconfig.json`, and `$app/*` is not reported as unresolved. SvelteKit inlines every name imported from `$env/static/*`, so each one counts by value, whatever its prefix.

```svelte
<!-- src/routes/+page.svelte -->
<script lang="ts">
  import { page } from '$app/state';
  import { price } from '$lib/money';
  import { PUBLIC_SHOP, SECRET_KEY } from '$env/static/private';
</script>
```

```ts
// src/routes/+page.server.ts
import { price } from '$lib/money';

// src/lib/money.ts
export const price = (n: number) => n * 2;
export const tax = (n: number) => n * 0.2;
```

| Change | Result | Test |
| --- | --- | --- |
| Load the project | entries `src/hooks.server.ts`, `+page.server.ts`, `+page.svelte`, `svelte.config.js` and `vite.config.ts`. `src/app.html` is an input | [frameworks.test.ts:25](../../test/frameworks.test.ts#L25) |
| Build the graph with an empty generated tsconfig | `money.ts#price` is live, `money.ts#tax` is not, `$app/state` is not unresolved | [frameworks.test.ts:33](../../test/frameworks.test.ts#L33) |
| Change `SECRET_KEY` from `a` to `b` in the environment | affected | [frameworks.test.ts:41](../../test/frameworks.test.ts#L41) |
| Edit `price` | affected | [frameworks.test.ts:55](../../test/frameworks.test.ts#L55) |
| Edit `tax` while `svelte-kit sync` has written the git-ignored `.svelte-kit/tsconfig.json` | unaffected | [frameworks.test.ts:55](../../test/frameworks.test.ts#L55) |

## Nuxt

Pages, `app.vue`, auto-imported components and server routes are entries. `~` and `#imports` resolve. A stylesheet that `css` in `nuxt.config.ts` names through `~` counts. The tests run each case twice, with `srcDir` set to `.` and to `app/`.

```ts
// nuxt.config.ts
export default defineNuxtConfig({ css: ['~/assets/main.css'] });
```

```vue
<!-- pages/index.vue -->
<script setup lang="ts">
import { price } from '~/utils/money';
import { useCart } from '#imports';
</script>
```

The project also holds `components/Card.vue`, which no file imports, `server/api/hello.ts` and `assets/other.css`.

| Change | Result | Test |
| --- | --- | --- |
| Build the graph | `app.vue`, `pages/index.vue`, `components/Card.vue`, `utils/money.ts#price` and `server/api/hello.ts#default` are live | [frameworks.test.ts:81](../../test/frameworks.test.ts#L81) |
| Build the graph | `assets/main.css` is live, `assets/other.css` is not | [frameworks.test.ts:91](../../test/frameworks.test.ts#L91) |
| Delete `assets/main.css` | affected | [frameworks.test.ts:91](../../test/frameworks.test.ts#L91) |
| Add `content/index.md` with `@nuxt/content` installed | `content/index.md` is live | [frameworks.test.ts:107](../../test/frameworks.test.ts#L107) |
| Add `content/index.md` without `@nuxt/content` | `content/index.md` is not live | [frameworks.test.ts:107](../../test/frameworks.test.ts#L107) |

`components/Card.vue` counts with no page rendering it, because Nuxt imports components for you. [limits.md](../limits.md) lists this under single-file components.

## Astro

Files under `src/pages/` are entries. A page's frontmatter imports keep per-export precision. Content files under `src/content/` count too.

```astro
---
// src/pages/index.astro
import Layout from '../layouts/Layout.astro';
import { getCollection } from 'astro:content';
import { title } from '../lib/site';
---
```

| Change | Result | Test |
| --- | --- | --- |
| Build the graph | `pages/index.astro`, `layouts/Layout.astro`, `lib/site.ts#title` and `src/content/posts/a.md` are live. `components/Unused.astro` and `lib/site.ts#unused` are not | [frameworks.test.ts:126](../../test/frameworks.test.ts#L126) |

## React Router and Remix

In framework mode, byakugan reads `app/routes.ts` and makes every module it names an entry, along with `app/root.tsx` and the config files. A module in `app/` that no route names stays out.

```ts
// app/routes.ts
import { index, route } from '@react-router/dev/routes';
export default [index('routes/home.tsx'), route('about', 'pages/about.tsx')];
// app/pages/draft.tsx exists, but no route names it
```

| Change | Result | Test |
| --- | --- | --- |
| Load the project | entries `app/pages/about.tsx`, `app/root.tsx`, `app/routes.ts`, `app/routes/home.tsx`, `react-router.config.ts` and `vite.config.ts` | [resolution.test.ts:305](../../test/resolution.test.ts#L305) |
| Edit `app/routes/home.tsx`, `app/pages/about.tsx` and `react-router.config.ts` | affected, reasons `source:app/pages/about.tsx#About`, `source:app/routes/home.tsx#Home` and `source:react-router.config.ts#default` | [resolution.test.ts:320](../../test/resolution.test.ts#L320) |
| Edit `app/pages/draft.tsx` | unaffected | [resolution.test.ts:332](../../test/resolution.test.ts#L332) |
| Load a Remix app with `@remix-run/dev`, `app/root.tsx`, `app/routes/_index.tsx` and `app/utils.ts` | framework `react-router`, entries `app/root.tsx`, `app/routes/_index.tsx` and `vite.config.ts`, not `app/utils.ts` | [resolution.test.ts:339](../../test/resolution.test.ts#L339) |

## Expo and React Native platform variants

Metro picks one platform file per build, `Button.ios.tsx` on iOS and `Button.android.tsx` on Android. byakugan cannot know which build runs, so one import of `../components/Button` brings in every variant, in any code extension.

```ts
// app/index.tsx, an Expo Router entry
import { Button } from '../components/Button';
import { label } from '../lib/text';
// components/Button.tsx, Button.ios.tsx, Button.android.tsx
// lib/text.ts, lib/text.web.ts, lib/unused.ts
```

| Change | Result | Test |
| --- | --- | --- |
| Build the graph | every variant of `Button` and of `text` is live, nothing from `lib/unused.ts` is | [frameworks.test.ts:150](../../test/frameworks.test.ts#L150) |
| Edit `Button.ios.tsx` | affected, reason `components/Button.ios.tsx#Button` | [frameworks.test.ts:158](../../test/frameworks.test.ts#L158) |
| Replace `Button.ios.tsx` with `Button.ios.js` next to `Button.tsx` | `Button.ios.js#Button` is live with the others | [frameworks.test.ts:164](../../test/frameworks.test.ts#L164) |
| Delete `Button.ios.tsx` | affected | [frameworks.test.ts:171](../../test/frameworks.test.ts#L171) |
| Delete `lib/unused.ts` | unaffected | [frameworks.test.ts:171](../../test/frameworks.test.ts#L171) |

## Vue, Svelte and Astro components

byakugan hashes a `.vue`, `.svelte` or `.astro` file whole, so any edit to the file counts. The modules its scripts import keep per-export precision. In a Vue file, the assets the template names, child components and `@import` in `<style>` count too.

```vue
<!-- src/App.vue -->
<script setup lang="ts">
import { Button } from './ui';
import { price } from './money';
import Child from './Child.vue';
</script>
<template>
  <img src="./logo.png" />
  <Button>{{ price(2) }}</Button>
  <Child />
</template>
<style lang="scss">
@import './theme';
</style>
```

```ts
// src/money.ts
export const price = (n: number) => n * 2;
export const tax = (n: number) => n * 0.2;

// src/ui/index.ts
export { Button } from './Button';
export { Card } from './Card';
```

The Svelte and Astro versions import `Button` and `price` the same way. The first four rows run for all three, in git mode.

| Change | Result | Test |
| --- | --- | --- |
| Edit `price` | affected, reason `src/money.ts#price` | [components.test.ts:64](../../test/components.test.ts#L64) |
| Edit `tax` | unaffected | [components.test.ts:70](../../test/components.test.ts#L70) |
| Edit `ui/Card.ts`, a barrel sibling the component does not import | unaffected | [components.test.ts:75](../../test/components.test.ts#L75) |
| Change `price(2)` to `price(3)` inside the component | affected | [components.test.ts:79](../../test/components.test.ts#L79) |
| Vue: edit `src/logo.png`, `Child.vue` or `_theme.scss` | affected, each one | [components.test.ts:86](../../test/components.test.ts#L86) |
| Vue: build the graph | `App.vue`, `Child.vue`, `money.ts#price`, `logo.png` and `_theme.scss` are live, `money.ts#tax` is not | [components.test.ts:92](../../test/components.test.ts#L92) |

byakugan reads component blocks from text, so a few edge cases have their own tests.

| Change | Result | Test |
| --- | --- | --- |
| A `>` inside a script attribute, `generic="T extends Record<string, number>"` | `money.ts#price` is still live | [components.test.ts:103](../../test/components.test.ts#L103) |
| A `<script>` inside an HTML comment imports `price` | `money.ts#price` is not live | [components.test.ts:108](../../test/components.test.ts#L108) |
| A script with a syntax error imports `price` | `money.ts` is still live | [components.test.ts:113](../../test/components.test.ts#L113) |
| `srcset="./a.png 1x, ./b.png 2x"` and an unquoted `src=./c.png` | `a.png`, `b.png` and `c.png` are live | [components.test.ts:118](../../test/components.test.ts#L118) |
| Change `VITE_URL`, which a Vue script reads as `import.meta.env.VITE_URL` | affected | [components.test.ts:124](../../test/components.test.ts#L124) |

## Environment variables

By default a variable counts when the bundler inlines it and live code reads it. That means `NEXT_PUBLIC_*` in Next.js, `VITE_*` in Vite and any `$env/static` name in SvelteKit. A server-only secret counts only when `env` in byakugan.json names it.

```ts
// lib/config.ts in a Next.js app. app/page.tsx imports only url.
export const url = process.env.NEXT_PUBLIC_URL;
export const unused = process.env.NEXT_PUBLIC_UNUSED;
export const secret = process.env.SECRET;
```

| Change | Result | Test |
| --- | --- | --- |
| Change `NEXT_PUBLIC_URL` from `https://a` to `https://b` | affected | [env.test.ts:55](../../test/env.test.ts#L55) |
| Change `NEXT_PUBLIC_UNUSED` and `SECRET` | unaffected | [env.test.ts:62](../../test/env.test.ts#L62) |
| Read `process.env.API_URL`, set `"env": ["API_*"]` in byakugan.json, change `API_URL` | affected | [env.test.ts:69](../../test/env.test.ts#L69) |
| Save a manifest with `NEXT_PUBLIC_URL=https://a`, then run with `https://b` | affected, reason `env:NEXT_PUBLIC_URL` | [env.test.ts:78](../../test/env.test.ts#L78) |
| Vite, `const env = import.meta.env` used whole, change `VITE_A` | affected | [env.test.ts:86](../../test/env.test.ts#L86) |
| The same code, change `SECRET_A` | unaffected | [env.test.ts:86](../../test/env.test.ts#L86) |
| `summarize` the graph | env `{ read: ['NEXT_PUBLIC_URL'], counted: ['NEXT_PUBLIC_URL'] }` | [env.test.ts:98](../../test/env.test.ts#L98) |

The parser takes names from these forms:

```ts
process.env.NEXT_PUBLIC_A;
process.env['B'];
import.meta.env.VITE_C;
const { D, E: e } = process.env;
process.env?.F;
```

| Change | Result | Test |
| --- | --- | --- |
| Parse the five forms above | names `B`, `D`, `E`, `F`, `NEXT_PUBLIC_A`, `VITE_C` | [env.test.ts:34](../../test/env.test.ts#L34) |
| Parse `process.env[k]` with a computed `k`, and `process.env` passed whole | no names | [env.test.ts:43](../../test/env.test.ts#L43) |

Git mode compares no values, since the base commit has no environment. A variable read by a computed name or from a config file needs an entry in `env`. [limits.md](../limits.md) describes both.

## Which workspace packages are apps

`--workspace` runs byakugan once per app. A package counts as a library when another package lists it in `dependencies`. A package listed only in `devDependencies` is an app when it has a `start` script.

```jsonc
// package.json
{ "workspaces": ["packages/*"] }

// packages/e2e/package.json
{ "devDependencies": { "server": "*", "tools": "*" } }
```

| Setup | Result | Test |
| --- | --- | --- |
| `server` has a `start` script | apps `e2e` and `server` | [workspace.test.ts:23](../../test/workspace.test.ts#L23) |
| `server` has no `start` script | app `e2e` only | [workspace.test.ts:28](../../test/workspace.test.ts#L28) |
| `e2e` lists only `server`, in `dependencies`, and `server` has `start` | apps `e2e` and `tools`, `server` is a library | [workspace.test.ts:33](../../test/workspace.test.ts#L33) |

In the third row, `tools` becomes an app because no package lists it any more. The rule is that no other package depends on it, which can catch a package you think of as a library.

A library may have a framework in its dependencies, for example `next` for its types.

| Setup | Result | Test |
| --- | --- | --- |
| `packages/logging` has `next` in `devDependencies`, and `apps/web` depends on it | app `apps/web` only | [workspace.test.ts:52](../../test/workspace.test.ts#L52) |
| The same, plus `packages/logging/next.config.ts` | apps `apps/web` and `packages/logging` | [workspace.test.ts:56](../../test/workspace.test.ts#L56) |
| The same without the config file, but nothing depends on `logging` | apps `apps/web` and `packages/logging` | [workspace.test.ts:61](../../test/workspace.test.ts#L61) |
| Nx, `project.json` with `projectType: application` in `apps/api` and `library` in `libs/util` | app `apps/api` only | [workspace.test.ts:79](../../test/workspace.test.ts#L79) |
| The same, with a `byakugan.json` in `libs/util` | apps `apps/api` and `libs/util` | [workspace.test.ts:83](../../test/workspace.test.ts#L83) |
| `pnpm-workspace.yaml` in flow style, and in block style with a comment | both read as `['apps/*', 'packages/*']` | [workspace.test.ts:93](../../test/workspace.test.ts#L93) |

## Framework detection in workspaces

byakugan detects an app's framework from the app's own `package.json`. When the app has none, it reads the root one. A root package can also complete an app that declares only part of a framework.

| Setup | Change | Result | Test |
| --- | --- | --- | --- |
| Nx app `apps/web` with `project.json` and no `package.json`, root declares `vite` and `left-pad` | Load the project | framework `vite`, packages `['vite']`, `public/logo.svg` is an input | [resolution.test.ts:386](../../test/resolution.test.ts#L386) |
| The same | Bump `left-pad` in the root `package-lock.json` | unaffected | [resolution.test.ts:395](../../test/resolution.test.ts#L395) |
| The same | Bump `vite` in the root `package-lock.json` | affected, reason `dependency:vite` | [resolution.test.ts:395](../../test/resolution.test.ts#L395) |
| `apps/api` has its own `package.json`, root declares `vite` for vitest | Edit `apps/api/src/h.ts`, which the entry imports | framework `none`, entry `src/index.ts`, affected, reason `source:apps/api/src/h.ts#h` | [resolution.test.ts:821](../../test/resolution.test.ts#L821) |
| The same | Edit `apps/api/src/unused.ts` | unaffected, root `typescript` still tracked | [resolution.test.ts:830](../../test/resolution.test.ts#L830) |
| `apps/web` declares only `react-router`, root declares `vite` and `@react-router/dev` | Edit `apps/web/app/root.tsx` | framework `react-router`, affected, reason `source:apps/web/app/root.tsx#Root` | [resolution.test.ts:858](../../test/resolution.test.ts#L858) |
| The same | Edit `apps/web/app/unused.ts` | unaffected | [resolution.test.ts:865](../../test/resolution.test.ts#L865) |

A root `vite` devDependency does not turn a plain server app into a Vite app. It does complete a React Router app whose package declares only `react-router`.

## `--workspace` on the command line

```
packages/ui/src/cx.ts          library @acme/ui
apps/web/components/Hero.tsx   Next.js app that uses @acme/ui
apps/docs/src/index.ts         app that uses nothing from @acme/ui
```

| Change | Result | Test |
| --- | --- | --- |
| Add an unused export to `packages/ui/src/cx.ts` and edit the text in `Hero.tsx` | `apps/web` affected, `apps/docs` unaffected, the library is not listed | [cli.test.ts:116](../../test/cli.test.ts#L116) |
| No change | both apps unaffected, exit 0 | [cli.test.ts:131](../../test/cli.test.ts#L131) |
| Hash one manifest per app, then rename `'docs'` to `'handbook'` in `apps/docs/src/index.ts` | manifest mode, `apps/docs` affected, `apps/web` unaffected, exit 1 | [cli.test.ts:139](../../test/cli.test.ts#L139) |
| `apps/docs/byakugan.json` sets `"entry"` to a string, so its graph fails | `apps/docs` reported affected with `error:` | [cli.test.ts:151](../../test/cli.test.ts#L151) |

An app whose graph fails counts as affected, so a broken config never hides a change.

## One parse cache for all workspace apps

The CLI gives every app's graph one module cache, so byakugan parses a shared file once. The cache keys on parse options, so one app's compiler settings never leak into another's graph.

| Change | Result | Test |
| --- | --- | --- |
| Build two apps with a shared cache | each app's graph, fingerprint and warnings equal what it gets alone | [workspace.test.ts:118](../../test/workspace.test.ts#L118) |
| App `a` uses `jsx: react` and `verbatimModuleSyntax`, app `b` uses `react-jsx`, both import the same `ui` file | different live keys | [workspace.test.ts:131](../../test/workspace.test.ts#L131) |
