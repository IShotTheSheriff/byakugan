# Adopting byakugan

This guide is for whoever adds byakugan to a repository, a person or a coding
agent. Follow the steps in order. Each one names the command to run and what
its result means. `byakugan guide` prints this file.

byakugan answers one question per app: can this change alter what the app
does? CI uses the answer to skip end-to-end tests, builds and deploys for apps
a change cannot reach.

## Ground rules

- A failed run never means "skip". Exit code 2, or a missing `affected=`
  output, means run everything. Write CI conditions as
  `affected != 'false'`, not `affected == 'true'`.
- Run byakugan after the install step. It reads `node_modules`.
- The npm package is `byakugan-cli` and the command is `byakugan`. Call it
  with `npx --no-install byakugan`, which fails instead of downloading the
  unrelated package named `byakugan`.
- Fix a warning through configuration. Do not delete or rewrite app code to
  make a warning go away.
- Do not skip anything in CI until step 6 has run for a while.

## Step 1: install

```sh
npm install --save-dev byakugan-cli      # or: pnpm add -D -w byakugan-cli, yarn add -D byakugan-cli
npx --no-install byakugan --version
```

In a monorepo, install it once in the root. It needs Node.js 22.12 or newer.

## Step 2: find the apps

```sh
npx --no-install byakugan doctor --workspace          # a table for people
npx --no-install byakugan doctor --workspace --json   # the same for a script
```

Run it from the workspace root: the directory with the lockfile and the
`workspaces` list, `pnpm-workspace.yaml` or `nx.json`. A repository with one
app needs no `--workspace`. Run `byakugan doctor` in the app directory.

The table has one row per app. byakugan counts a package as an app when one of
these holds:

- it detects a framework in it (Next.js, Vite, React Router) or a Cloudflare
  Worker
- its Nx `project.json` says `"projectType": "application"`
- it has a `byakugan.json`
- no other workspace package depends on it

Compare the rows with the apps you deploy and test. Two things go wrong here.

A deployable is missing. An API that the web app imports types from counts as
a library. A package with no `index`, `main`, `server` or `app` file has no
entries. Give it a `byakugan.json` next to its `package.json`:

```json
{ "entry": ["src/server.ts"] }
```

A library shows up as an app. That costs time, not correctness. Ignore its
row in CI.

`packages/ui` and other shared libraries get no row. Their changes show up in
the apps that use them, export by export.

## Step 3: fix what doctor found

`doctor` exits with 1 while a finding of severity `blocks` or `hides` is open.
Fix them in this order.

| Severity | Kind | What it means | Fix |
| --- | --- | --- | --- |
| `blocks` | `no-entries` | byakugan found no entry file | Add `"entry"` globs to `byakugan.json` |
| `blocks` | `unresolved-import` | An import of project code does not resolve, so every run says "affected" | Declare the alias in tsconfig `paths`. byakugan does not read webpack, Turbopack, Vite or Storybook aliases. For a module a bundler plugin provides, add its specifier to `"virtual"` |
| `hides` | `build-output` | A workspace package's `exports` point at `dist`, which git does not track | Add a `"source"` export condition that points at `src`, and set `"conditions": ["source"]` in the app's `byakugan.json` |
| `hides` | `computed-import` | An `import()` or `require()` whose path byakugan cannot read | List the files it can load under `"entry"` (code) or `"inputs"` (data) |
| `hides` | `whole-directory` | Code reads files from the whole project directory | List the files it reads under `"inputs"` |
| `hides` | `outside-repository` | A path leaves the git root | Move the file into the repository, or add it to your own cache key |
| `hides` | `unreadable-file` | A file is missing or not a regular file | Run code generation before byakugan, as the build does |
| `coarse` | `tailwind-failed` | Tailwind could not run, so every file it may scan counts | Check that the Tailwind config loads right after install, without build-time environment |
| `coarse` | `missing-export` | An import names an export byakugan cannot find | Usually harmless |
| `note` | `env` | Live code reads environment variables whose values are not hashed | List the ones the build inlines under `"env"`, for example `["API_*"]` |
| `note` | `shallow-clone` | The clone has no full history | In CI, set `fetch-depth: 0` on `actions/checkout` |

A `source` export condition looks like this in the library's `package.json`:

```json
{
  "exports": {
    ".": { "source": "./src/index.ts", "types": "./dist/index.d.ts", "default": "./dist/index.js" }
  }
}
```

Generated code that git ignores, such as a Prisma client, belongs under
`"generated"`, with the generator's inputs under `"inputs"`:

```json
{ "generated": ["src/generated/**"], "inputs": ["prisma/schema.prisma"] }
```

Run `doctor` again after each fix. Stop when it exits with 0.
[configuration.md](configuration.md) lists every `byakugan.json` field.

## Step 4: check a few verdicts by hand

Make an edit whose answer you know, and ask byakugan. Do not commit the edits.

