---
name: byakugan-shadow-audit
description: Audits byakugan's shadow-mode verdicts against what CI really built and tested (Nx, Turborepo, plain workflows) over a date range, default the last 7 days. Use when asked whether byakugan was right, to check shadow mode, to find misses, or whether it is safe to start skipping.
---

# byakugan shadow audit

In shadow mode CI runs everything and byakugan only records a verdict per app
(docs/adopting.md, step 6). This skill grades those verdicts. Each sample is
one app in one CI run of a pull request, and it ends with one of these grades:

- **miss** (red card): byakugan said unaffected and the app needed the
  rebuild or the tests. Skipping would have shipped a stale app.
- **extra** (yellow card): byakugan said affected and nothing needed to run.
  It costs CI minutes, nothing more.
- **agree**: byakugan and the evidence say the same.
- **clean skip**: byakugan said unaffected, the build tool ran the app anyway,
  and the evidence shows nothing changed. This is the saving byakugan exists
  for.
- **unresolved**: the evidence cannot settle it. Say why.

Hunt misses first. One miss outweighs any number of extras.

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
   matched), **skipped** (the tool did not select it), and whether its build
   and test tasks passed. How to read this from Nx, Turborepo or a plain
   workflow is in [tools.md](tools.md). Done when every sample has an outcome.

5. **First grades.**

   | byakugan | tool | grade |
   | --- | --- | --- |
   | affected | ran | agree |
   | affected | cached or skipped | extra |
   | unaffected | cached or skipped | agree |
   | unaffected | ran | suspect, go to step 6 |

   A task that failed on a PR where byakugan said unaffected is a suspect even
   when the tool skipped it elsewhere.

6. **Resolve every suspect.** Take the strongest evidence you can get:

   1. `byakugan compare` in the run: a failure is a miss, a pass is a clean
      skip.
   2. A test or build that failed on the PR head and passes on its merge
      base is a miss, unless it is flaky on the base too (rerun history).
   3. After the PR merged, a failure on the main branch in that app that the
      PR caused is a miss.
   4. Build it yourself: check out the merge base and the head in two git
      worktrees, build the app in both and run
      `npx byakugan compare <base output> <head output>`. Ask before doing
      this for more than 10 suspects, since each is two builds.
   5. Read the change: `gh pr diff <n> --name-only`, then at the head run
      `npx byakugan affected -C <app> --base <merge base> --verbose`. If every
      changed file is outside the app or listed under "changes nothing uses",
      and no file is of a kind docs/limits.md lists under "These can miss a
      change", grade it **clean skip (read)**. Otherwise it stays unresolved.

   Done when every suspect is a miss, a clean skip (with the evidence that
   proved it) or unresolved with a reason. A suspect never drops out of the
   report.

7. **Explain each miss.** Find the input byakugan did not see:
   `npx byakugan why <file> -C <app>` on the changed files, then match the
   cause to docs/limits.md (build-time data, environment variables, computed
   `import()`, bundler aliases, a top-level call assumed pure). Say whether a
   setting fixes it (`inputs`, `env`, `virtual` in byakugan.json) or whether
   byakugan itself is wrong. For the second, draft an issue for
   IShotTheSheriff/byakugan with a minimal reproduction, and ask the user
   before filing it.

8. **Group the extras.** Group extras by byakugan's first reason, add up the
   CI minutes of the jobs they ran (job durations from `gh run view <id>
   --json jobs`), and name the cause for the biggest groups, for example a
   default import of a CommonJS package or a top-level call that is not
   marked `/*#__PURE__*/` (docs/limits.md, "These cost extra builds"). When
   the reason is a file the tool's own inputs leave out, such as a root
   `.env` or a config outside the package, the tool may be the one that
   missed it. Say so.

## Report

Write it in this order:

1. Range, repository, the number of PRs, runs and samples.
2. **Misses**, each with: PR link, commit, app, what changed, the evidence
   that proves it, the cause and the fix. If there are none, say that
   plainly.
3. **Unresolved** suspects and what would settle each.
4. **Extras**: count, CI minutes, the top groups with their cause and fix.
5. Counts per grade, plus the share of samples byakugan would have skipped
   and the share the tool alone skipped or cached.
6. Readiness: docs/adopting.md sets the bar at two weeks of pull requests
   without a miss. Say whether this range meets it, and if it is shorter
   than two weeks, say that too.
