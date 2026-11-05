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
  with parse errors are `opaque` and hashed whole.
- `src/graph.ts`: the walk. Node ids are `M` (module runs), `S` (export used),
  `D` (local binding used), `I` (input), and `T` and `Y`, an export or binding
  reached only through types (`import type`, `typeof x` in a type). `T` and `Y`
  never run a module and count packages as `npm:<pkg>#<types>`. `parents`
  records the first node that reached each id, which `why` and `affected`
  print.
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

## Rules

- A fragment id from `moduleFragments` must match the id the graph marks live.
  Git mode compares them; a mismatch silently reports "unaffected". For a
  fragment only the base side has, git mode asks `graph.wants(file, id)`, so a
  new kind of fragment id needs a case there too.
- When unsure, over-approximate: more live fragments cost a rebuild, fewer
  ship a stale app.
- Keys must not contain absolute paths or package versions. Fingerprints have
  to match across machines and pnpm store layouts.
- A file that leaves the graph when it is deleted needs a record that git mode
  can match it against: `project.entryPatterns` and `project.namedFiles` for
  entries, `graph.patterns` for pattern matches and paths in code. Without one,
  git mode reports the deletion as unaffected.
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

Tests copy a fixture to a temp dir (`fixture()` in `test/helpers.ts`), edit it,
and compare fingerprints or `affected` results. `test/tailwind.test.ts` links
the real `tailwindcss` (v4) and `tailwindcss3` devDependencies into its
fixtures. Every precision claim has a
paired test that fails if the tool gets too coarse and one that fails if it
gets too lax. Keep both when adding a case.
