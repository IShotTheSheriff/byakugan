---
name: byakugan-shadow-audit
description: Audits byakugan's shadow-mode verdicts against what CI really ran (Nx, Turborepo, plain workflows) over a date range, default the last 7 days, and estimates the CI time byakugan would save. Use when asked whether byakugan was right, to check shadow mode, to find misses, whether adding byakugan pays off, or whether it is safe to start skipping.
---

# byakugan shadow audit

In shadow mode CI runs everything and byakugan only records a verdict per app
(docs/adopting.md, step 6). This skill sets each verdict beside what the
build tool ran, reasons over the pull request's diff to decide who was right,
and adds up the CI time byakugan would have saved. Each sample is one app in
one CI run of a pull request, and it ends with one of these grades:

- **miss** (red card): byakugan said unaffected and the app needed the
  rebuild or the tests. Skipping would have shipped a stale app.
- **extra** (yellow card): byakugan said affected and nothing needed to run.
  It costs CI minutes, nothing more.
- **saving**: byakugan said unaffected, the build tool ran the app anyway,
  and the diff cannot change it. This is what byakugan is for.
- **agree**: byakugan and the build tool did the same thing.
- **unresolved**: neither the diff nor the evidence settles it. Say why.

Hunt misses first. One miss outweighs any number of extras or savings.

The docs named below ship with the package, in
`node_modules/byakugan-cli/docs/`.

## Steps

1. **Range.** Default to the 7 days ending now. Turn any range the user gives
   ("since Monday", "October", two dates) into ISO dates and repeat it at the
   top of the report. GitHub keeps run logs for 90 days by default; say so if
   the range reaches past that. Done when you have `from` and `to`.

2. **Shadow runs.** Find the workflows that call `byakugan affected`
   (`grep -rl 'byakugan affected' .github/workflows`), then their pull
   request runs in the range:

   ```sh
   gh run list --workflow <file> --event pull_request \
     --created "<from>..<to>" --limit 1000 \
     --json databaseId,headSha,headBranch,createdAt,conclusion,url
   ```

   Every push to a PR is its own run and its own samples. Map each run to its
   PR number (`gh pr list --head <branch> --state all`). With no such
   workflow, stop and point the user to docs/adopting.md, step 6. Done when
   every run in the range is listed with its PR and the count is written down.

3. **Verdicts.** For each run, read byakugan's verdict per app from the job
   log (`gh run view <id> --log`) or the job summary table. `--workspace`
   prints `apps/web  affected  source: ...`, one line per app; `--json`
   prints `{ affected: [...], apps: [...] }`. A byakugan step that exited 2
   or failed counts as affected by design: grade it apart as **error** and
   keep its message. Done when every run has a verdict for every app, or an
   error.

4. **What really ran.** For each sample, find what the build tool did with
   the app: **ran** (executed, cache miss), **cached** (cache hit, its inputs
   matched) or **skipped** (the tool did not select it), whether its tasks
   passed, and how many minutes its tasks took. How to read this from Nx,
   Turborepo or a plain workflow is in [tools.md](tools.md). Done when every
   sample has an outcome and a duration.

5. **Sort.**

   | byakugan | tool | grade |
   | --- | --- | --- |
   | affected | ran | agree |
   | affected | cached or skipped | extra |
   | unaffected | cached or skipped | agree |
   | unaffected | ran | disagreement, go to step 6 |

   A task that failed on a PR where byakugan said unaffected is a
   disagreement whatever the tool did.

6. **Judge each disagreement.** Nx and Turborepo rebuild an app when anything
   in a package it depends on changes. byakugan follows single exports, so it
   is often right to disagree. Decide each case as a reviewer would:

   1. Read the diff: `gh pr diff <n>`, and at the head
      `npx byakugan affected -C <app> --base <merge base> --verbose`, which
      lists the changes that reach the app and the ones nothing uses.
   2. For each changed hunk, trace whether it can reach the app at runtime or
      at build time: who imports the changed export, whether the module has
      top-level side effects, whether a config, environment variable, asset,
      generated file or build-time data source changed. docs/limits.md, "These
      can miss a change", lists the kinds byakugan cannot see. Check each one
      against the diff.
   3. Decide **saving** or **miss**, with the chain of reasoning in two or
      three sentences and a confidence: high when you followed every changed
      hunk to a dead end or into the app, low when a hunk leaves the code you
      can read (dynamic paths, plugins, CI scripts).
   4. Hard evidence overrides your reading. A failing `byakugan compare` in
      the run, a test that fails on the PR head and passes on its merge base,
      or a failure on the main branch after the merge that the PR caused is a
      miss.
   5. For a low-confidence call, offer to settle it by building both sides:
      check out the merge base and the head in two git worktrees, build the
      app in both and run `npx byakugan compare <base output> <head output>`.
      Ask before running builds. Without them the case is **unresolved**.

   Done when every disagreement is a saving, a miss or unresolved, each with
   its reasoning. A disagreement never drops out of the report.

7. **Explain each miss.** Name the input byakugan did not see, using
   `npx byakugan why <file> -C <app>` and docs/limits.md. Say whether a
   setting fixes it (`inputs`, `env`, `virtual` in byakugan.json) or byakugan
   itself is wrong. For the second, draft an issue for IShotTheSheriff/byakugan
   with a minimal reproduction, and ask the user before filing it.

8. **Group the extras.** Group extras by byakugan's first reason and name the
   cause for the biggest groups, for example a default import of a CommonJS
   package or a top-level call not marked `/*#__PURE__*/` (docs/limits.md,
   "These cost extra builds"). When the reason is a file the tool's own inputs
   leave out, such as a root `.env` or a config outside the package, the tool
   may be the one that missed it. Say so.

9. **CI time.** Add up the task minutes of every saving: the time byakugan
   would have saved over the build tool alone. Add up the minutes of every
   extra: the time it would have spent that the tool's cache did not. Report
   both, the difference, and a projection to a month at the range's pace.
   Say how you measured: per-task durations when the tool reports them, or
   job durations split evenly between the apps a job built. Unresolved
   samples count in neither sum; give their minutes apart.

## Report

Write it in this order:

1. Range, repository, the number of PRs, runs and samples.
2. **Misses**, each with: PR link, commit, app, what changed, the reasoning
   or evidence, the cause and the fix. If there are none, say that plainly.
3. **CI time**: minutes saved, minutes of extras, the net, the monthly
   projection, and the method.
4. **Savings**: count, and three or four typical cases with their one-line
   reasoning, so the reader can check the judgement.
5. **Unresolved** cases and what would settle each.
6. **Extras**: count, the top groups with their cause and fix.
7. Counts per grade.
8. Readiness: docs/adopting.md sets the bar at two weeks of pull requests
   without a miss. Say whether this range meets it, and if it is shorter
   than two weeks, say that too.
