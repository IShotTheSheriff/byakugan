# byakugan

byakugan builds the graph of code a TypeScript, React or Next.js app uses, down
to single exports inside barrel files and single files inside npm packages. CI
asks it one question per app: can this pull request change what the app does?
When the answer is no, you skip the end-to-end tests, the build or the deploy.

```console
$ byakugan affected --workspace --base origin/main
apps/admin  unaffected
apps/docs   unaffected
apps/web    affected    source: packages/ui/src/cx.ts#cx changed
```

byakugan is [Knip][knip]'s approach turned around. Knip walks from an app's
entry files through every import and export and reports what nothing uses.
byakugan does the same walk and keeps the rest, the exact code the app uses,
so it can hash it.

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

## Quick start

```sh
npm install --save-dev byakugan-cli
npx --no-install byakugan doctor --workspace                         # find the apps and what needs fixing
npx --no-install byakugan affected --workspace --base origin/main    # which apps does this branch change?
```

In a repository with one app, leave out `--workspace` and run the commands in
the app directory, or point at it with `-C apps/web`.

The command is `byakugan`. It needs Node.js 22.12 or newer, and CI runs on 22,
24 and 26. The npm package is `byakugan-cli`, and an unrelated package named
`byakugan` exists. `npx --no-install` fails instead of downloading that one.

[docs/adopting.md](docs/adopting.md) is the full path from install to a CI job
that skips work: seven steps, each with its command and what the result means.
`byakugan guide` prints it.

## What you can skip with it

| You want to skip | Command |
| --- | --- |
| End-to-end tests of an app | `byakugan affected -C apps/web --base origin/main` |
| Work for every app of a monorepo | `byakugan affected --workspace --base origin/main` |
| A build, by reusing the last one | `byakugan hash -C apps/web --strict` as the cache key |
| Unit and component tests | `byakugan affected --base origin/main --each 'src/**/*.test.ts'` |
| Storybook stories and visual tests | `byakugan affected --base origin/main --each 'src/**/*.stories.tsx'` |

