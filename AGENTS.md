# byakugan

Builds the graph of code an app uses (files, exports, single declarations,
npm package files) and turns it into a fingerprint and an "affected" check.
README.md is the overview. docs/how-it-works.md explains the model and
docs/limits.md its limits; read both first.

## Layout

- `src/parse.ts`: oxc AST to a `ModuleInfo`. ESM modules become fragments
  (declarations, import bindings, export specifiers, `export *`, side effects
  including bare imports, `<types>` for `declare global` and `declare module`)
  with the names each declaration refers to, plus computed `import()` patterns
  (`contexts`) and file paths in code (`paths`). CommonJS, assets, MDX and files
  with parse errors are `opaque` and hashed whole. Fragment text comes from
  `canonicalText`, a serialization of the fragment's syntax tree without
  positions, `raw` spellings and parentheses, so formatting never counts.
  Comments that `isSignificant` keeps sit before the node after them.
  Significant comments outside every fragment join `<module>`. Files in
  `node_modules` keep their raw text.
  `eagerOf` reads what top-level code does outside function bodies. An
  initializer with a call that `isPure` does not clear joins `<module>` as
  `x runs on definition`. A local function passed to a built-in that calls it
  (`[1].map(f)`) is read through `mayCall`. Each eager reference to a `const`, `let` or class
  adds an `order:` note to the fragment text, so moving a declaration past
  its reader counts.
- `src/graph.ts`: the walk. Node ids are `M` (module runs), `S` (export used),
  `D` (local binding used), `I` (input), and `T` and `Y`, an export or binding
  reached only through types (`import type`, `typeof x` in a type). `T` and `Y`
  never run a module and count packages as `npm:<pkg>#<types>`. `parents`
  records the first node that reached each id, which `why` and `affected`
  print. `reachedFrom` and `fragmentVias` record every node, for `--each`. Two fragments exist only in the graph, not in `moduleFragments`:
  `<imports>` (the ordered effectful imports of a project module) and `<raw>`
  (the whole text of a JS file imported with `?raw` or `?url`). Git mode
  checks them separately. In `strict` mode, in a Next.js app, `useClientReferences`
  marks every export of a `'use client'` module that a server module imports,
  because Next.js ships such a module whole.
- Modes: `behavior` (default) counts code the app can run, `strict` also counts
  code the bundler ships that nothing runs. A rule that exists only to match
  build output byte for byte belongs behind `project.config.mode === 'strict'`.
- `src/resolve.ts`: oxc-resolver with browser, node and (Next.js) `react-server`
  condition sets, `modularizeImports`, `sideEffects`, and a `style` condition
  set for package stylesheets. React Native adds a `react-native` set and
  returns every platform variant (`Button.ios.tsx`) of a resolved file, in any
  code extension. `variantStems` go into `graph.patterns.shadowed`, so git
  mode counts a deleted variant.
- `.vue`, `.svelte` and `.astro` files load through `componentParts` and
  `componentModule` in parse.ts: opaque, hashed whole, with their scripts'
  imports listed by imported name in `imports`. A script that does not parse
  still lists the imports `SCRIPT_IMPORT` finds in its text.
- A string such as `'~/assets/main.css'` is an `alias` path: graph.ts resolves
  it like an import, or records the alias targets in `patterns.missing`.
- `src/tailwind.ts`, `src/tailwind-worker.ts`: runs the project's Tailwind in a
  child process and hashes the CSS it generates (`<root>.css#<tailwind>`).
- `src/project.ts`: framework detection, entries, inputs, tracked packages.
  `FRAMEWORK_GENERATED` and `FRAMEWORK_VIRTUAL` merge into `generated` and
  `virtual`, and `aliases` holds `$lib` and Nuxt's `~`.
- `src/workspace.ts`: the apps of a workspace for `--workspace`. The CLI gives
  every app's graph one `ModuleCache` (graph.ts), keyed by parse options and
  path, so a shared file is parsed once. Graphs must not change a `ModuleInfo`.
- `src/select.ts`: `--each`, the files that a change reaches, found by walking
  `reachedFrom` back from each reason to the roots. Against a manifest it
  compares `eachFingerprints` instead, one hash per matched file over the
  fragments that file reaches, since a fragment that left the graph gives the
  walk nowhere to start.
- `src/compare.ts`: `byakugan compare`, two build outputs without per-build
  noise.
- `src/affected.ts`: git mode (fragments of base vs working tree, lockfile diff,
  deleted files matched against `graph.patterns`, Tailwind rerun with base
  contents) and manifest mode.
- `src/report.ts`: text, JSON, Mermaid, DOT and `why` output. The CLI prints
  chains in JSON through `describeNode`, never as raw node ids.
