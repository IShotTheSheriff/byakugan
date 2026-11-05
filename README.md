# byakugan

byakugan builds the graph of code a TypeScript, React or Next.js app actually
uses. It goes down to single exports inside barrel files and into npm packages.
CI can use that graph to skip a build when a change cannot reach the app.

[Knip][knip] answers "what does nothing use?". byakugan asks the opposite
question, "what exactly does this app use?".

## The problem

```ts
// apps/web/app/page.tsx
import { partition } from 'lodash';
import { Button } from '@acme/ui';
```

Turborepo, Nx and most CI cache keys work per package or per file. Someone edits
`Modal` in `@acme/ui`, and `web` rebuilds, because `web` depends on `@acme/ui`.
A lodash release touches `filter`, and `web` rebuilds again.

byakugan follows the imports symbol by symbol:

- `Button` resolves through `packages/ui/src/index.ts` (`export * from './Button'`)
  to the `Button` declaration and the helpers it calls. `Modal` sits in the same
  barrel and is never reached.
- `partition` resolves to `lodash/partition.js` and the internal files it
  `require`s. On lodash 4.17.21 that is 123 of the package's ~1,050 files.
  `filter.js` is not one of them.

```console
$ byakugan why npm:lodash/filter.js
npm:lodash/filter.js: not used by the app

$ byakugan why packages/ui/src/Button.tsx#Button
packages/ui/src/Button.tsx#Button
  apps/web/app/page.tsx (entry)
  └ apps/web/app/page.tsx#Page
  └ apps/web/app/page.tsx#Button (import from "@acme/ui")
  └ packages/ui/src/index.ts › Button
  └ packages/ui/src/Button.tsx#Button
```

## Install

```sh
npm install --save-dev byakugan-cli
```

The command is `byakugan`. It needs Node.js 20.19 or newer. CI runs on 22 and 24.
The programmatic API ships types for TypeScript 5 or newer, with `@types/node`.

The npm package is `byakugan-cli`, and an unrelated package named `byakugan`
exists. Install byakugan-cli as a dev dependency and call it with
`npx --no-install byakugan`, which fails instead of downloading the other one.

## Commands

Run them from the app directory, or point at it with `-C apps/web`.

### `byakugan graph`

Lists what the app uses. `--json`, `--mermaid` and `--dot` print the same
graph in other formats.

```console
$ byakugan graph -C apps/web
byakugan · next · 5 entries
14 project files · 7 files in 3 packages · 33 live fragments
fingerprint 308d781e06cddcdc0887b72e68b6200b8e78819742ae94afb3d8d51a7d7c76ec

entries
  apps/web/app/api/health/route.ts
  apps/web/app/dashboard/page.tsx
  apps/web/app/layout.tsx
  apps/web/app/page.tsx
  apps/web/next.config.ts

project files
  apps/web/app/api/health/route.ts    all 1 exports
  apps/web/app/dashboard/page.tsx     all 1 exports
  apps/web/app/globals.css            whole file (asset)
  apps/web/app/layout.tsx             all 1 exports
  apps/web/app/page.tsx               all 2 exports
  apps/web/app/theme.css              whole file (asset)
  apps/web/components/Chart.tsx       all 1 exports
  apps/web/components/Hero.tsx        Hero  (1 of 1 exports)
  apps/web/next.config.ts             all 1 exports
  packages/ui/src/Button.tsx          Button  (1 of 1 exports)
  packages/ui/src/Card.tsx            runs, nothing used (0 of 1 exports)
  packages/ui/src/cx.ts               cx  (1 of 1 exports)
  packages/ui/src/index.ts            Button  (1 of 3 exports)
  packages/ui/src/Modal.tsx           runs, nothing used (0 of 1 exports)

packages
  lodash@4.17.21    2 files    partition
  next@15.0.0       2 files    default
  react@19.0.0      3 files    jsx

tracked by version  next, react

inputs  apps/web/package.json, apps/web/public/logo.svg, apps/web/tsconfig.json
```