A verdict promises one of two things. The default mode, `behavior`, promises
that an unaffected app runs the same, which is what a test run needs.
`--strict` also promises the same build output, which is what a reused build
needs. [Modes](docs/commands.md#modes) has the difference.

## Commands

| Command | What it does |
| --- | --- |
| `byakugan doctor` | Checks that byakugan reads the app correctly, and says what to fix |
| `byakugan affected` | Do the changes since a base commit reach the app? |
| `byakugan hash` | A fingerprint of everything the app uses, for a cache key |
| `byakugan why <target>` | The import chain that makes a file, export or package used |
| `byakugan graph` | The files, exports and package files the app uses |
| `byakugan compare <a> <b>` | Two build outputs compared without per-build noise |
| `byakugan guide` | The setup guide, from the installed package |

`byakugan <command> --help` prints the options, examples, exit codes and JSON
shape of a command. [docs/commands.md](docs/commands.md) has the longer
explanations.

`affected` shows why, with the chain of imports from an entry to the change:

```console
$ byakugan affected -C apps/web --base origin/main
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

`doctor` lists setup problems by what they cost, each with its fix:

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
```

Every command has the same exit codes: 0 for done, 1 for affected with
`--exit-code` or a failed check, 2 for a usage error or a failure. `--json`
prints one JSON document on stdout, and warnings go to stderr. Colors follow
the terminal, and `NO_COLOR=1` turns them off.

## Monorepos

`--workspace` gives one verdict per app from one run. byakugan reads the
workspace list from `package.json`, `pnpm-workspace.yaml` or `nx.json`. Shared
libraries such as `packages/ui` get no verdict of their own. Their changes
show up in the apps that use them, export by export. A file that several apps
reach is parsed once, so 8 apps over one 6,000-module package take about 8 s.

**Turborepo and Nx** decide per package or per project. An edit to `Modal` in
`packages/ui` rebuilds every app that depends on `packages/ui`, whether it
renders `Modal` or not. Use byakugan to choose the apps and the task runner to
run and cache the tasks:

```sh
apps=$(npx --no-install byakugan affected --workspace --base origin/main --json | jq -r '.affected[] | "--filter=./" + .')
[ -n "$apps" ] && npx turbo run build e2e $apps
```

**End-to-end tests** with Playwright or Cypress do not import app code. Run
the suite when a change reaches an app it talks to, or the test package
itself. A two-line `byakugan.json` makes the test package an app, so an edited
spec counts.

**Storybook** stories import their components, so `--each` gives one verdict
per story file. `.storybook/preview` and what it imports reach every story.

**webpack and Turbopack** resolve imports the way byakugan does, through
tsconfig `paths` and package `exports`. byakugan does not read bundler
configuration, so an alias set only in `webpack.resolve.alias` or
`turbopack.resolveAlias` has to move to tsconfig `paths`. `doctor` finds
those.

[docs/adopting.md](docs/adopting.md#setups) has each setup with its commands,
and [docs/ci.md](docs/ci.md) has the GitHub Actions workflows.

## For coding agents

byakugan is built to be set up and read by an agent.

- `byakugan guide` prints the setup steps from the installed package.
- `byakugan doctor --workspace --json` lists every app and every finding with
  a `severity`, a `kind` and a `fix`.
- `byakugan <command> --help` lists the JSON shape and the exit codes.
- Errors name the fix. With `--json`, an error is
  `{"error":{"message","hint","help"}}` on stderr.
- [docs/adopting.md](docs/adopting.md#a-section-for-your-agentsmd) ends with a
  section to paste into your repository's `AGENTS.md`.

## How precise it is

- A barrel splits by export. If the app renders `Dialog`, an edit to
  `DialogFooter` in the same file does not reach it.
- npm packages split by file. `import { partition } from 'lodash'` uses 123 of
  lodash's ~1,050 files.
- Comments, formatting and unused code do not count. A Prettier run with other
  settings changes nothing.
- It follows what never shows up as an `import`: `import()` with a template
  string, `next/font` files, files read with `fs`, Tailwind's generated CSS,
  `'use server'` exports, environment variables the build inlines.
- A run takes 0.7 s on a Next.js app with 58 npm packages.

A wrong "affected" costs one extra run. A wrong "unaffected" ships something
untested. byakugan picks the first kind of error where it can, and
[docs/limits.md](docs/limits.md) lists where it cannot: data fetched at build
time, paths built from variables, environment variables that config files
read. It has no sandbox, so trust comes from checking it against real builds
with `byakugan compare` before you skip anything.

## Documentation

| Page | What is in it |
| --- | --- |
| [docs/adopting.md](docs/adopting.md) | Install to CI gate in seven steps. Turborepo, Nx, Playwright, Storybook, webpack and Turbopack setups |
| [docs/commands.md](docs/commands.md) | Every command, the two modes, `--each` and `--workspace` |
| [docs/ci.md](docs/ci.md) | GitHub Actions recipes |
| [docs/configuration.md](docs/configuration.md) | Every `byakugan.json` field |
| [docs/how-it-works.md](docs/how-it-works.md) | Entries, fragments, the walk and the hash |
| [docs/frameworks.md](docs/frameworks.md) | Next.js, Tailwind, shadcn and Hono in detail, with result tables |
| [docs/examples/](docs/examples/README.md) | About 850 cases of a change and its result, from case-only renames to `export *` lines and Tailwind classes, each linked to its test |
| [docs/limits.md](docs/limits.md) | What costs extra runs, what can miss a change, and security |

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

### Releasing

`.github/workflows/release.yml` publishes to npm when a `v*` tag is pushed.
It checks that the tag matches `package.json` and sits on `main`. Then it
runs the tests, installs the packed tarball and runs it on a fixture. It
publishes through npm trusted publishing, so the repository stores no npm
token. npm adds a provenance attestation only while the repository is public. A version with a
hyphen, like `0.2.0-beta.1`, goes to the `next` dist-tag, the rest to
`latest`. The workflow also creates a GitHub release with generated notes.

```sh
npm version minor   # or patch, major, prerelease --preid beta
git push origin main --follow-tags
```

npm links the package to this workflow under Settings, Trusted publishing
on npmjs.com, with environment `npm`. The repository needs a GitHub
environment of that name.

## Prior art

Knip by Lars Kappert. byakugan's module graph follows Knip's design, used in
reverse, and runs on the same oxc parser and resolver that Knip uses.

Next.js `modularizeImports` and `optimizePackageImports`, which solve the same
barrel problem for bundle size.

## License

MIT

[knip]: https://github.com/webpro-nl/knip
