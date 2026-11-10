# Frameworks

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
| `'use client'` in a file a server component imports, with `strict` | Every export, since Next.js ships that module to the browser whole  |
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
| An unused export in a `'use client'` file                      | unaffected |
| The same with `--strict`, when a server component imports it   | affected   |
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