```sh
# a README edit reaches nothing
echo >> README.md
npx --no-install byakugan affected --workspace --base HEAD

# an edit to a function one app calls reaches that app, and prints the import chain
npx --no-install byakugan affected -C apps/web --base HEAD

# why is this file part of the app at all?
npx --no-install byakugan why packages/ui/src/Button.tsx -C apps/web
```

`--base HEAD` compares the working tree with the last commit. Try three kinds
of edit per app: a file nothing imports (unaffected), an unused export next to
a used one in a shared library (unaffected), and the body of a function a page
renders (affected). A wrong answer here is a setup problem. See
[When a verdict looks wrong](#when-a-verdict-looks-wrong).

## Step 5: choose what to skip

| You want to skip | Command | Mode |
| --- | --- | --- |
| End-to-end tests of an app | `affected -C <app> --base <ref>` | default |
| A build or deploy, or reuse a build artifact | `hash -C <app> --strict` as the cache key, or `affected --strict` | `--strict` |
| Unit or component tests, one verdict per test file | `affected --each '<test glob>' --base <ref>` | default |
| Storybook stories, visual tests | `affected --each '<story glob>' --base <ref>` | default |
| All apps of a monorepo at once | `affected --workspace --base <ref>` | either |

The default mode, `behavior`, promises that an unaffected app runs the same.
`--strict` also promises the same build output. Use `--strict` only where a
build artifact is reused, because it reports "affected" more often.

Lint, format and type checks read comments and formatting, which byakugan
ignores on purpose. Do not gate them on byakugan.

## Step 6: run in shadow mode

Add byakugan to CI without skipping anything, and record what it says.

For end-to-end tests, keep running them on every pull request and log the
verdict next to the result. A test that fails on a pull request byakugan called
"unaffected", and passes on the base, is a miss. Look at it with `byakugan why`
and fix the setup.

For builds, compare real build output. When `affected --strict` says
unaffected, build the base commit too and run:

```sh
npx --no-install byakugan compare ../base/apps/web/.next apps/web/.next
```

It exits with 1 and names the files that differ. [ci.md](ci.md) has both as
workflows. Two weeks of pull requests without a miss is a reasonable bar.

## Step 7: skip

Turn the recorded verdict into a condition. In GitHub Actions, `affected`
writes `affected=true|false` to `$GITHUB_OUTPUT`, and with `--workspace` also
`apps=`, a JSON list of the affected app directories.

```yaml
- uses: actions/checkout@v7
  with:
    fetch-depth: 0 # affected needs the merge base
- run: npm ci
- id: web
  env:
    BASE_REF: ${{ github.base_ref }} # through env, so a branch name cannot inject shell code
  run: npx --no-install byakugan affected -C apps/web --base "origin/$BASE_REF"
- if: steps.web.outputs.affected != 'false'
  run: npm run e2e --workspace web
```

Always run everything on pushes to the main branch. Skipping is for pull
requests.

## Reading results

Exit codes are the same for every command.

| Code | Meaning |
| --- | --- |
| 0 | Done. For `affected`, the verdict is in the output |
| 1 | `affected --exit-code` found the app affected, `doctor` found a `blocks` or `hides` finding, or `compare` found a difference |
| 2 | Usage error or failure. Treat it as "affected" |

`--json` prints one JSON document on stdout. Warnings and progress go to
stderr. With `--json`, an error is `{"error":{"message","hint","help"}}` on
stderr. `byakugan <command> --help` shows the JSON shape of each command.

The fields a script needs:

```sh
byakugan affected --base origin/main --json             | jq .affected          # true or false
byakugan affected --workspace --base origin/main --json | jq -c .affected       # ["apps/web"]
byakugan affected --base origin/main --each 'src/**/*.test.ts' --json | jq -c .each
byakugan hash --json                                    | jq -r .fingerprint
byakugan doctor --workspace --json                      | jq '.apps[] | {app, findings: [.findings[].kind]}'
```

## Setups

### Turborepo

Turborepo decides per package. An edit to `Modal` in `packages/ui` rebuilds
every app that depends on `packages/ui`. byakugan decides per export, so use
it to choose the apps and Turborepo to run and cache the tasks:

```sh
apps=$(npx --no-install byakugan affected --workspace --base origin/main --json | jq -r '.affected[] | "--filter=./" + .')
[ -n "$apps" ] && npx turbo run build e2e $apps
```

`--filter=./apps/web` selects the package in that directory. Turborepo's own
cache still applies to the tasks that run.

### Nx

byakugan reads `nx.json` and counts every `project.json` with
`"projectType": "application"` as an app, with or without a `package.json`.
Dependencies come from the root `package.json`.

`nx affected` decides per project from its own project graph. byakugan gives
directories, and Nx targets take project names. When project names match
directory names:

```sh
projects=$(npx --no-install byakugan affected --workspace --base origin/main --json | jq -r '[.affected[] | split("/") | last] | join(",")')
[ -n "$projects" ] && npx nx run-many -t build e2e --projects="$projects"
```

When they differ, read each project's name from its `project.json`.

A Playwright project such as `apps/web-e2e` has no app entry file, so it gets
no row until you give it a `byakugan.json`. See the next section.

### End-to-end tests with Playwright or Cypress

End-to-end specs drive a browser. They do not import app code, so byakugan
cannot tell which spec covers which page. Gate the whole suite on two verdicts:
the app under test, and the test package itself.

Give the test package a `byakugan.json`, so an edited spec or helper counts:

```json
{ "framework": "none", "entry": ["tests/**/*.spec.ts", "playwright.config.ts"] }
```

Then run the suite when either is affected:

```sh
affected=$(npx --no-install byakugan affected --workspace --base origin/main --json | jq -c .affected)
echo "$affected" | jq -e 'index("apps/web") or index("apps/api") or index("e2e")' > /dev/null && npm run e2e
```

List every app the suite talks to, the API included. With one suite per app,
map each suite to its own apps the same way.

Playwright component tests and Vitest browser tests import the code they
test. For those, use `--each` as in the unit test section.

### Storybook

A story imports its component, so byakugan gives one verdict per story file:

```sh
npx --no-install byakugan affected -C packages/ui --base origin/main --each 'src/**/*.stories.tsx' > stories.txt
```

`stories.txt` holds the story files a change reaches, one per line. Files in
`.storybook/` (`main`, `preview`, `manager`) count for every story, and so
does everything `preview` imports, such as global styles and decorators.

For a cache key over everything the stories use, for example to reuse a
Storybook build:

```sh
npx --no-install byakugan hash -C packages/ui --each 'src/**/*.stories.tsx'
```

Aliases set in `webpackFinal` or `viteFinal` are not read. Put them in
tsconfig `paths`.

### Unit and component tests

```sh
npx --no-install byakugan affected --base origin/main --each 'src/**/*.test.{ts,tsx}' > tests.txt
[ -s tests.txt ] && xargs npx vitest run < tests.txt
```

Check that the list is not empty before you pass it on. `vitest run` and
`jest` with no file arguments run every test. A change to the runner config
(`vitest.config.*`, `jest.config.*`, `playwright.config.*`), a setup file or
`package.json` reaches every test.

### Next.js with webpack or Turbopack

byakugan does not run the bundler. It follows imports the way both bundlers
resolve them: tsconfig `paths`, package `exports`, `import()` with a template
string, `require.context`, `next/dynamic`. What it does not read is bundler
configuration: `webpack.resolve.alias`, `turbopack.resolveAlias`, custom
loaders. Declare aliases in tsconfig `paths`. A loader or plugin that
`next.config` names in a string counts by its installed version.

`compare` was checked against Turbopack builds on Next.js 16. Webpack builds
are untested, so run the shadow mode of step 6 before you reuse webpack build
output.

### Very large monorepos

- Run `affected --workspace` once, in one job, and fan out with a matrix over
  its `apps` output. Do not run byakugan once per app in separate jobs. One
  run parses each shared file once.
- A workspace of 8 apps over a 6,000-module shared package takes about 8 s.
- Git mode needs the merge base. `fetch-depth: 0` is the simple way. In a
  repository where full history is too slow to fetch, fetch the base branch
  with enough depth to reach the merge base.
- Dependency bumps count per package in git mode. For file-level precision
  inside `node_modules`, save a manifest on the main branch and compare with
  `--base-manifest`. [ci.md](ci.md) has the recipe.

## When a verdict looks wrong

"Affected", and you expected "unaffected":

1. Read the reason and its chain in the output. The chain shows the imports
   from an entry to the changed code.
2. `byakugan why <file>#<export> -C <app>` prints the same chain for anything.
3. Common causes: an unresolved import (every run is affected, see step 3), a
   barrel whose modules run top-level code, a top-level call such as
   `export const store = createStore()` (mark it `/*#__PURE__*/` when it only
   builds a value), a dependency bump in git mode.

"Unaffected", and the app changed:

1. Run `byakugan doctor -C <app>` and look for `hides` findings.
2. Check whether the change is something byakugan cannot hash: data fetched
   at build time, an environment variable that a config file reads, a file
   read through a computed path. [limits.md](limits.md) lists them all.
3. Add the missing files to `"inputs"`, the variables to `"env"`.

## A section for your AGENTS.md

Paste this into the repository's `AGENTS.md` or `CLAUDE.md`, so agents that
work in the repository know how the CI gate works:

```md
## Change detection (byakugan)

CI skips end-to-end tests for apps a pull request cannot reach. byakugan
decides, from the graph of code each app uses.

- Which apps does my branch change: `npx --no-install byakugan affected --workspace --base origin/main`
- Why is a file part of an app: `npx --no-install byakugan why <file> -C <app dir>`
- After adding an alias, an entry point, generated code or a new app:
  `npx --no-install byakugan doctor --workspace` must exit with 0.
- Aliases go in tsconfig `paths`. byakugan does not read bundler aliases.
- Per-app settings live in `byakugan.json` next to the app's `package.json`.
- `byakugan <command> --help` and `byakugan guide` have the details.
```