- `src/cli.ts`: argument parsing and the commands. A usage mistake throws
  `UsageError` with a `hint`, and the last lines of the file print every error
  as `byakugan: error: …` plus `hint:` and `help:`, or as JSON with `--json`.
- `src/help.ts`: `OPTIONS` and `COMMANDS`, the one source for `--help`, for
  the check that an option belongs to its command, and for "did you mean".
- `src/doctor.ts`: `byakugan doctor`. `RULES` sorts graph warnings into
  findings by matching their text, each with a severity, a cost and a fix.
- `src/ui.ts`: colors (`NO_COLOR`, `FORCE_COLOR`, TTY), `closest` and `wrap`.
  Formatters in report.ts build lines from parts, and `lines()` escapes each
  part before it paints it.
- `docs/`: user documentation. `docs/adopting.md` ships in the npm package,
  and `byakugan guide` prints it. `docs/examples/` lists cases of a change
  and its result, each row linked to the test that asserts it.
- `site/`: the website, static files on Vercel with no build step.
  `site/examples.html` is generated from `docs/examples/*.md` by
  `scripts/site-examples.ts` (`npm run site`). Do not edit it by hand.
- `src/fs.ts`: `readRegular` and `readText`, which read regular files only.
  `src/glob.ts`: `globMatcher` and `safeGlob`, linear-time matching and a
  crawler that stays inside the git root. A link into a directory the crawl
  already lists comes back as the link itself, which `markInput` hashes by its
  target.

## Rules

- A fragment id from `moduleFragments` must match the id the graph marks live.
  Git mode compares them; a mismatch silently reports "unaffected". For a
  fragment that changed but is not live, git mode asks
  `graph.wants(file, id, baseModule)`, so a new kind of fragment id needs a
  case there too.
- In `analyze`, build fragment text with `slice` or `span`, never
  `source.slice`, which would make comment and formatting edits count again. A new
  significant comment needs a "counts" row in the fragment text tests of
  `test/parse.test.ts`.
- When unsure, over-approximate: more live fragments cost a rebuild, fewer
  ship a stale app.
- Keys must not contain absolute paths or package versions. Fingerprints have
  to match across machines and pnpm store layouts.
- A file that leaves the graph when it is deleted needs a record that git mode
  can match it against: `project.entryPatterns` and `project.namedFiles` for
  entries, `graph.patterns` for pattern matches and paths in code. Without one,
  git mode reports the deletion as unaffected.
- Every file, glob and pattern comes from a pull request. Read files through
  `readText`/`readRegular`, match repository globs with `globMatcher` or
  `safeGlob` (not picomatch or tinyglobby directly), and keep reads inside
  `project.repo` (`inside()` in graph.ts). Text output goes through `safe()`.
  oxc-resolver reads `package.json` files itself, so resolve through
  `Resolver.resolve` or `resolveStyle`, which stat them first.
- Output keeps the same words with and without color. Paint through `Style`
  after `safe()`, never before, and never build an escape sequence from
  repository text. Marks such as `✔` appear only when `style.on`.
- A new warning in graph.ts needs a rule in `RULES` (doctor.ts) and a row in
  the table of docs/adopting.md, step 3. A new option needs an entry in
  `OPTIONS` and in the `options` of each command that takes it.
- The Tailwind worker builds both sides of a comparison the same way
  (`scanFiles` on contents, fresh compiler). `compiler.build` accumulates
  candidates, so never reuse a compiler across builds.

## Commands

```sh
npm test                       # node --test, TypeScript sources run directly
node --test test/graph.test.ts # one file
npm run typecheck
npm run build                  # dist/ for the published bin
node src/cli.ts graph -C test/fixtures/basic
```

Releases go through a `v*` tag; README.md, Releasing, has the steps.

Tests copy a fixture to a temp dir (`fixture()` in `test/helpers.ts`), or build
one from a file map (`app(files, { repo: true })`, `pkg()`), edit it,
and compare fingerprints or `affected` results. `test/tailwind.test.ts` links
the real `tailwindcss` (v4) and `tailwindcss3` devDependencies into its
fixtures. Every precision claim has a
paired test that fails if the tool gets too coarse and one that fails if it
gets too lax. Keep both when adding a case, and add the pair as rows to
the matching page in `docs/examples/`, then run `npm run site`.

`test/differential.test.ts` applies seeded random edits and fails when the
fingerprint moves while git mode says unaffected. Run more seeds with
`BYAKUGAN_SEEDS=1-2000 node --test test/differential.test.ts` after a change to
git mode, and add a new import form to its `FILES` when the graph learns one.
