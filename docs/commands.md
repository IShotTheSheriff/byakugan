# Commands

Every command prints its options, examples, exit codes and JSON shape with
`byakugan <command> --help`. This page has the longer explanations.

Run them from the app directory, or point at it with `-C apps/web`.

## `byakugan doctor`

Builds the graph and lists what stands between you and verdicts you can
trust. Run it first, and again after any change to aliases, entry points or
workspace packages.

```console
$ byakugan doctor -C apps/web
byakugan doctor · apps/web · next
42 entries · 310 project files · 1204 package files

blocks  1 import of project code cannot be resolved
        Every run reports "affected", because such an import could hide any change.
        fix byakugan reads tsconfig "paths", not webpack, Turbopack or Vite aliases. Declare the
        alias in tsconfig "paths". For a module that a bundler plugin provides, list its specifier
        under "virtual" in byakugan.json.
        - apps/web/src/icons.ts: cannot resolve "~icons/mdi/home"

Next
  Fix the "blocks" findings above, then run doctor again.
```

Each finding has a severity. `blocks` means every run reports "affected".
`hides` means a change can go unseen. `coarse` costs extra runs and never a
missed change. `note` is worth knowing. `doctor` exits with 1 while a
`blocks` or `hides` finding is open, so CI can run it as a check.

`--workspace` prints one row per app and the details of the apps with
problems. `--json` prints `{ ok, apps: [{ app, framework, entries, findings }] }`,
where each finding carries `severity`, `kind`, `count`, `cost`, `fix` and
`examples`. [adopting.md](adopting.md) lists every kind with its fix.

## `byakugan guide`

Prints [adopting.md](adopting.md) from the installed package, so a coding
agent can read the setup steps without network access.

## `byakugan graph`

Lists what the app uses. `--json`, `--mermaid` and `--dot` print the same
graph in other formats.

```console
$ byakugan graph -C apps/web
byakugan · next · 5 entries
14 project files · 7 files in 3 packages · 37 live fragments
fingerprint a7df71be3dd79e4a9bbc2b0c3ade26f395e8d688d6430cfd48cb44df59843544

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

inputs  apps/web/package.json, apps/web/public/logo.svg, apps/web/tsconfig.json, packages/ui/package.json
```

This is the `test/fixtures/monorepo` app, with `@acme/ui` linked into
`node_modules` as npm workspaces do it. `components/Unused.tsx` is missing from
the list because nothing imports it.

`runs, nothing used` means the module is loaded (the barrel imports it), so its
top-level side effects count, but none of its declarations do.

## `byakugan hash`

Prints a SHA-256 fingerprint of every fragment the app uses. Equal fingerprints
mean the app's inputs are equal, installed dependencies included. Use it as a
cache key. `--manifest <file>` also writes the per-fragment hashes.

## Modes

A verdict promises one of two things, and `"mode"` in `byakugan.json` picks
which.

`behavior` is the default. An unaffected app runs the same as before, so you
can skip its end-to-end tests. byakugan counts the code the app can run.

`strict` promises the same build output too, so you can reuse a build or skip
a deploy. It also counts code the bundler ships but nothing runs. Today that is
one case. Next.js ships a `'use client'` module whole when a server component
imports it, so an unused export next to a used one changes the client chunk.
`behavior` ignores that export and `strict` counts it.

`--strict` on `graph`, `hash`, `affected` and `why` does the same as
`"mode": "strict"`. The two modes give different fingerprints for such an app.
A manifest records its mode, and a run in the other mode reports "affected"
and says why.

## `byakugan affected`

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
fingerprint 13cb8b5638bfd69a9c3be72f57620ade0174d3254e81918167136f1547d00a91

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
`git diff --exit-code`. `--json` prints the result as JSON. `--verbose` lists
every reason and every ignored change.

`--each <glob>` gives one verdict per matching file instead of one per app,
for example per test file or per Storybook story. It prints the files a change
reaches, one per line, and writes them as a JSON list to `each=` in
`$GITHUB_OUTPUT`:

```console
$ byakugan affected --base origin/main --each 'src/**/*.test.ts'
byakugan: 1 of 4 files
src/add.test.ts
```

The matched files replace the framework's routes as entries. byakugan walks
back from every changed fragment over every import that reaches it, so a
barrel still splits by export: a change to `Card` reaches the test that
imports `Card` from `./ui` and not the one that imports `Button` from it. A
change to a config entry, a test runner file (`vitest.config.*`,
`jest.config.*`, `playwright.config.*`, `vitest.setup.*`, `setupTests.*`), a
Storybook file in `.storybook/` or an input such as `package.json` reaches
every file. A deleted test reaches
nothing. Repeat `--each` for more globs.

`--workspace` runs `affected` (or `hash`) once per app in the workspace at
`-C`, which defaults to the current directory:

```console
$ byakugan affected --workspace --base origin/main
apps/docs  unaffected
apps/web   affected    source: packages/ui/src/cx.ts#cx changed
```

byakugan reads the workspace list from `package.json` or
`pnpm-workspace.yaml`. With an `nx.json` in the root, it also finds every
`project.json`, and one with `"projectType": "application"` is an app even
without a `package.json`. A package counts as an app when byakugan detects a
framework or a Cloudflare Worker in it, when it has a `byakugan.json`, or when
it is not a library. A library is a package that another workspace package
lists in `dependencies`, `peerDependencies` or `optionalDependencies`, or lists
only in `devDependencies` and that has no `start` script. A server that an
end-to-end test package lists in `devDependencies` and starts with
`npm start` is an app. A framework in the dependencies of a library makes it
an app only when the framework's config file is there too, so a logging
package with `next` among its dependencies stays a library. `packages/ui` is none of these, so
it gets no verdict of its own; its changes show up in the apps that use it. An
API whose types the web app imports (Hono RPC) is a dependency of the web app,
so give it a `byakugan.json` to get a verdict. An app whose graph fails, for
example over an invalid `byakugan.json`, counts as affected. With
`--workspace`, `--manifest` and `--base-manifest` name directories that hold
one manifest per app. A file that several apps reach is parsed once per run.
On a synthetic workspace of 8 apps over one 6,000-module package, that took a
run from 34 s to 8 s.

## `byakugan compare <base> <fresh>`

Compares two build outputs, such as two `.next` directories, and exits with 1
when they differ. It leaves out what changes between any two builds of the
same code: the build ID, the server action and preview mode secrets, the
checkout path Next.js records, and in Next.js output the caches and traces.
Source maps embed the
source, so a comment or formatting edit changes them. `compare` skips `.map`
files unless you pass `--maps`.

This is how you check byakugan itself. When `affected --strict` says
unaffected, a build of the change should match a build of the base. The
default `behavior` mode allows the builds to differ in code nothing runs. On [bobr](https://github.com/IShotTheSheriff/bobr), a Next.js 16
monorepo built with Turbopack, two builds of one commit matched. A Prettier run
over 14 used files with other settings matched too, apart from source maps. A
change to a function the app uses gave 8 different files. Webpack builds are
untested.

## `byakugan why <target>`

Prints the shortest import chain from an entry to a file (`src/lib/utils.ts`),
an export (`src/lib/utils.ts#formatDate`), a package file
(`npm:lodash/partition.js`) or a package (`lodash`).
