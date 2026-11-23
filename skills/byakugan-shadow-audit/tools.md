# What the build tool did

Step 4 of the audit needs, for each app in each run, one outcome: **ran**,
**cached** or **skipped**, plus whether its tasks passed. Read it from the
CI log first. Recompute it locally only when the log does not say.

Match apps by directory. byakugan names apps by path (`apps/web`); Nx and
Turborepo name them by project or package name. Build the map once.

## Turborepo

Map: the `name` field of each app's `package.json`.

The log prints one line per task:

- `web:build: cache miss, executing <hash>`: ran
- `web:build: cache hit, replaying logs <hash>` (or `cache hit, suppressing
  logs`): cached. Turborepo's hash of the package's inputs matched an earlier
  run.
- no line for the package: skipped by `--filter`

With `--summarize`, `.turbo/runs/<id>.json` lists `tasks[].cache.status`
(`HIT` or `MISS`). Use it if the workflow uploads it as an artifact.

To recompute what a filter would select:
`npx turbo run build --filter='...[<merge base>]' --dry=json`, read
`packages`.

## Nx

Map: `npx nx show project <name> --json`, field `root`.

The log prints one line per task:

- `> nx run web:build` with no suffix: ran
- `[local cache]`, `[remote cache]` or `[existing outputs match the cache,
  left as is]` after it: cached
- the project missing from the run: skipped by `nx affected`

To recompute the affected set:
`npx nx show projects --affected --base=<merge base> --head=<sha> -t build --json`.

## A plain workflow

Without Nx or Turborepo, a shadow workflow builds and tests every app on
every run, so every outcome is **ran** and step 5 makes every unaffected
verdict a suspect. Step 6 then has only test results, `byakugan compare` and
reading the change to go on. Say in the report that no build tool narrowed
the comparison.
