# byakugan

Builds the graph of code an app uses (files, exports, single declarations,
npm package files) and turns it into a fingerprint and an "affected" check.
README.md explains the model and its limits; read it first.

## Layout

- `src/parse.ts`: oxc AST to a `ModuleInfo`. ESM modules become fragments
  (declarations, import bindings, export specifiers, `export *`, side effects
  including bare imports, `<types>` for `declare global` and `declare module`)
  with the names each declaration refers to, plus computed `import()` patterns
  (`contexts`) and file paths in code (`paths`). CommonJS, assets, MDX and files
  with parse errors are `opaque` and hashed whole. Fragment text comes from
  `sourceText`: comments that `isSignificant` does not keep are dropped and
  whitespace outside literals collapses. Significant comments outside every
  fragment join `<module>`. Files in `node_modules` keep their raw text.
- `src/graph.ts`: the walk. Node ids are `M` (module runs), `S` (export used),
  `D` (local binding used), `I` (input), and `T` and `Y`, an export or binding
  reached only through types (`import type`, `typeof x` in a type). `T` and `Y`
  never run a module and count packages as `npm:<pkg>#<types>`. `parents`
  records the first node that reached each id, which `why` and `affected`
  print. Two fragments exist only in the graph, not in `moduleFragments`:
  `<imports>` (the ordered effectful imports of a project module) and `<raw>`
  (the whole text of a JS file imported with `?raw` or `?url`). Git mode
  checks them separately.
- `src/resolve.ts`: oxc-resolver with browser, node and (Next.js) `react-server`
  condition sets, `modularizeImports`, `sideEffects`, and a `style` condition
  set for package stylesheets.
- `src/tailwind.ts`, `src/tailwind-worker.ts`: runs the project's Tailwind in a
  child process and hashes the CSS it generates (`<root>.css#<tailwind>`).
- `src/project.ts`: framework detection, entries, inputs, tracked packages.
- `src/affected.ts`: git mode (fragments of base vs working tree, lockfile diff,
  deleted files matched against `graph.patterns`, Tailwind rerun with base
  contents) and manifest mode.
- `src/report.ts`: text, JSON, Mermaid, DOT and `why` output.
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
- In `analyze`, cut fragment text with `slice` or `span`, never
  `source.slice`, which would make comment edits count again. A new
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

Tests copy a fixture to a temp dir (`fixture()` in `test/helpers.ts`), or build
one from a file map (`app(files, { repo: true })`, `pkg()`), edit it,
and compare fingerprints or `affected` results. `test/tailwind.test.ts` links
the real `tailwindcss` (v4) and `tailwindcss3` devDependencies into its
fixtures. Every precision claim has a
paired test that fails if the tool gets too coarse and one that fails if it
gets too lax. Keep both when adding a case.
