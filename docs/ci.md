# CI recipes

In GitHub Actions, `hash` and `affected` write `fingerprint=` and `affected=`
to `$GITHUB_OUTPUT`, and `affected` adds a table to the job summary. With
`--workspace`, they also write `apps=`, a JSON list of the affected app
directories, and `fingerprints=`, a JSON object from app directory to
fingerprint. Warnings (imports byakugan cannot follow, Tailwind
failures) go to stderr, so stdout stays a fingerprint or JSON. `affected` also
lists them under "warnings".

The workflow needs only `contents: read`. Pass `github.base_ref` through `env`
rather than into the script itself, so a branch name cannot inject shell code.

[adopting.md](adopting.md) explains when each recipe fits and how to check
byakugan before you trust it. This page has the workflows.

## Skip a build on a pull request

```yaml
- uses: actions/checkout@v7
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

## Build only the affected apps of a monorepo

```yaml
jobs:
  affected:
    runs-on: ubuntu-latest
    outputs:
      apps: ${{ steps.byakugan.outputs.apps }}
    steps:
      - uses: actions/checkout@v7
        with:
          fetch-depth: 0
      - run: npm ci
      - id: byakugan
        env:
          BASE_REF: ${{ github.base_ref }}
        run: npx --no-install byakugan affected --workspace --base "origin/$BASE_REF"
  build:
    needs: affected
    if: needs.affected.outputs.apps != '[]'
    runs-on: ubuntu-latest
    strategy:
      matrix:
        app: ${{ fromJSON(needs.affected.outputs.apps) }}
    steps:
      - uses: actions/checkout@v7
      - run: npm ci
      - env:
          APP: ${{ matrix.app }}
        run: npm run build --prefix "$APP"
```

App directories come from the repository, so the build step reads the app
from `env` too.

## Skip end-to-end tests in a monorepo

End-to-end specs do not import app code, so the suite runs when a change
reaches an app it talks to, or the test package itself. Make the test package
an app with a `byakugan.json`:

```json
{ "framework": "none", "entry": ["tests/**/*.spec.ts", "playwright.config.ts"] }
```

```yaml
jobs:
  changes:
    runs-on: ubuntu-latest
    outputs:
      apps: ${{ steps.byakugan.outputs.apps }}
    steps:
      - uses: actions/checkout@v7
        with:
          fetch-depth: 0
      - run: npm ci
      - id: byakugan
        env:
          BASE_REF: ${{ github.base_ref }}
        run: npx --no-install byakugan affected --workspace --base "origin/$BASE_REF"
  e2e:
    needs: changes
    if: >-
      contains(fromJSON(needs.changes.outputs.apps), 'apps/web') ||
      contains(fromJSON(needs.changes.outputs.apps), 'apps/api') ||
      contains(fromJSON(needs.changes.outputs.apps), 'e2e')
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - run: npm ci
      - run: npm run e2e --workspace e2e
```

[examples/github-actions-monorepo-e2e.yml](../examples/github-actions-monorepo-e2e.yml)
is the full workflow, with pushes to `main` running everything.

## Turborepo and Nx

byakugan picks the apps, and the task runner runs and caches the tasks:

```yaml
- id: byakugan
  env:
    BASE_REF: ${{ github.base_ref }}
  run: npx --no-install byakugan affected --workspace --base "origin/$BASE_REF"
# Turborepo: one --filter per affected app directory
- if: steps.byakugan.outputs.apps != '[]'
  env:
    APPS: ${{ steps.byakugan.outputs.apps }}
  run: npx turbo run build $(echo "$APPS" | jq -r '.[] | "--filter=./" + .')
# Nx: project names, here equal to the directory names
- if: steps.byakugan.outputs.apps != '[]'
  env:
    APPS: ${{ steps.byakugan.outputs.apps }}
  run: npx nx run-many -t build --projects="$(echo "$APPS" | jq -r '[.[] | split("/") | last] | join(",")')"
```

## Run only the Storybook stories a change reaches

```yaml
- id: stories
  env:
    BASE_REF: ${{ github.base_ref }}
  run: npx --no-install byakugan affected -C packages/ui --base "origin/$BASE_REF" --each 'src/**/*.stories.tsx' > stories.txt