This is the `test/fixtures/monorepo` app. `components/Unused.tsx` is missing
from the list because nothing imports it.

`runs, nothing used` means the module is loaded (the barrel imports it), so its
top-level side effects count, but none of its declarations do.

### `byakugan hash`

Prints a SHA-256 fingerprint of every fragment the app uses. Equal fingerprints
mean the app's inputs are equal, installed dependencies included. Use it as a
cache key. `--manifest <file>` also writes the per-fragment hashes.

### `byakugan affected`

Answers "does this change reach the app?" in one of two ways.

`--base <ref>` compares the working tree with the merge base of `<ref>` and
`HEAD`. Changed project files are compared fragment by fragment. Dependency
updates are read from the lockfile (npm, pnpm, yarn, bun) and count per package,
since the base side of `node_modules` is not installed.

`--base-manifest <file>` compares with a manifest saved from the base build.
This is exact for dependencies too: a lodash bump that only changes `filter.js`
comes back unaffected.

```console
$ byakugan affected --base origin/main
affected since bec83380d57e: 1 change reaches the app
fingerprint d951a427245ee3be4fd79886fab95da733551c0f2db634de0e395e1def4e27ae

source: packages/ui/src/cx.ts#cx changed
    apps/web/app/page.tsx (entry)
    └ apps/web/app/page.tsx#Page
    └ apps/web/app/page.tsx#Button (import from "@acme/ui")
    └ packages/ui/src/index.ts › Button
    └ packages/ui/src/Button.tsx#Button
    └ packages/ui/src/Button.tsx#cx (import from "./cx")
    └ packages/ui/src/cx.ts#cx

changes nothing uses
  packages/ui/src/Modal.tsx  (Modal)
  README.md
```

`--exit-code` exits with 1 when affected and 0 when not, like
`git diff --exit-code`. `--json` prints the result as JSON.

### `byakugan why <target>`

Prints the shortest import chain from an entry to a file (`src/lib/utils.ts`),
an export (`src/lib/utils.ts#formatDate`), a package file
(`npm:lodash/partition.js`) or a package (`lodash`).

## CI recipes

In GitHub Actions, `hash` and `affected` write `fingerprint=` and `affected=`
to `$GITHUB_OUTPUT`. Warnings (imports byakugan cannot follow, Tailwind
failures) go to stderr, so stdout stays a fingerprint or JSON. `affected` also
lists them under "warnings".

The workflow needs only `contents: read`. Pass `github.base_ref` through `env`
rather than into the script itself, so a branch name cannot inject shell code.

### Skip a build on a pull request

```yaml
- uses: actions/checkout@v5
  with:
    fetch-depth: 0 # affected needs the merge base
- run: npm ci
- id: web
  env:
    BASE_REF: ${{ github.base_ref }}
  run: npx --no-install byakugan affected -C apps/web --base "origin/$BASE_REF"
- if: steps.web.outputs.affected == 'true'
  run: npm run build --workspace web
```

### Reuse a build when nothing it uses changed

```yaml
- run: npm ci
- id: web
  run: npx --no-install byakugan hash -C apps/web
- id: cache
  uses: actions/cache@v4
  with:
    path: apps/web/.next
    key: web-next-${{ steps.web.outputs.fingerprint }}
- if: steps.cache.outputs.cache-hit != 'true'
  run: npm run build --workspace web
```

This covers dependency updates exactly, because the fingerprint hashes the
installed files the app uses.

### Exact comparison against main

Save a manifest on `main`, compare with it on pull requests:

```yaml
# on push to main
- run: npx --no-install byakugan hash -C apps/web --manifest .byakugan/web.json
- uses: actions/upload-artifact@v4
  with: { name: byakugan-web, path: .byakugan/web.json }

# on pull_request, after downloading that artifact
- id: web
  run: npx --no-install byakugan affected -C apps/web --base-manifest .byakugan/web.json
```

