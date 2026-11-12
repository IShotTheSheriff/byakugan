# How byakugan works

1. **Entries.** Every export of an entry counts as used. byakugan finds
   entries by framework:

   - Next.js: App Router files (`page`, `layout`, `route`, `loading`, `error`,
     `not-found`, `global-not-found`, metadata routes and the rest), everything
     under `pages/`, `middleware` or `proxy`, `instrumentation`,
     `mdx-components`, `next.config.*`, and files that plugins load by
     convention (next-intl `i18n/request.ts`, Sentry `sentry.*.config.ts`).
   - Vite: the `<script src>` tags in `index.html`, and `vite.config.*`.
   - React Router v7 and Remix: `root`, `entry.client`, `entry.server`,
     `routes.ts` and `routes/**`.
   - Nuxt: `app.vue`, `error.vue`, `pages`, `layouts`, `plugins`,
     `middleware`, `server`, and `components`, `composables` and `utils`,
     since Nuxt imports those for you. Both the root and Nuxt 4's `app/`
     layout work. A file the config names through an alias, such as
     `css: ['~/assets/main.css']`, counts. With `@nuxt/content`, `content/**`
     is an input.
   - SvelteKit: `src/routes/**`, `src/hooks.*`, `src/params`, the service
     worker, `svelte.config.js` and `vite.config.*`. `src/app.html` and
     `static/**` are inputs.
   - Astro: `src/pages/**`, the middleware, the content collection config and
     `astro.config.*`. `src/content/**` and `public/**` are inputs.
   - React Native and Expo: every file under `app/` with Expo Router, then
     `index.*`, `App.*`, `app.config.*` and `metro.config.*`. An import counts
     every platform variant that exists, such as `Button.ios.tsx` and
     `Button.android.js`, because Metro picks one per platform. Deleting a
     variant counts too.
   - Anything else: `package.json` fields, then `{index,main,server,app}.*` in
     the root or in `src/`.

   Every project also gets `main` from `wrangler.{toml,json,jsonc}`, Vercel
   `api/**` and Netlify functions, files a config names in a string (Vite
   inputs such as `/app/client.ts`), and the `entry` globs from
   `byakugan.json`.
2. **Fragments.** [oxc-parser][oxc] splits each reached module into fragments:
   top-level declarations, import bindings, export specifiers, `export *` lines,
   and the module's side effects (directives such as `'use client'`, bare
   imports such as `import './polyfill'`, and top-level statements).
   `declare global` and `declare module` blocks form a separate types fragment.
   byakugan records, per declaration, which top-level names it refers to.

   A `.vue`, `.svelte` or `.astro` file counts whole, since its template uses
   its script in ways byakugan does not read. Its `<script>` blocks (and
   Astro's frontmatter) are parsed, and their imports count by imported name,
   so a barrel still splits. So do `<style>` imports, `<script src>` and asset
   paths in the template such as `src="./logo.png"`.

   A fragment's hash comes from its syntax tree, not its text. Comments,
   whitespace, quote style, semicolons, trailing commas, parentheses that do
   not change precedence and the way a number is written leave no trace. So a
   Prettier run with other settings changes nothing, and neither does a
   comment that labels an argument, as in `f(/* force */ true)`. A line break
   that changes the code, as after `return`, still counts, because the parser
   reads it. Whitespace in JSX text counts the way the JSX compiler keeps it.
   These comments still count, each with the code after it, because they change
   what a tool does:

   - minifier and bundler hints: `#__PURE__`, `webpackChunkName`, `@vite-ignore`
   - legal comments: `/*!`, `//!`, `@license`, `@preserve`
   - TypeScript directives: `@ts-expect-error`, `@ts-ignore`, `@ts-nocheck`, `///`
   - test environments and coverage hints: `@vitest-environment`, `istanbul ignore`
   - JSX pragmas such as `@jsxImportSource`
   - JSDoc tags in JavaScript files that TypeScript checks, with `checkJs` or
     `// @ts-check`

   Such a comment outside every declaration, like `// @ts-expect-error` above
   an import, counts with the module's side effects.
3. **Walk.** A used export leads to its declaration. The declaration leads to
   the names it refers to. An import binding leads to the export of the module
   it resolves to. [oxc-resolver][oxc-resolver] does the resolving, with
   tsconfig `paths` and `exports` conditions for browser, node and
   `react-server`. The walk crosses `export *` barrels, namespace imports used
   as `ns.member`, `import()`, `require()`, `next/dynamic`, `React.lazy`, the
   implicit JSX runtime and workspace symlinks. It also follows paths that are
   not imports at all, listed under
   [Next.js, Tailwind and shadcn](frameworks.md#nextjs-tailwind-and-shadcn).

   An `export *` line counts when a name the app takes passes through it. A
   new `export *` line in a barrel reaches no app that imports only other
   names from that barrel. It counts when its module exports a name the app
   takes, when something imports the barrel's whole namespace, when the module
   it adds runs top-level code, and when that module does not resolve.

   byakugan follows an `import type` through types only. The declarations it
   reaches count, but the target module does not run. Its side effects stay
   out, and so do packages that only its runtime code imports.
4. **Modules that run.** Importing a module runs it, so its side-effect
   fragment counts even when no export is used. Packages with
   `"sideEffects": false` are skipped unless a binding is used, as bundlers do.
   `Button.displayName = 'Button'` belongs to `Button`, not to the module.
5. **Hash.** The fingerprint is SHA-256 over the sorted `(key, hash)` pairs of
   live fragments. Keys are relative to the workspace root: the nearest
   directory with a lockfile or `pnpm-workspace.yaml`, searched up to the git
   root. A source tarball without `.git` gets the same keys as a clone. Files in
   `node_modules` are keyed as `npm:<package>/<path>`, so a pnpm store path or
   a version in the path does not change them.

Besides code, the fingerprint covers:

- `package.json`. With a lockfile, byakugan leaves out the dependency ranges,
  because it hashes the installed code instead. Without one, the ranges count.
  From the `package.json` of a workspace package the app imports, byakugan
  also leaves out `scripts`, the descriptive fields and every exact `exports`
  key that no import of the app names. A new `"./modal"` export reaches only
  the apps that import `@acme/ui/modal`.
- the `tsconfig.json` or `jsconfig.json` chain, `.env*`, `public/**`, global
  `.d.ts` files and Next.js static metadata files such as `favicon.ico`;
- the installed version of tools that read the app without being imported:
  `next`, `react`, `react-dom`, `typescript`, `tailwindcss`, `postcss`, `sass`
  and similar, when they are dependencies, plus any dependency a config file
  names in a string (a PostCSS plugin, a Turbopack loader, `transpilePackages`);
- the CSS Tailwind generates for each root stylesheet;
- for `import type` from an npm package, the package version and its `@types`
  version;
- the values of environment variables that live code reads by name and the
  framework inlines at build time: `NEXT_PUBLIC_*` for Next.js, `VITE_*` for
  Vite and React Router, `PUBLIC_*` for SvelteKit and Astro, `EXPO_PUBLIC_*`
  for Expo, and every name a SvelteKit app imports from `$env/static/public`
  or `$env/static/private`. `env` in `byakugan.json` adds more.
  `byakugan graph` lists every variable live code reads and the ones whose
  values count.

On a Next.js 14 app with 58 npm packages, a run takes 0.7 s and reaches 43
project files and 222 package files. `lucide-react` ships about 1,700 icon
files. The graph holds the 4 icons the app renders, 9 files with the icon
factory and the barrel.

[oxc]: https://github.com/oxc-project/oxc
[oxc-resolver]: https://github.com/oxc-project/oxc-resolver