- if: steps.stories.outputs.affected == 'true'
  run: cat stories.txt # pass the list to your visual test runner
```

`.storybook/main`, `.storybook/preview` and what `preview` imports reach
every story.

## Run only the tests a change reaches

```yaml
- id: tests
  env:
    BASE_REF: ${{ github.base_ref }}
  run: npx --no-install byakugan affected --base "origin/$BASE_REF" --each 'src/**/*.test.ts' > tests.txt
- if: steps.tests.outputs.affected == 'true'
  run: xargs npx vitest run < tests.txt
```

Check `affected` before you run the list. `vitest run` with no file arguments
runs every test.

## Reuse a build when nothing it uses changed

```yaml
- run: npm ci
- id: web
  run: npx --no-install byakugan hash -C apps/web --strict
- id: cache
  uses: actions/cache@v6
  with:
    path: apps/web/.next
    key: web-next-${{ steps.web.outputs.fingerprint }}
- if: steps.cache.outputs.cache-hit != 'true'
  run: npm run build --workspace web
```

This covers dependency updates exactly, because the fingerprint hashes the
installed files the app uses. `--strict` makes the key cover everything the
build emits. Leave it out when the key guards a test run.

## Exact comparison against main

Save a manifest on `main` under the commit's SHA. On a pull request, restore
the one for the merge base and compare with it. Without a manifest for that
commit, fall back to git mode:

```yaml
# on push to main
- run: npx --no-install byakugan hash -C apps/web --manifest .byakugan/web.json
- uses: actions/cache/save@v6
  with:
    path: .byakugan/web.json
    key: byakugan-web-${{ github.sha }}

# on pull_request
- id: base
  env:
    BASE_REF: ${{ github.base_ref }}
  run: echo "sha=$(git merge-base "origin/$BASE_REF" HEAD)" >> "$GITHUB_OUTPUT"
- id: manifest
  uses: actions/cache/restore@v6
  with:
    path: .byakugan/web.json
    key: byakugan-web-${{ steps.base.outputs.sha }}
- id: web
  env:
    BASE_SHA: ${{ steps.base.outputs.sha }}
    HAVE_MANIFEST: ${{ steps.manifest.outputs.cache-hit }}
  run: |
    if [ "$HAVE_MANIFEST" = "true" ]; then
      npx --no-install byakugan affected -C apps/web --base-manifest .byakugan/web.json
    else
      npx --no-install byakugan affected -C apps/web --base "$BASE_SHA"
    fi
```

The manifest has to come from the merge base. One from a newer `main` counts
other people's changes as yours. A manifest records the byakugan version and
the mode that wrote it, and a run with another version or mode reports
"affected" with that as its one reason.

For one verdict per test file, write the manifest with the same `--each`
globs: `byakugan hash --each 'src/**/*.test.ts' --manifest tests.json`. It then
holds a fingerprint per file, over the code that file reaches, and
`affected --each ... --base-manifest tests.json` prints the files whose
fingerprint moved. A test that drops an import is reached, and no other.

[examples/github-actions-e2e.yml](../examples/github-actions-e2e.yml) is this
recipe as a full workflow that skips end-to-end tests.

## Check byakugan against real builds

Before you skip builds on byakugan's word, run it in shadow mode for a while.
Build every pull request, and when byakugan says unaffected, also build the
merge base and compare the two:

```yaml
- id: web
  env:
    BASE_REF: ${{ github.base_ref }}
  run: npx --no-install byakugan affected -C apps/web --strict --base "origin/$BASE_REF"
- run: npm run build --workspace web
- if: steps.web.outputs.affected == 'false'
  env:
    BASE_REF: ${{ github.base_ref }}
  run: |
    git worktree add ../base "$(git merge-base "origin/$BASE_REF" HEAD)"
    (cd ../base && npm ci && npm run build --workspace web)
    npx --no-install byakugan compare ../base/apps/web/.next apps/web/.next
```

A failing `compare` means byakugan missed an input. Its output names the
files that differ.

See [examples/github-actions.yml](../examples/github-actions.yml) for a full
workflow.