See [examples/github-actions.yml](examples/github-actions.yml) for a full
workflow.

## How it works

1. **Entries.** In a Next.js app these are App Router files (`page`, `layout`,
   `route`, `loading`, `error`, `not-found`, `global-not-found`, metadata
   routes, and the rest), everything under `pages/`, `middleware`/`proxy`,
   `instrumentation`, `mdx-components`, `next.config.*`, and files plugins load
   by convention (next-intl `i18n/request.ts`, Sentry `sentry.*.config.ts`). In
   a Vite app they are the
   `<script src>` tags in `index.html` and `vite.config.*`. Other projects use
   `package.json` fields, then `{index,main,server,app}.*` in the root or
   `src/`. Every project also gets `main` from `wrangler.{toml,json,jsonc}`,
   Vercel `api/**` and Netlify functions, files a config names in a string
   (Vite inputs such as `/app/client.ts`), and the `entry` globs from
   `byakugan.json`. Every export of an entry counts as used.
2. **Fragments.** [oxc-parser][oxc] splits each reached module into fragments:
   top-level declarations, import bindings, export specifiers, `export *` lines,
   and the module's side effects (directives such as `'use client'`, bare
   imports such as `import './polyfill'`, and top-level statements).
   `declare global` and `declare module` blocks form a separate types fragment.
   byakugan records, per declaration, which top-level names it refers to.
