# What the build tool did

Step 4 of the audit needs, for each app in each run, one outcome: **ran**,
**cached** or **skipped**, whether its tasks passed, and how long they took. Read it from the
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
(`HIT` or `MISS`) and `tasks[].execution` with `startTime` and `endTime`
in milliseconds. Use it if the workflow uploads it as an artifact.

To recompute what a filter would select:
`npx turbo run build --filter='...[<merge base>]' --dry=json`, read
`packages`.

## Nx

Nx Cloud shows per-task durations for the run; the log alone does not.

Map: `npx nx show project <name> --json`, field `root`.

The log prints one line per task:

- `> nx run web:build` with no suffix: ran
- `[local cache]`, `[remote cache]` or `[existing outputs match the cache,
  left as is]` after it: cached
- the project missing from the run: skipped by `nx affected`

To recompute the affected set:
`npx nx show projects --affected --base=<merge base> --head=<sha> -t build --json`.

## Durations

Without per-task times, take job times:
`gh run view <id> --json jobs --jq '.jobs[] | {name, startedAt, completedAt}'`.
A job that builds one app belongs to that app. Split a job that builds
several apps evenly between them, and leave out setup such as checkout and
install, which runs anyway: subtract the steps before the first build step
(`gh run view <id> --json jobs --jq '.jobs[].steps'`).

## A plain workflow

Without Nx or Turborepo, a shadow workflow builds and tests every app on
every run, so every outcome is **ran** and step 5 makes every unaffected
verdict a disagreement for step 6 to judge. Every saving is then measured
against running everything. Say in the report that no build tool narrowed
the comparison.
