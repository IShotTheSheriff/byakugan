---
name: byakugan-setup
description: Sets up byakugan in a repository, from install to a shadow-mode CI job, with the checks that make its verdicts trustworthy. Use when asked to add, install, configure or set up byakugan, to make CI skip work for apps a pull request cannot change, or when `byakugan doctor` reports findings.
---

# byakugan setup

docs/adopting.md is the full guide (`npx --no-install byakugan guide` prints
it from the installed package, and the docs it links are in
`node_modules/byakugan-cli/docs/`). Read it once before you start. This skill
walks the same path and adds what goes wrong when an agent follows it alone.

The goal of a setup is a CI job in **shadow mode**: byakugan records a
verdict per app on every pull request and nothing is skipped yet. Skipping
comes after two weeks without a miss, and the user decides it, not you.

## Rules

- A failed run means "run everything". Write every CI condition as
  `affected != 'false'`, never `affected == 'true'`. Exit code 2 is a failure.
- Call it as `npx --no-install byakugan`. Plain `npx byakugan` can download an
  unrelated package of that name.
- Fix findings through configuration: `byakugan.json`, tsconfig `paths`,
  package `exports`. Never delete or rewrite app code to make a finding go
  away. After a change to tsconfig or a package's `exports`, run the app's
  build and type check to see that it still passes.
- Ask the user before you push, open a pull request or change CI that other
  people depend on.

## Steps

1. **Read the repository.** Write down the package manager, the workspace
   tool (Nx, Turborepo, plain workspaces or one app), the frameworks, and
   what CI does per app today: builds, end-to-end tests, deploys. With
   GitHub Actions, `gh run list --workflow <file> --limit 50 --json
   databaseId,createdAt,updatedAt,event` gives the run times. Those are the
   minutes byakugan can save; tell the user which jobs are worth gating.
   Done when you can name every deployable app and the CI work it costs.

2. **Install** byakugan once in the workspace root (adopting.md, step 1) and
   check `npx --no-install byakugan --version`. It needs Node.js 22.12 or
   newer, locally and in CI.

3. **Find the apps.** Run `npx --no-install byakugan doctor --workspace
   --json` from the workspace root. Compare its apps with the list from step
   1. A missing deployable gets a `byakugan.json` with `"entry"`. A library
   listed as an app costs time, not correctness; leave it. If you cannot tell
   whether a package is deployed, ask.

4. **Fix the findings** in adopting.md's order, `blocks` first, then
   `hides`. Each finding has a `fix`. Run `doctor` again after each fix.
   Done when `doctor --workspace` exits with 0. A `note` may stay open; tell
   the user which ones and what they mean.

5. **Check verdicts by hand.** For each app make three edits whose answer you
   know (adopting.md, step 4): a file nothing imports (unaffected), an unused
   export beside a used one in a shared library (unaffected), the body of a
   function a page renders (affected). Run `affected -C <app> --base HEAD`
   after each. Edit only files with no uncommitted changes, and restore each
   one with `git checkout -- <file>` before the next. A wrong answer is a
   setup problem: go back to step 4 with `byakugan why`. Done when every app
   gave three right answers and the tree is clean.

6. **Choose the gates with the user.** Show adopting.md's step 5 table
   against the jobs from step 1: `behavior` mode for tests, `--strict` for
   builds and deploys, `--each` for unit tests and stories. Lint, format and
   type checks never get a gate. Done when the user picked which jobs to
   gate.

7. **Write the shadow job.** Add byakugan to CI without skipping anything:
   - Run it after the install step, with `fetch-depth: 0` on checkout.
   - Pass the base branch through `env` (`BASE_REF: ${{ github.base_ref }}`),
     never straight into the shell line.
   - In a monorepo, run `affected --workspace` once and keep its output in
     the log; it also writes a table to the job summary.
   - For builds, add the compare step from docs/ci.md, "Check byakugan
     against real builds": when `--strict` says unaffected, build the merge
     base too and run `byakugan compare`.
   - If a Next.js app has server actions (`grep -rl "'use server'"`), set
     `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY` to one value for every build in
     the job. Without it, each build gets new action IDs and `compare` fails
     on every pull request. A key made in the job works on forks too:
     `echo "NEXT_SERVER_ACTIONS_ENCRYPTION_KEY=$(openssl rand -base64 32)" >> "$GITHUB_ENV"`.
   - Pushes to the main branch always run everything.

8. **Check that builds are reproducible.** For each app whose build you will
   compare, build one commit twice the way the job does and run
   `npx --no-install byakugan compare <first> <second>`. Ask before running
   builds that take long. If the two builds differ, read the files `compare`
   names and find what changes per build (a timestamp, a random ID, the key
   from step 7). Until two builds of one commit match, `compare` cannot judge
   byakugan, so say so in the handoff.

9. **Tell other agents.** Paste the section at the end of adopting.md into
   the repository's `AGENTS.md` or `CLAUDE.md`.

10. **Hand off.** Tell the user:
    - which apps byakugan sees, and which findings stay open and why
    - which jobs it gates in shadow mode, and the minutes they cost today
    - whether builds are reproducible (step 8)
    - the next step: two weeks of pull requests in shadow mode, then the
      `byakugan-shadow-audit` skill (in the same `skills/` folder) to grade
      them before anything is skipped

## Done

`doctor --workspace` exits with 0, every app gave the right answer to three
edits, a shadow job records verdicts without skipping anything, the
repository's `AGENTS.md` has the byakugan section, and the user has the
handoff from step 10.