3. **Walk.** A used export leads to its declaration. The declaration leads to
   the names it refers to. An import binding leads to the export of the module
   it resolves to ([oxc-resolver][oxc-resolver], with tsconfig `paths` and
   `exports` conditions for browser, node and `react-server`). The walk crosses
   `export *` barrels, namespace imports used as `ns.member`, `import()`,
   `require()`, `next/dynamic`, `React.lazy`, the implicit JSX runtime and
   workspace symlinks. It also follows imports and paths that are not plain
   imports; [Next.js, Tailwind and shadcn](#nextjs-tailwind-and-shadcn) lists
   them. An `import type` is followed through types only: the declarations it
   reaches count, but the target module does not run, so its side effects and
   the packages only its runtime code imports stay out.
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

- `package.json` without dependency ranges when there is a lockfile (the
  installed code is hashed instead; without a lockfile the ranges count), the
  `tsconfig.json` or `jsconfig.json` chain, `.env*`, `public/**`, global `.d.ts`
  files and Next.js static metadata files such as `favicon.ico`;
- the installed version of tools that read the app without being imported:
  `next`, `react`, `react-dom`, `typescript`, `tailwindcss`, `postcss`, `sass`
  and similar, when they are dependencies, plus any dependency a config file
  names in a string (a PostCSS plugin, a Turbopack loader, `transpilePackages`);
- the CSS Tailwind generates for each root stylesheet;
- for `import type` from an npm package, the package version and its `@types`
  version.

On a Next.js 14 app with 58 npm packages, a run takes 0.7 s and reaches 43
project files and 222 package files. `lucide-react` ships about 1,700 icon
files. The graph holds the 4 icons the app renders, 9 files with the icon
factory and the barrel.

## Next.js, Tailwind and shadcn

Some of what a Next.js app depends on never shows up as an `import`. byakugan
follows these too:

| In the code                                                       | What becomes part of the graph                                       |
| ----------------------------------------------------------------- | -------------------------------------------------------------------- |
| `` import(`../messages/${locale}.json`) ``, `require('./l/' + x)` | Every file the pattern matches, as webpack and Turbopack bundle them |
| `localFont({ src: './fonts/brand.woff2' })`                       | `./fonts/brand.woff2`. Any `./`-relative string with an extension    |
| `new URL('./worker.ts', import.meta.url)`                         | `worker.ts` and what it imports                                      |
| `` join(process.cwd(), 'content', 'posts', `${slug}.md`) ``       | Every file under `content/posts`                                     |
| `'use server'` at the top of a file                               | Every export, since Next.js may register each one as an endpoint     |
| `@import "tw-animate-css"`, `@import "shadcn/tailwind.css"`       | The package stylesheet, resolved with the `style` export condition   |
| `@use 'tokens'`, `url("./bg.png")` in a stylesheet                | `_tokens.scss`, `bg.png`                                             |
| `@import "/src/theme.css"`, `url("@/assets/hero.png")`            | `src/theme.css` under the project root, the file the alias names     |
| `@use "pkg:bootstrap"` in Sass                                    | The package stylesheet, as for `@use "bootstrap"`                    |
| `@plugin`, `@config` in a Tailwind stylesheet                     | The plugin or config module                                          |
| `loaders: ["@tailwindcss/turbopack"]` in `next.config.ts`         | The package version                                                  |

**CSS imported from code** (`import './globals.css'`, `import 'pkg/styles.css'`)
is an ordinary import of a file hashed whole. The list of such imports, in
order, is part of the importing module's side-effect fragment, because the
order sets the cascade. Swapping two of them counts, and so does adding an
import of a stylesheet that already existed. A stylesheet imported by a module
the app reaches only through `import type` does not count.

**Tailwind** writes CSS for class names it finds in every file it scans,
imported or not. byakugan runs the project's own Tailwind (v3 or v4) in a child
process, scans the same files and hashes the CSS it generates. That hash is a
fragment of the root stylesheet, `app/globals.css#<tailwind>`. Editing a file
nobody imports counts only when the generated CSS changes. In git mode,
byakugan runs Tailwind a second time with the base side's version of every
changed file and compares the two outputs. With Tailwind v3, a Sass file that
code imports is compiled with the project's `sass` first, so its partials count
as part of one root, as they do in the build.

**shadcn/ui** components are copied into the project, so they are ordinary
project files. If the app renders `Dialog` and `DialogContent`, a change to
`DialogFooter` in the same `components/ui/dialog.tsx` does not reach it.
`components.json` is read only by the shadcn CLI and is not an input.

On a `create-next-app` project with shadcn (Next.js 16.4, Tailwind 4.3,
Base UI, lucide-react), git mode gives these results:

| Change                                                         | Result     |
| -------------------------------------------------------------- | ---------- |
| A used shadcn component (`DialogContent`)                      | affected   |
| An unused export in the same file (`DialogFooter`)             | unaffected |
| A file nobody imports: new text, or code with no new classes   | unaffected |
| A file nobody imports: a class no other file uses              | affected   |
| `README.md`, a new test file, `components.json`                | unaffected |
| `messages/pl.json` edited, `messages/de.json` added or deleted | affected   |
| A blog post read with `fs`, a new post                         | affected   |
| The `next/font/local` font file, edited or deleted             | affected   |
| A font read with `fs` in `opengraph-image.tsx`                 | affected   |
| An unused export in a `'use server'` file                      | affected   |
| `pages/api` and `app/api` routes, `middleware.ts`, a new page  | affected   |
| `next/dynamic` and `React.lazy` targets, an intercepting route | affected   |
| `tw-animate-css` or `@tailwindcss/turbopack` bumped            | affected   |

On the same project, with node_modules patched, the fingerprint changes for
the `X` icon the dialog renders and stays the same for an icon nothing renders.

## Hono

Hono inside a Next.js route handler (`app/api/[[...route]]/route.ts` with
`handle()` from `hono/vercel`) is ordinary imports. The route file is an entry,
so every router it mounts counts, and a router file nobody mounts does not. The
graph holds the parts of `hono` the app uses: 31 of its ~320 files in the
`nextjs-starter` app above.

Standalone Hono apps get their entries from the project layout:

- Cloudflare Workers: `main` in `wrangler.jsonc` (or `.json`, `.toml`). The
  wrangler config and the `assets.directory` it names are inputs, and the
  `wrangler` version is tracked, since it bundles the worker.
- Node.js, Bun, Vercel: `src/index.ts`, `src/server.ts` or `src/app.ts`, unless
  `package.json` names an entry. Vercel `api/**` and Netlify functions count
  too.
- HonoX: `app/server.ts`, `app/client.ts`, `app/routes/**` and `app/islands/**`,
  plus the client inputs named in `vite.config.ts`. HonoX finds routes with
  `import.meta.glob`, and byakugan follows `import.meta.glob` in any file,
  negative patterns included.

`serveStatic({ root: './public' })` makes every file under `public/` part of
the graph. `cloudflare:workers`, `bun`, `bun:sqlite` and `virtual:*` modules
come from the runtime or bundler, so they are not reported as unresolved.
Neither are `server-only`, `client-only` and `styled-jsx` in a Next.js app,
since Next.js aliases them to its own copies.

On the `nodejs`, `cloudflare-workers` and `x-basic` (HonoX) templates from
`create-hono`, extended with routes in separate files, `zod` validation,
`serveStatic` and `hono/jsx` views, git mode gives these results:

| Change                                                            | Result     |
| ----------------------------------------------------------------- | ---------- |
| A route handler, a `zod` schema, a helper the handler calls       | affected   |
| An unused helper or JSX component next to used ones               | unaffected |
| A route file nobody mounts with `app.route()`                     | unaffected |
| The RPC client file (nothing on the server imports it)            | unaffected |
| A file under the `serveStatic` root, edited or added              | affected   |
| A deleted route file                                              | affected   |
| `hono`, `zod` or `wrangler` bumped in the lockfile                | affected   |
| `compatibility_date` or `compatibility_flags` in `wrangler.jsonc` | affected   |
| HonoX: a route, an island, `_renderer.tsx`, new or deleted routes | affected   |
| `README.md`                                                       | unaffected |

The Hono RPC client imports the server's type (`import type { AppType }`), and
byakugan follows that import through types only. For a client app in another
workspace, `typeof app` brings in the route declarations, the handlers, the
`zod` schemas and the helpers whose return values shape a response, plus the
packages they use (by version and `@types` version). The server's bootstrap
stays out: `serve()`, `import 'dotenv/config'`, logging, and packages only that
code imports, such as `@hono/node-server`. There is no type checker, so a
handler body change counts even when the response type stays the same.

On a monorepo with `apps/api` (Hono on Node.js) and `apps/web` (Next.js with
`hc<AppType>`), git mode gives these results for `apps/web`:

| Change in `apps/api`                                         | Result for `apps/web` |
| ------------------------------------------------------------ | --------------------- |
| `serve()` port, `console.log`, `import 'dotenv/config'`      | unaffected            |
| A route file nobody mounts, a db helper no handler calls     | unaffected            |
| `@hono/node-server` or `dotenv` bumped in the lockfile       | unaffected            |
| A handler's response shape, a `zod` schema, mounting a route | affected              |
| A db helper whose return value a handler sends               | affected              |
| `zod`, `@hono/zod-validator` or `hono` bumped                | affected              |

The bootstrap changes in the first and third rows do affect `apps/api` itself.

## Configuration

Everything is optional. Put a `byakugan.json` next to the app's `package.json`:

```json
{
  "entry": ["scripts/seed.ts"],
  "inputs": ["messages/*.json"],
  "packages": ["@sentry/nextjs"],
  "conditions": ["source"],
  "generated": ["src/generated/**"],
  "virtual": ["~icons/**"],
  "modularizeImports": {
    "my-icons": { "transform": "my-icons/icons/{{ kebabCase member }}" }
  }
}
```

| Field               | Meaning                                                                                                         |
| ------------------- | --------------------------------------------------------------------------------------------------------------- |
| `entry`             | Extra entry globs, added to the detected ones.                                                                  |
| `inputs`            | Extra globs hashed as whole files.                                                                              |
| `packages`          | Packages tracked by installed version.                                                                          |
| `framework`         | `next`, `vite`, `react-router` or `none`. Overrides detection; `none` disables framework entries.               |
| `conditions`        | Export conditions tried first. Use `["source"]` when workspace packages point `exports` at `dist`.              |
| `modularizeImports` | Same shape as the Next.js option. Merged over the built-in `lodash` rule.                                       |
| `jsxImportSource`   | Defaults to `compilerOptions.jsxImportSource` from `tsconfig.json`, then `react`.                               |
| `generated`         | Git-ignored files the build generates, such as a Prisma client. Git mode skips its "ignored by git" reason for them. List the generator's inputs in `inputs`. |
| `virtual`           | Specifiers a bundler plugin provides (globs), such as `~icons/**` for unplugin-icons. They no longer count as unresolved. |

byakugan rejects a `byakugan.json` that is not valid JSON or has a field of
the wrong type, for example a string where a list belongs.

## Limits

A wrong "affected" costs one extra build. A wrong "unaffected" ships a stale
app. byakugan picks the first kind of error where it can, but not everywhere.

These cost extra builds:

- **CommonJS is hashed per file.** byakugan follows `require()` calls but does
  not look inside CommonJS modules. `lodash` itself is one 540 KB CommonJS file,
  so byakugan rewrites `import { partition } from 'lodash'` to
  `lodash/partition`, as Next.js does by default. A default import
  (`import _ from 'lodash'`) uses the whole file.
- **Names, not types.** There is no type checker. A local variable that shadows
  an import counts as a use of that import. A declaration reached through
  `import type` counts whole, so a function body change counts even when its
  type stays the same.
- **Modules a barrel loads still run.** Their top-level statements count, and so
  does everything those statements reference.
- **Git mode sees dependency updates per package.** Use a manifest or the
  fingerprint for file-level precision.
- **Tailwind counts generated CSS, not rendered classes.** A class added to a
  component nobody imports yet changes the CSS, so it counts.
- **If Tailwind cannot run**, for example because `@tailwindcss/node` is
  missing or the config throws, every file it may scan is hashed whole.
  byakugan prints a warning with the reason.
- **Directories read through `process.cwd()` count whole.**
  `join(process.cwd(), 'content', slug)` makes every file under `content/`
  part of the graph.
- **Unresolved imports of project code count as affected, on every run.** An
  import byakugan cannot resolve could hide anything, so it fails closed and
  prints a warning. That covers relative paths, `#` and `~` imports, tsconfig
  `paths`, `baseUrl` directories, workspace packages, and bare names that no
  `package.json` declares (usually a bundler alias byakugan does not read, such
  as a Vite `resolve.alias`), in imports and in stylesheet `url()` alike. A
  declared npm package that is not installed does not count; the lockfile
  covers it. An `import type` that does not resolve only warns. List plugin
  virtual modules under `virtual`.
- **Git-ignored files the app reads count as affected in git mode**, since git
  has no base version to compare them with. List generated ones under
  `generated`. A git-ignored `.env*` file, such as `.env.local`, only warns:
  CI checks out no such file, so a laptop run would otherwise always report
  "affected".
- **A symlink inside a `dir/**` pattern to a directory under the same pattern
  counts as the link.** `public/v2 -> v1` is an input hashed by its target, so
  adding, removing or retargeting it counts, and edits under `v1` count through
  `v1`'s own files. Any other link to a directory, such as
  `public/shared -> ../assets` or `app/blog -> ../docs`, has its files listed
  under the link's path. Git mode maps changes under the target to those paths.

These can miss a change:

- **Top-level initializers are assumed pure.** `export const store =
  createStore()` counts only when `store` is used. Bare top-level statements
  always count.
- **Paths byakugan cannot read off the code.** An `import()` whose specifier
  starts with an alias (`` `@/messages/${l}.json` ``) or is fully computed,
  and file paths built from variables. byakugan warns about such imports. Add
  the files to `inputs`.
- **Build-time data and environment.** Data fetched during the build (a CMS, a
  database, `fetch` in `generateStaticParams`) and environment variables that
  CI sets rather than `.env*` files are not files byakugan can hash. Add them
  to your cache key.
- **Declaration order.** Moving `const a = 1` below the code that reads it at
  the top level, or a base class below its subclass, throws at runtime, but
  each declaration's text is unchanged, so nothing counts.
- **`verbatimModuleSyntax` is read from the app's tsconfig chain only.** A
  workspace package that sets it in its own tsconfig, while the app does not,
  is parsed as if it were off: `import { type X }` there does not run the
  module.
- **Without `.git`, nothing above the workspace root is read.** The git root
  is the boundary for paths in code, globs and symlinks. In a source tarball
  the workspace root takes its place, so a file in `../shared` that a clone
  would hash is skipped with a warning.
- **Workspace packages that export `dist/`** hide source changes from git mode.
  byakugan prints a warning and suggests a `source` condition.

Yarn Plug'n'Play is not supported, since byakugan reads packages from
`node_modules`. Windows paths are untested.

## Security

byakugan reads a pull request's files, so treat its input as untrusted.

- **It runs the project's Tailwind**, and Tailwind loads `tailwind.config.*`,
  `@plugin` and `@config` modules, which are code from the repository. Run
  byakugan only where you would run the build. The Tailwind child process is
  killed after 120 s.
- **It reads nothing outside the repository.** Imports, paths in code, globs
  and symlinks that point outside the git root are skipped with a warning.
  Installed packages count wherever their real path is, as long as that path is
  inside a `node_modules` directory (a pnpm store, for example). It reads only
  regular files, so a link to `/dev/zero` or a FIFO cannot block it. The
  resolver reads `package.json` and tsconfig files on its own, so byakugan
  stops with an error when a linked `.json` file (submodules included), or a
  `package.json` on a lookup path, is not a regular file. A tsconfig `extends`
  outside the repository is not read.
- **Symlinks cannot make a crawl quadratic.** Each link target is entered at
  most once per pattern, and a crawl that reaches more than 200,000
  directories through links stops with an error.
- **Git runs with `safe.bareRepository=explicit` and `core.fsmonitor=false`**,
  so a committed directory laid out as a bare repository cannot make git run
  its `core.fsmonitor` command. A `--base` that starts with `-` is rejected.
- **Globs and patterns from the repository run in linear time.** byakugan
  matches them one path segment at a time, instead of compiling them into a
  regex that can backtrack for minutes.
- **Text output escapes control characters**, so a file name holding terminal
  escape sequences prints as plain text. Mermaid and DOT output escape quotes
  and line breaks, so a file name cannot add a directive.

## Programmatic API

```ts
import { affected, analyze, why } from 'byakugan-cli';

const graph = analyze({ cwd: 'apps/web' });
graph.isLive('packages/ui/src/Button.tsx#Button'); // true
graph.fingerprint();
why(graph, 'lodash').matches[0].key; // 'npm:lodash/partition.js'

const result = affected({ cwd: 'apps/web', base: 'origin/main' });
if (!result.affected) console.log('skip the build');
```

## Development

```sh
npm install
npm test          # node:test, runs the TypeScript sources directly
npm run typecheck
npm run build     # emits dist/
node src/cli.ts graph -C test/fixtures/basic
```

Fixtures live in `test/fixtures`. They include small fake copies of `lodash`,
`next` and `react` in their own `node_modules`, which git tracks.

## Prior art

Knip by Lars Kappert, which byakugan's module graph borrows ideas from, and the
same oxc parser and resolver that Knip uses. Next.js `modularizeImports` and
`optimizePackageImports`, which solve the same barrel problem for bundle size.

## License

MIT

[knip]: https://github.com/webpro-nl/knip
[oxc]: https://github.com/oxc-project/oxc
[oxc-resolver]: https://github.com/oxc-project/oxc-resolver
