# Limits and security

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
- **Single-file components count whole.** A `.vue`, `.svelte` or `.astro`
  file counts as one fragment, and every name its scripts import counts as
  used. Nuxt's `components`, `composables` and `utils` count whether a page
  uses them or not, since Nuxt imports them for you.
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

- **A top-level initializer that calls a function runs with its module.**
  `export const store = createStore()` counts whenever the module runs, used
  or not, because a bundler keeps the call. Mark the call `/*#__PURE__*/` when
  it only builds a value.

These can miss a change:

- **Some top-level calls are assumed to only build a value.** Calls into
  `react`, `zod`, `class-variance-authority`, `tailwind-variants`,
  `styled-components`, `hono` and a few similar packages, built-ins such as
  `Object.freeze`, and calls marked `/*#__PURE__*/` count only when their
  result is used. A function you pass them, as in `['a'].map(register)`,
  counts when its body calls something. byakugan assumes that reading a
  property runs no getter and that turning a value into a string or number
  runs no `toString` or `valueOf` of your own, so `String(o)` with a custom
  `toString` that registers something is missed.
- **Paths byakugan cannot read off the code.** An `import()` whose specifier
  starts with an alias (`` `@/messages/${l}.json` ``) or is fully computed,
  and file paths built from variables. byakugan warns about such imports. Add
  the files to `inputs`.
- **Build-time data and environment.** Data fetched during the build (a CMS, a
  database, `fetch` in `generateStaticParams`) is not something byakugan can
  hash. Neither is an environment variable that code reads by a computed name
  or that config files read, such as `process.env.BASE_PATH` in
  `next.config.ts`, unless `env` names it. Add them to your cache key. Git
  mode compares no values at all, since the base commit has no environment.
  The fingerprint and manifests do, with the values of the job that runs
  byakugan, so run it with the build's environment.
- **Comments and formatting in build output.** A build that keeps comments
  or layout, such as `tsc` or Rollup without a minifier, emits different files
  after an edit byakugan reports as unaffected. So do source maps, whose line
  numbers move. The code runs the same. Lint and format checks read comments
  and formatting, and ESLint obeys `// eslint-disable-next-line`. Key such
  checks on the files under `inputs`, not on the graph.
- **Declaration order behind a function call.** Moving `const a = 1` below
  `const b = a`, or a base class below its subclass, counts. A function called
  at the top level that reads a binding declared below the call does not,
  whether it is a `function` declaration or `const f = () => ...`.
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
- **Manifests hold a hash of each counted environment variable**, never the
  value. A short secret can still be guessed from its hash, so keep secrets
  out of `env`. Public `NEXT_PUBLIC_*` and `VITE_*` values end up in the
  bundle anyway.
- **Text output escapes control characters**, so a file name holding terminal
  escape sequences prints as plain text. Mermaid and DOT output escape quotes
  and line breaks, so a file name cannot add a directive.
