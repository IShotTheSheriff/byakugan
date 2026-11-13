# npm packages, lockfiles and resolution

This page covers code that lives outside the project's own files, and how byakugan resolves an import to a file. It includes npm packages, lockfiles, patches, workspace packages, tsconfig paths and imports that do not resolve.

[All examples](README.md)

## A named lodash import

`lodash` is CommonJS, so byakugan hashes each of its files whole. It rewrites `import { partition } from 'lodash'` to `lodash/partition`, as Next.js does by default with `modularizeImports`. Only `partition.js` and the helpers it requires join the graph, and the 540 KB `lodash.js` that `main` names stays out.

```json
// package.json
{ "dependencies": { "lodash": "4.17.21", "es-utils": "1.0.0", "react": "19.0.0" } }
```

```ts
// src/main.tsx
import { partition } from 'lodash';
import { pick } from 'es-utils';
```

| Change | Result | Test |
| --- | --- | --- |
| (setup) | `npm:lodash/partition.js`, `_createAggregator.js` and `_arrayAggregator.js` live. `filter.js`, `_arrayFilter.js` and `lodash.js` are not | [graph.test.ts:10](../../test/graph.test.ts#L10) |
| Edit `node_modules/lodash/filter.js`, a method the app does not import | unaffected | [graph.test.ts:65](../../test/graph.test.ts#L65) |
| Edit `node_modules/lodash/_arrayAggregator.js`, a helper behind `partition` | affected | [graph.test.ts:66](../../test/graph.test.ts#L66) |
| Edit the monolithic `node_modules/lodash/lodash.js` | unaffected | [graph.test.ts:67](../../test/graph.test.ts#L67) |

A default import, `import _ from 'lodash'`, uses the whole file. See [limits](../limits.md).

## An ESM package with `sideEffects: false`

In an ES module package byakugan goes down to single declarations. The package's `sideEffects: false` lets it skip the files of a barrel that the app does not take a name from.

```json
// node_modules/es-utils/package.json
{ "type": "module", "sideEffects": false, "exports": { ".": { "import": "./index.js" } } }
```

```js
// node_modules/es-utils/index.js
export { pick } from './pick.js';
export { omit } from './omit.js';
export * from './keys.js';
// node_modules/es-utils/internal.js
export const hasKey = ...;    // pick and omit use it
export const isObject = ...;  // nothing uses it
```

| Change | Result | Test |
| --- | --- | --- |
| (setup) | `npm:es-utils/pick.js#pick` and `internal.js#hasKey` live. `#isObject`, `omit.js` and `keys.js` are not | [graph.test.ts:19](../../test/graph.test.ts#L19) |
| Edit `omit.js`, an export the app does not import | unaffected | [graph.test.ts:76](../../test/graph.test.ts#L76) |
| Edit `isObject` in `internal.js`, an unused helper in a used file | unaffected | [graph.test.ts:77](../../test/graph.test.ts#L77) |
| Edit `hasKey` in `internal.js`, which `pick` uses | affected | [graph.test.ts:78](../../test/graph.test.ts#L78) |

## Files inside npm packages

The fingerprint and manifest mode look at the files in `node_modules` that the app reaches. Git mode does not see `node_modules`, so it reads package changes from the lockfile, one package at a time. The next section covers that.

These rows save a manifest, edit `node_modules`, and compare against the manifest. The setup is the lodash app above or the monorepo fixture, whose app also imports `partition`.

| Change | Result | Test |
| --- | --- | --- |
| Append a comment to `node_modules/lodash/filter.js` | unaffected | [cli.test.ts:64](../../test/cli.test.ts#L64) |
| Edit `node_modules/lodash/filter.js` and bump lodash to 4.17.22 in the lockfile | unaffected | [affected.test.ts:162](../../test/affected.test.ts#L162) |
| Edit `node_modules/lodash/_createAggregator.js`, which `partition` requires | affected, reason key `npm:lodash/_createAggregator.js` | [affected.test.ts:170](../../test/affected.test.ts#L170) |
| Bump `node_modules/next/package.json` from 15.0.0 to 15.0.1 | affected, reason key `npm:next#<version>` | [affected.test.ts:179](../../test/affected.test.ts#L179) |

The lockfile bump in the second row is affected in git mode, as the next section shows. Manifest mode ignores it because the files `partition` reaches did not change. A framework package such as `next` is the exception, since its version counts.

## Lockfiles

In git mode byakugan diffs the lockfile and lists the packages whose entry changed. A changed package counts when the app uses it. A new version, integrity, patch hash or git commit each counts as a change, even at the same version. Git mode works per package, so any change to lodash's entry counts once the app uses lodash at all. See [limits](../limits.md).

### Formats byakugan reads

These tests run the lockfile parser and diff directly and check which package names changed.

| Lockfile | Change | Changed packages | Test |
| --- | --- | --- | --- |
| `package-lock.json` | Same version, new integrity | `lodash` | [resolution.test.ts:493](../../test/resolution.test.ts#L493) |
| `package-lock.json` | Same version, new git commit in `resolved` | `lodash` | [resolution.test.ts:493](../../test/resolution.test.ts#L493) |
| `package-lock.json` | Identical entry | none | [resolution.test.ts:493](../../test/resolution.test.ts#L493) |
| `pnpm-lock.yaml` v5 | Bump `lodash` 4.17.20 to 4.17.21 | `lodash` only, not `@types/node` | [resolution.test.ts:464](../../test/resolution.test.ts#L464) |
| `pnpm-lock.yaml` v5 | No change | none | [resolution.test.ts:464](../../test/resolution.test.ts#L464) |
| `pnpm-lock.yaml` v5 and v6 | Git dependency `github:kevva/is-positive` moves to a new commit | `is-positive`, the name from its `name:` field | [resolution.test.ts:1061](../../test/resolution.test.ts#L1061) |
| `pnpm-lock.yaml` v9 | New `patch_hash` for `lodash` at the same version | `lodash` | [resolution.test.ts:473](../../test/resolution.test.ts#L473) |
| `pnpm-lock.yaml` v9 | New integrity for `lodash` at the same version | `lodash` | [resolution.test.ts:473](../../test/resolution.test.ts#L473) |
| `pnpm-lock.yaml` v9 | Git dependency `foo` moves to a new commit | `foo` | [resolution.test.ts:487](../../test/resolution.test.ts#L487) |
| `pnpm-lock.yaml`, pnpm 10 | New hash in `patchedDependencies` keyed by bare name | `lodash` | [resolution.test.ts:481](../../test/resolution.test.ts#L481) |
| `yarn.lock` v1 | New `resolved` commit for `foo@github:acme/foo` | `foo` | [resolution.test.ts:501](../../test/resolution.test.ts#L501) |
| `yarn.lock` v1 | Bump `my-lodash@npm:lodash@^4` | `lodash`, the alias counts as its target | [resolution.test.ts:501](../../test/resolution.test.ts#L501) |
| `yarn.lock` berry | New patch hash for `lodash` | `lodash` | [resolution.test.ts:509](../../test/resolution.test.ts#L509) |
| `yarn.lock` berry | New git commit for `foo` | `foo` | [resolution.test.ts:509](../../test/resolution.test.ts#L509) |
| `yarn.lock` berry | Change `my-pad@npm:left-pad@^1` | `left-pad` | [resolution.test.ts:509](../../test/resolution.test.ts#L509) |
| `bun.lock` | Bump the aliased `my-lodash` | `lodash` | [resolution.test.ts:518](../../test/resolution.test.ts#L518) |
| `bun.lock` | New git commit for `foo` | `foo` | [resolution.test.ts:518](../../test/resolution.test.ts#L518) |
| `bun.lock` | Same version, new integrity | `lodash` | [resolution.test.ts:1211](../../test/resolution.test.ts#L1211) |
| `bun.lock` | Identical | none | [resolution.test.ts:518](../../test/resolution.test.ts#L518), [resolution.test.ts:1211](../../test/resolution.test.ts#L1211) |
| `pnpm-lock.yaml` with a package key it does not recognize, a lockfile with broken JSON, or a binary `bun.lockb` | Any | unparseable | [resolution.test.ts:527](../../test/resolution.test.ts#L527) |

### A used package and an unused one

Each app imports lodash and has a second package installed and locked that nothing imports.

```ts
// src/main.ts
import partition from 'lodash/partition';
// left-pad is in dependencies and node_modules, and no file imports it
```

| Lockfile | Change | Used package | Unused package | Test |
| --- | --- | --- | --- | --- |
| `package-lock.json` | Git dependency moves to another commit | affected, reason `dependency:lodash` | unaffected, `ignored` lists the lockfile | [git-mode.test.ts:911](../../test/git-mode.test.ts#L911) |
| `package-lock.json` | Same version, new integrity | affected, `dependency:lodash`, detail says "same version" | unaffected, `ignored` lists the lockfile | [resolution.test.ts:556](../../test/resolution.test.ts#L556) |
| `package-lock.json` | Version bump, `lodash` 4.17.21 to 4.17.22, `left-pad` 1.3.0 to 1.3.1 | affected, `dependency:lodash` | unaffected | [affected.test.ts:136](../../test/affected.test.ts#L136), [affected.test.ts:130](../../test/affected.test.ts#L130) |
| `pnpm-lock.yaml` v5 | Version bump | affected, `dependency:lodash` | unaffected | [git-mode.test.ts:915](../../test/git-mode.test.ts#L915), [resolution.test.ts:568](../../test/resolution.test.ts#L568) |
| `pnpm-lock.yaml` v6 | Git dependency moves to a new commit, `is-positive` used, `is-negative` unused | affected, `dependency:is-positive` | unaffected | [resolution.test.ts:1067](../../test/resolution.test.ts#L1067) |
| `pnpm-lock.yaml` v9 | New `patch_hash` | affected, `dependency:lodash` | unaffected, `ignored` lists the lockfile | [git-mode.test.ts:912](../../test/git-mode.test.ts#L912), [resolution.test.ts:579](../../test/resolution.test.ts#L579) |
| `pnpm-lock.yaml` v9 | Tarball URL from another commit | affected, `dependency:lodash` | unaffected, `ignored` lists the lockfile | [git-mode.test.ts:913](../../test/git-mode.test.ts#L913) |
| `yarn.lock` berry | New patch hash | affected, `dependency:lodash` | unaffected, `ignored` lists the lockfile | [git-mode.test.ts:914](../../test/git-mode.test.ts#L914) |
| `bun.lock` | Bump `left-pad` 1.3.0 to 1.3.1 as the used package, `is-odd` as the unused one | affected, reason key `left-pad` | unaffected | [security.test.ts:358](../../test/security.test.ts#L358), [security.test.ts:366](../../test/security.test.ts#L366) |

### A lockfile byakugan cannot read

A lockfile byakugan cannot read or parse counts as changed. It does not get ignored.

| Change | Result | Test |
| --- | --- | --- |
| Truncate `package-lock.json` so it no longer parses | affected, reason `dependency:package-lock.json`, detail "could not be parsed" | [resolution.test.ts:587](../../test/resolution.test.ts#L587) |
| Change a `pnpm-lock.yaml` with `lockfileVersion: 99` | affected, detail `lockfile changed and could not be parsed` | [git-mode.test.ts:934](../../test/git-mode.test.ts#L934) |
| Replace `bun.lock` with `{`, 300,000 blank lines and `}` | affected, and the run finishes | [security.test.ts:350](../../test/security.test.ts#L350) |
| Add `docs/yarn.lock` as a link to a FIFO | affected, reason key `docs/yarn.lock`, and the run does not block | [security.test.ts:444](../../test/security.test.ts#L444) |

The last row also shows that byakugan treats a `yarn.lock` in a subdirectory as a lockfile.

### Dependency ranges in package.json

With a lockfile, byakugan leaves the dependency ranges in `package.json` out, because the lockfile decides what installs. Without one, a range edit can install another version, so it counts.

| Change | Result | Test |
| --- | --- | --- |
| Change `"lodash": "4.17.21"` to `"^4.17.21"` with a `package-lock.json` present | unaffected | [graph.test.ts:96](../../test/graph.test.ts#L96) |
| Same edit, no lockfile | affected | [graph.test.ts:104](../../test/graph.test.ts#L104) |
| Git mode, lockfile present, change `^4.17.0` to `^4.17.21` | unaffected | [resolution.test.ts:632](../../test/resolution.test.ts#L632) |
| Git mode, no lockfile, same edit | affected, reason `input:package.json` | [resolution.test.ts:626](../../test/resolution.test.ts#L626) |

### Patches

byakugan matches a patch file to its package by the file name. A patch counts when the app uses the patched package.

| Tool | Change | Result | Test |
| --- | --- | --- | --- |
| patch-package | Edit `patches/lodash+4.17.21.patch` | affected, reason `dependency:lodash` | [git-mode.test.ts:942](../../test/git-mode.test.ts#L942) |
| patch-package | Edit `patches/left-pad+1.3.0.patch` | unaffected | [git-mode.test.ts:942](../../test/git-mode.test.ts#L942) |
| patch-package | Edit `patches/lodash+4.17.20.patch` and `patches/@acme+fmt+1.0.0.patch` | affected, reasons `dependency:@acme/fmt` and `dependency:lodash` | [resolution.test.ts:595](../../test/resolution.test.ts#L595) |
| pnpm | Edit `patches/lodash@4.17.21.patch` | affected, reason `dependency:lodash` | [git-mode.test.ts:943](../../test/git-mode.test.ts#L943) |
| pnpm | Edit `patches/left-pad@1.3.0.patch` | unaffected | [git-mode.test.ts:943](../../test/git-mode.test.ts#L943) |
| pnpm | Edit `patches/lodash@4.17.20.patch` and `patches/@acme__fmt@1.0.0.patch` | affected, reasons `dependency:@acme/fmt` and `dependency:lodash` | [resolution.test.ts:610](../../test/resolution.test.ts#L610) |
| pnpm | Edit `patches/left-pad@1.0.0.patch` and `patches/@acme__other@1.0.0.patch` | unaffected | [resolution.test.ts:610](../../test/resolution.test.ts#L610) |

### Packages a build tool reads

Some packages count without an import because a build tool reads them. autoprefixer reads `caniuse-lite` and `browserslist`, so a `caniuse-lite` bump changes the CSS it emits. byakugan tracks these by their lockfile version.

| Setup | Change | Result | Test |
| --- | --- | --- | --- |
| `autoprefixer` in devDependencies | (setup) | `caniuse-lite` and `browserslist` tracked | [styles.test.ts:593](../../test/styles.test.ts#L593) |
| Only `postcss` in devDependencies | (setup) | `caniuse-lite` not tracked | [styles.test.ts:593](../../test/styles.test.ts#L593) |
| `autoprefixer` in devDependencies | Bump `caniuse-lite` in the lockfile | affected, reason `caniuse-lite` | [styles.test.ts:603](../../test/styles.test.ts#L603), [resolution.test.ts:778](../../test/resolution.test.ts#L778) |
| No `autoprefixer` | Same bump | unaffected | [styles.test.ts:603](../../test/styles.test.ts#L603), [resolution.test.ts:778](../../test/resolution.test.ts#L778) |
| `postcss.config.js` has `plugins: { '@tailwindcss/postcss': {}, cssnano: {} }`, `postcss-nested` is also in devDependencies | (setup) | `cssnano` tracked, `postcss-nested` not | [styles.test.ts:625](../../test/styles.test.ts#L625) |
| Tailwind v3 project with no framework, lockfile has `tailwindcss` 3.3.0 and `left-pad` 1.0.0 | Bump `left-pad` to 1.0.1 | unaffected | [styles.test.ts:556](../../test/styles.test.ts#L556) |
| Same | Bump `tailwindcss` to 3.4.17 | affected, reason `tailwindcss` | [styles.test.ts:556](../../test/styles.test.ts#L556) |

## Workspace packages

byakugan follows a workspace package into its source and counts the declarations the app reaches, the same way it does for project files. The monorepo fixture has a Next.js app in `apps/web` and links `@acme/ui` into `node_modules`.

```ts
// packages/ui/src/index.ts
export * from './Button';
export * from './Modal';
export { Card } from './Card';
// packages/ui/src/Button.tsx
import { cx } from './cx';
export function Button({ children }) { return <button className={cx('btn')}>{children}</button>; }
// apps/web/app/page.tsx
import { partition } from 'lodash';
import { Button } from '@acme/ui';
```

| Change | Result | Test |
| --- | --- | --- |
| Edit `Modal.tsx`, which the barrel re-exports and the app never imports | unaffected, `ignored` lists `packages/ui/src/Modal.tsx` | [affected.test.ts:52](../../test/affected.test.ts#L52) |
| Edit `Button.tsx`, `cx('btn')` to `cx('btn', 'primary')` | affected, reason `packages/ui/src/Button.tsx#Button`. The chain starts at `apps/web/app/page.tsx (entry)` and passes `packages/ui/src/index.ts › Button` | [affected.test.ts:60](../../test/affected.test.ts#L60) |
| Edit `cx.ts`, a helper only `Button` uses | affected | [affected.test.ts:74](../../test/affected.test.ts#L74) |
| Add `Tabs.tsx` and `export { Tabs } from './Tabs'` to the barrel | unaffected | [affected.test.ts:80](../../test/affected.test.ts#L80) |
| Edit the root `README.md` and a file in the sibling app `apps/docs` | unaffected | [affected.test.ts:153](../../test/affected.test.ts#L153) |
| Same `Button.tsx` edit, with `@acme/ui` installed as a copy in `node_modules` instead of a link | affected, reason `source:npm:@acme/ui/src/Button.tsx#Button` | [git-mode.test.ts:714](../../test/git-mode.test.ts#L714) |
| Same `Modal.tsx` edit, installed as a copy | unaffected, `ignored` lists `packages/ui/src/Modal.tsx` | [git-mode.test.ts:720](../../test/git-mode.test.ts#L720) |

When the package is a copy, git sees the change under `packages/ui`, and byakugan maps it onto the `npm:@acme/ui/...` copy the app resolves.

### package.json and tsconfig of a workspace package

The `package.json` and `tsconfig.json` of a workspace package the app reaches are inputs. Those of a package the app never imports are not. A workspace package's own tsconfig `paths` apply to its own files.

```json
// packages/ui/package.json
{ "name": "@acme/ui", "exports": { ".": "./src/a.ts" } }
// packages/ui/tsconfig.json
{ "compilerOptions": { "paths": { "~/*": ["./src/v1/*"] } } }
```

```ts
// packages/ui/src/a.ts
import { cx } from '~/cx';   // resolves to packages/ui/src/v1/cx.ts
```

| Change | Result | Test |
| --- | --- | --- |
| Point `exports` in `packages/ui/package.json` at `./src/b.ts` | affected, reason `input:packages/ui/package.json` | [resolution.test.ts:428](../../test/resolution.test.ts#L428) |
| Edit `main` in `packages/docs/package.json`, a package nothing imports | unaffected | [resolution.test.ts:434](../../test/resolution.test.ts#L434) |
| Change `paths` in `packages/ui/tsconfig.json` from `v1` to `v2` | affected, reason `input:packages/ui/tsconfig.json` | [resolution.test.ts:441](../../test/resolution.test.ts#L441) |
| Edit `packages/docs/tsconfig.json` | unaffected | [resolution.test.ts:448](../../test/resolution.test.ts#L448) |

In the monorepo fixture, `packages/ui/src/alt.ts` holds `export * from './Button'`, and `packages/unused` is a workspace package the app never imports.

| Change | Result | Test |
| --- | --- | --- |
| Point `@acme/ui`'s `exports["."]` at `./src/alt.ts` | affected, reason `input:packages/ui/package.json` | [git-mode.test.ts:1024](../../test/git-mode.test.ts#L1024) |
| Add `"sideEffects": false` to `@acme/ui` | affected, reason `input:packages/ui/package.json` | [git-mode.test.ts:1030](../../test/git-mode.test.ts#L1030) |
| Add an exports key `"./alt"` that no import names | unaffected, fingerprint unchanged | [git-mode.test.ts:1036](../../test/git-mode.test.ts#L1036) |
| Add an exports key `"./*": "./src/*.ts"` | affected, reason `input:packages/ui/package.json` | [git-mode.test.ts:1044](../../test/git-mode.test.ts#L1044) |
| Add a `scripts.lint` entry to `@acme/ui`'s package.json | unaffected | [git-mode.test.ts:1050](../../test/git-mode.test.ts#L1050) |
| Add a `scripts.prebuild` entry to the app's own package.json | affected, reason `input:apps/web/package.json` | [git-mode.test.ts:1056](../../test/git-mode.test.ts#L1056) |
| Change `exports` in `packages/unused/package.json` | unaffected | [git-mode.test.ts:1062](../../test/git-mode.test.ts#L1062) |

A new exports key with a star counts because `./*` could match any import the app makes. A script in the app's own package.json can run before the build. One in a dependency's package.json does not.

### A `browser` map in a workspace package

In a Next.js app the server loads the node file and the browser loads the mapped one, so both count.

```json
// packages/env/package.json
{ "main": "./src/index.ts", "browser": { "./src/impl-node.ts": "./src/impl-browser.ts" } }
```

| Change | Result | Test |
| --- | --- | --- |
| (setup) | `impl-node.ts#env` and `impl-browser.ts#env` both live | [resolution.test.ts:893](../../test/resolution.test.ts#L893) |
| Edit `packages/env/src/impl-node.ts` | affected, reason `source:packages/env/src/impl-node.ts#env` | [resolution.test.ts:893](../../test/resolution.test.ts#L893) |
| Edit `packages/env/src/unused.ts` | unaffected | [resolution.test.ts:902](../../test/resolution.test.ts#L902) |

## tsconfig and jsconfig paths

byakugan reads `paths` from `tsconfig.json`, or from `jsconfig.json` when there is no tsconfig, and resolves aliases through them. The config file is an input.

```json
// jsconfig.json, from create-next-app --js
{ "compilerOptions": { "paths": { "@/*": ["./src/*"] } } }
```

```js
// src/app/page.js
import { Button } from '@/components/Button';
```

| Change | Result | Test |
| --- | --- | --- |
| Edit `src/components/Button.js` | affected, reason `source:src/components/Button.js#Button`, no warnings | [resolution.test.ts:189](../../test/resolution.test.ts#L189) |
| Edit `src/components/Unused.js` next to it | unaffected | [resolution.test.ts:196](../../test/resolution.test.ts#L196) |
| Edit `jsconfig.json` to add `checkJs` | affected | [resolution.test.ts:203](../../test/resolution.test.ts#L203) |
| Edit `components.json`, the shadcn config | unaffected | [resolution.test.ts:203](../../test/resolution.test.ts#L203) |
| Change `jsx` in `tsconfig.json` from `react-jsx` to `preserve` | affected | [graph.test.ts:83](../../test/graph.test.ts#L83) |

### Two targets for one alias

The first target that has the file wins. Deleting it moves the import to the second target, so it counts.

```json
// tsconfig.json
{ "compilerOptions": { "paths": { "@/*": ["./src/*", "./fallback/*"] } } }
```

```ts
// src/main.ts
import { v } from '@/lib/v';   // src/lib/v.ts and fallback/lib/v.ts both exist
```

| Change | Result | Test |
| --- | --- | --- |
| Delete `src/lib/v.ts`, so the import falls back to `fallback/lib/v.ts` | affected | [resolution.test.ts:1191](../../test/resolution.test.ts#L1191) |
| Delete `fallback/lib/v.ts` while the first target still answers | unaffected | [resolution.test.ts:1199](../../test/resolution.test.ts#L1199) |

### tsconfig `extends`

Every config in the app's `extends` chain is an input. Other configs in the same package are not.

```json
// apps/web/tsconfig.json
{ "extends": "@acme/tsconfig/nextjs.json" }
// packages/tsconfig/nextjs.json
{ "extends": "./base.json", "compilerOptions": { "jsx": "preserve" } }
// packages/tsconfig/react-library.json: nothing extends it
```

| Change | Result | Test |
| --- | --- | --- |
| Edit `packages/tsconfig/nextjs.json` and `base.json` | affected, reasons `input:packages/tsconfig/base.json` and `input:packages/tsconfig/nextjs.json` | [resolution.test.ts:233](../../test/resolution.test.ts#L233) |
| Edit `packages/tsconfig/react-library.json` | unaffected | [resolution.test.ts:240](../../test/resolution.test.ts#L240) |
| Delete `packages/tsconfig/nextjs.json` | affected | [resolution.test.ts:248](../../test/resolution.test.ts#L248) |
| Delete `packages/tsconfig/react-library.json` | unaffected | [resolution.test.ts:254](../../test/resolution.test.ts#L254) |
| `apps/web/tsconfig.json` extends `../../tsconfig.base` without `.json`, delete `tsconfig.base.json` | affected | [resolution.test.ts:1127](../../test/resolution.test.ts#L1127) |
| Extends `../../tsconfig.base.json`, delete it | affected | [resolution.test.ts:1133](../../test/resolution.test.ts#L1133) |
| Delete a root `tsconfig.other.json` that nothing extends | unaffected | [resolution.test.ts:1139](../../test/resolution.test.ts#L1139) |
| Git mode, monorepo fixture, edit `packages/tsconfig/nextjs.json` | affected, reason `input:packages/tsconfig/nextjs.json` | [git-mode.test.ts:974](../../test/git-mode.test.ts#L974) |
| Git mode, the app's chain does not include `packages/tsconfig/base.json`, edit it | unaffected | [git-mode.test.ts:980](../../test/git-mode.test.ts#L980) |

Compiler options from the chain change how byakugan reads code.

```ts
// src/index.ts
import { type T } from './side';   // runs side.ts only under verbatimModuleSyntax
// src/side.ts
console.log('side effect');
export type T = number;
```

| Setup | Result | Test |
| --- | --- | --- |
| `tsconfig.json` extends `tsconfig.base.json`, which sets `jsxImportSource: 'preact'` | JSX in `src/main.tsx` uses `npm:preact/jsx-runtime.mjs#jsx`, nothing from `react` is live | [resolution.test.ts:261](../../test/resolution.test.ts#L261) |
| `tsconfig.json` extends `./base.json` in the repo, which sets `verbatimModuleSyntax: true` | `src/side.ts#<module>` live | [security.test.ts:1572](../../test/security.test.ts#L1572) |
| `tsconfig.json` extends a file outside the repo with the same setting | `src/side.ts#<module>` not live | [security.test.ts:1562](../../test/security.test.ts#L1562) |

The last row under-counts on purpose. byakugan never reads a base config outside the repository, so its compiler options do not apply. See [limits](../limits.md).

## Imports byakugan cannot resolve

An import byakugan cannot resolve could hide anything, so it fails closed. The app counts as affected on every run, even for a README edit, and even against a manifest of the same graph. This mostly happens with an alias that only a bundler config defines. Moving the alias into tsconfig or jsconfig `paths` fixes it. See [limits](../limits.md).

```ts
// next.config.ts: byakugan does not read it
export default { turbopack: { resolveAlias: { '~lib': './lib' } } };
// app/page.tsx
import { v } from '~lib/v';
```

| Change | Result | Test |
| --- | --- | --- |
| Edit `lib/v.ts`, reached only through the `next.config.ts` alias | affected, reason `unresolved:app/page.tsx -> ~lib/v`, warns `cannot resolve "~lib/v"` | [resolution.test.ts:64](../../test/resolution.test.ts#L64) |
| Compare the same app against a manifest of its own graph, no change | affected, reason `unresolved:app/page.tsx -> ~lib/v` | [resolution.test.ts:92](../../test/resolution.test.ts#L92) |
| Same alias in tsconfig `paths` as `'~lib/*': ['./lib/*']`, edit `lib/unused.ts` | unaffected, no warnings | [resolution.test.ts:73](../../test/resolution.test.ts#L73) |
| Same, edit `lib/v.ts` | affected, reason `source:lib/v.ts#v` | [resolution.test.ts:73](../../test/resolution.test.ts#L73) |
| App with every import resolved, compared against its own manifest | unaffected | [resolution.test.ts:100](../../test/resolution.test.ts#L100) |
| `import { v } from '../lib/gone'` with no such file, edit `README.md` | affected, reason `unresolved:app/page.tsx -> ../lib/gone` | [resolution.test.ts:106](../../test/resolution.test.ts#L106) |
| `import { helper } from './missing'`, used as a value | affected, reason `unresolved:src/main.ts -> ./missing` | [git-mode.test.ts:451](../../test/git-mode.test.ts#L451) |
| Vite app, `vite.config.ts` aliases `@lib` to `/src/lib`, edit `src/lib/msg.ts` | affected, reason `unresolved:src/main.ts -> @lib/msg` | [resolution.test.ts:929](../../test/resolution.test.ts#L929) |
| tsconfig `paths` has `'@components/*'`, edit `src/components/Unused.ts` | unaffected | [resolution.test.ts:911](../../test/resolution.test.ts#L911) |
| Same, delete `src/components/B.ts`, which the page imports as `@components/B` | affected, reason `unresolved:app/page.tsx -> @components/B` | [resolution.test.ts:911](../../test/resolution.test.ts#L911) |
| Vite app imports `components/x`, an undeclared bare name with no file, edit `README.md` | affected, reason kind `unresolved` | [packaging.test.ts:616](../../test/packaging.test.ts#L616) |

### Which names fail closed and which warn

byakugan trusts a package that some `package.json` declares, installed or not, because the lockfile covers it. An undeclared bare name that does not resolve may be a bundler alias, so it fails closed. An `import type` that does not resolve only warns, since types never run.

| Setup | Result | Test |
| --- | --- | --- |
| `import pad from 'left-pad'`, declared in `dependencies`, not installed | unaffected, no warnings | [git-mode.test.ts:227](../../test/git-mode.test.ts#L227), [resolution.test.ts:112](../../test/resolution.test.ts#L112) |
| `import pad from 'left-pad'`, not declared, not installed | affected, reason `unresolved:src/main.ts -> left-pad` | [git-mode.test.ts:240](../../test/git-mode.test.ts#L240) |
| `scheduler` imported, not declared, installed in `node_modules` as a hoisted transitive package, edit `README.md` | unaffected, no warning, `npm:scheduler/index.js` live | [resolution.test.ts:944](../../test/resolution.test.ts#L944) |
| `import type { Route } from './+types/page'`, no such file, edit `README.md` | unaffected, warns | [resolution.test.ts:975](../../test/resolution.test.ts#L975), [git-mode.test.ts:444](../../test/git-mode.test.ts#L444) |
| Same import without `type`, edit `README.md` | affected, reason `unresolved:app/page.tsx -> ./+types/page` | [resolution.test.ts:991](../../test/resolution.test.ts#L991) |
| `import ... from '#util/u'` matching `"imports": { "#util/*": "./util/*.ts" }` | no warning | [resolution.test.ts:129](../../test/resolution.test.ts#L129) |
| `import ... from '#util/gone'`, no such file | warns `cannot resolve "#util/gone"` | [resolution.test.ts:129](../../test/resolution.test.ts#L129) |
| `baseUrl: '.'`, import `components/a`, which exists | no warning | [resolution.test.ts:142](../../test/resolution.test.ts#L142) |
| `baseUrl: '.'`, import `components/gone` | warns | [resolution.test.ts:142](../../test/resolution.test.ts#L142) |
| `baseUrl: '.'`, import `nothere/a`, no such directory and no package declares `nothere` | warns, read as an alias | [resolution.test.ts:142](../../test/resolution.test.ts#L142) |
| Same, with `nothere` in `dependencies` | no warning | [resolution.test.ts:142](../../test/resolution.test.ts#L142) |
| Linked workspace package `@acme/ui` whose `main` points at a missing file | warns `cannot resolve "@acme/ui"` | [resolution.test.ts:157](../../test/resolution.test.ts#L157) |
| Installed npm package `broken` whose `main` is missing | no warning | [resolution.test.ts:157](../../test/resolution.test.ts#L157) |
| `"@acme/ui": "workspace:*"` with no link in `node_modules` | warns | [resolution.test.ts:962](../../test/resolution.test.ts#L962) |
| `node_modules/@acme/ui` linked to a directory that does not exist | warns | [resolution.test.ts:962](../../test/resolution.test.ts#L962) |
| `import { serve } from 'bun'` | unaffected | [git-mode.test.ts:463](../../test/git-mode.test.ts#L463) |

### `virtual` in byakugan.json

`virtual` lists specifiers that a bundler plugin provides. byakugan stops failing closed for the ones it matches. In these globs `*` stops at `/`, so `~icons/**` is needed for a nested path.

```ts
// src/main.ts, a Vite app
import IconHome from '~icons/mdi/home';
import routes from '~react-pages';
```

```json
// byakugan.json
{ "virtual": ["~icons/**", "~react-pages"] }
```

| Change | Result | Test |
| --- | --- | --- |
| With `virtual: ["~icons/**", "~react-pages"]`, edit `README.md` | unaffected, no warnings | [resolution.test.ts:1020](../../test/resolution.test.ts#L1020) |
| No `virtual` | both specifiers warn | [resolution.test.ts:1044](../../test/resolution.test.ts#L1044) |
| `virtual: ["~icons/*"]`, edit `README.md` | affected, both still warn | [resolution.test.ts:1044](../../test/resolution.test.ts#L1044) |
| `virtual: ["./urls.json"]` for `import urls from './urls.json'`, a git-ignored file | no warning | [resolution.test.ts:1028](../../test/resolution.test.ts#L1028) |
| `virtual: ["./other.json"]` for the same import | warns `./urls.json` | [resolution.test.ts:1028](../../test/resolution.test.ts#L1028) |
| `import pad from 'left-pad'`, not declared or installed, with `"virtual": ["left-*"]` | unaffected, no warnings | [git-mode.test.ts:245](../../test/git-mode.test.ts#L245) |

### Next.js `server-only` and tsconfig shims

Next.js ships its own copy of `server-only`, so an import of it that does not resolve does not fail closed. A local shim that a tsconfig alias names is a project file and counts.

```ts
// app/page.tsx
import 'server-only';
```

```json
// tsconfig.json
{ "compilerOptions": { "paths": { "server-only": ["./src/shims/server-only.ts"] } } }
```

```ts
// src/shims/server-only.ts
console.log('shim');
```

| Change | Result | Test |
| --- | --- | --- |
| Next.js app imports `server-only` without installing or declaring it, edit `README.md` | unaffected | [packaging.test.ts:610](../../test/packaging.test.ts#L610), [git-mode.test.ts:456](../../test/git-mode.test.ts#L456) |
| No alias, `server-only` unresolved, no change | unaffected | [resolution.test.ts:1168](../../test/resolution.test.ts#L1168) |
| Delete the shim `src/shims/server-only.ts` | affected | [resolution.test.ts:1162](../../test/resolution.test.ts#L1162) |

Deleting the shim counts even though the import still works. The page falls back to Next.js's copy, and the shim's side effect is gone.

## Package export conditions

byakugan picks the build of a package that the app's bundler would load. A Vite app gets the `import` build, a Next.js app also gets `react-server` and `edge-light` builds, and a Cloudflare Worker gets `workerd`.

```json
// node_modules/dual/package.json
{ "exports": { ".": { "types": "./index.d.ts", "require": "./index.cjs", "import": "./index.mjs" } } }
```

```ts
// src/main.ts, a Vite app
import { f } from 'dual';
```

| Change | Result | Test |
| --- | --- | --- |
| Edit `node_modules/dual/index.d.ts` | unaffected, `npm:dual/index.mjs#f` live | [resolution.test.ts:644](../../test/resolution.test.ts#L644) |
| Edit `node_modules/dual/index.mjs` | affected | [resolution.test.ts:644](../../test/resolution.test.ts#L644) |
| Package `iso` with `browser: './browser.js'` and `main: './node.js'` | `npm:iso/browser.js#g` live, `iso/unused.js` not | [resolution.test.ts:661](../../test/resolution.test.ts#L661) |
| Package `iso2` with `browser: { './impl-node.js': './impl-browser.js' }` | `npm:iso2/impl-browser.js#h` live | [resolution.test.ts:661](../../test/resolution.test.ts#L661) |
| Packages with `react-server`, `edge-light` and `workerd` conditions, imported in a Next.js page | `rsc.js` and `edge.js` builds live | [resolution.test.ts:688](../../test/resolution.test.ts#L688) |
| Same packages in a Cloudflare Worker with `wrangler.jsonc` | `workerd.js` live, `rsc.js` not | [resolution.test.ts:694](../../test/resolution.test.ts#L694) |
| Same packages in a Vite app | only `default.js` live, no conditional build | [resolution.test.ts:705](../../test/resolution.test.ts#L705) |
| One package with both `edge-light` and `workerd`, in either order, imported in Next.js `middleware.ts` | only `npm:db/edge-light.js#q` live | [resolution.test.ts:1097](../../test/resolution.test.ts#L1097) |
| Same package in a Worker | only `npm:db/workerd.js#q` live | [resolution.test.ts:1097](../../test/resolution.test.ts#L1097) |

## Type-only packages

An `import type` from a package that only `@types` provides resolves to the `@types` package. byakugan counts it as `npm:<pkg>#<types>`, keyed by version.

```ts
// src/main.ts
import type { Paragraph } from 'mdast';   // only @types/mdast is installed
```

| Change | Result | Test |
| --- | --- | --- |
| (setup) | resolves to `npm:@types/mdast#<types>`, no warning | [resolution.test.ts:1264](../../test/resolution.test.ts#L1264) |
| Bump the version in `@types/mdast`'s `package.json` | affected | [resolution.test.ts:1270](../../test/resolution.test.ts#L1270) |
| `@types/mdast` not installed | one `cannot resolve` warning | [resolution.test.ts:1277](../../test/resolution.test.ts#L1277) |
| Change to `import { visit } from 'mdast'`, a value import | one `cannot resolve` warning | [resolution.test.ts:1281](../../test/resolution.test.ts#L1281) |

### Several installed copies

Each importer resolves its own copy. A copy that no used code imports does not count.

```ts
// src/index.ts
import type { A } from 'zod';           // node_modules/zod 3.0.1
import type { B } from '../lib/x';      // lib/x.ts imports a type from lib/node_modules/zod 4.1.0
// other/y.ts imports a type from other/node_modules/zod 5.0.0, and nothing uses other/y.ts
```

| Change | Result | Test |
| --- | --- | --- |
| Bump `lib/node_modules/zod` from 4.1.0 to 4.2.0 | affected. Manifest mode reason `npm:zod#<types>` | [packaging.test.ts:405](../../test/packaging.test.ts#L405) |
| Bump the root `node_modules/zod` from 3.0.1 to 3.0.2 | affected | [packaging.test.ts:414](../../test/packaging.test.ts#L414) |
| Bump `other/node_modules/zod` from 5.0.0 to 5.1.0 | unaffected | [packaging.test.ts:421](../../test/packaging.test.ts#L421) |

## Package `sideEffects`

byakugan believes a package's `sideEffects` field. A module that the field leaves out drops from the graph when the app uses none of its names, even when it has top-level code.

```ts
// src/lib/package.json
{ "sideEffects": ["effect.ts"] }
// src/index.ts
import { e } from './lib/effect';  // e is never used
import { p } from './lib/pure';    // p is never used
export const x = 1;
// src/lib/effect.ts and src/lib/pure.ts both start with console.log(...)
```

| Change | Result | Test |
| --- | --- | --- |
| (setup) | `src/lib/effect.ts#<module>` in the graph | [security.test.ts:241](../../test/security.test.ts#L241) |
| (setup) | `src/lib/pure.ts#<module>` not in the graph | [security.test.ts:245](../../test/security.test.ts#L245) |

An edit to the `console.log` in `pure.ts` would therefore not count.

## Build settings and package.json scripts

Config files that change the build are inputs, even though no code imports them. A config file that only an editor or generator reads is not.

| Setup | Change | Result | Test |
| --- | --- | --- | --- |
| Next.js app with `postcss.config.json`, `babel.config.json`, `browserslist` and `components.json` | (setup) | the first three are inputs, `components.json` is not | [resolution.test.ts:750](../../test/resolution.test.ts#L750) |
| `next.config.ts` sets `pageExtensions: ['page.tsx']` | (setup) | `app/page.page.tsx` is an entry, `app/helper.page.tsx` is not | [resolution.test.ts:765](../../test/resolution.test.ts#L765) |
| Monorepo fixture | Edit the root `postcss.config.mjs` and `apps/web/postcss.config.json` | affected, both as `input` reasons | [git-mode.test.ts:996](../../test/git-mode.test.ts#L996) |
| Monorepo fixture | Edit `apps/docs/postcss.config.mjs` in the sibling app | unaffected | [git-mode.test.ts:1006](../../test/git-mode.test.ts#L1006) |
| Basic app | Add a `scripts.build` entry to `package.json` | affected | [graph.test.ts:82](../../test/graph.test.ts#L82) |

## Generated files

byakugan leaves out declaration files that a framework writes on every build. Other `.d.ts` files are inputs.

| Setup | Change | Result | Test |
| --- | --- | --- | --- |
| Next.js app | Add `next-env.d.ts` and `src/next-env.d.ts` | unaffected | [packaging.test.ts:512](../../test/packaging.test.ts#L512) |
| Next.js app | Add `global.d.ts` | affected | [packaging.test.ts:520](../../test/packaging.test.ts#L520) |
| React Router app | Add `.react-router/types/app/+types/root.d.ts` and `.react-router/types/+routes.d.ts` | unaffected | [packaging.test.ts:534](../../test/packaging.test.ts#L534) |
| React Router app | Add `app/env.d.ts` | affected | [packaging.test.ts:542](../../test/packaging.test.ts#L542) |

## JSON with a UTF-8 byte order mark

`package.json`, `tsconfig.json`, `byakugan.json` and `node_modules/next/package.json` all start with a BOM. byakugan reads them anyway.

| Change | Result | Test |
| --- | --- | --- |
| (setup) | framework `next`, entries `app/page.tsx` and `scripts/seed.ts` from byakugan.json, tsconfig `paths` apply | [resolution.test.ts:1236](../../test/resolution.test.ts#L1236) |
| Edit `src/v.ts`, imported as `@/v` | affected, reason `source:src/v.ts#v` | [resolution.test.ts:1236](../../test/resolution.test.ts#L1236) |
| Edit `src/unused.ts` | unaffected | [resolution.test.ts:1246](../../test/resolution.test.ts#L1246) |

## package.json and tsconfig links the resolver reads

The resolver reads `package.json` and tsconfig files on its own. A committed link to a regular file inside the repository works. A config that is a link to a FIFO does not block the run.

| Setup | Result | Test |
| --- | --- | --- |
| Committed `src/lib/package.json -> real.json` on a tsconfig alias path | `src/lib/y.ts#y` live | [security.test.ts:490](../../test/security.test.ts#L490) |
| `tsconfig.json` references `ref/`, and `ref/tsconfig.json -> real.json` | `src/lib/y.ts#y` live | [security.test.ts:1488](../../test/security.test.ts#L1488) |
| No `.git`, `src/lib/package.json -> real.json` | `src/lib/y.ts#y` live | [security.test.ts:1513](../../test/security.test.ts#L1513) |
| Submodule `vendor/` with `lib/package.json -> real.json` | `vendor/lib/y.ts#y` live | [security.test.ts:1543](../../test/security.test.ts#L1543) |
| `next.config.js` and `wrangler.toml` are links to a FIFO | `app/page.tsx#Page` still live | [security.test.ts:435](../../test/security.test.ts#L435) |

## Fingerprints across machines

Keys hold no absolute path, no pnpm store path and no package version. The same code gives the same fingerprint on any machine and with any package manager layout.

| Change | Result | Test |
| --- | --- | --- |
| The basic app copied twice | same fingerprint | [graph.test.ts:111](../../test/graph.test.ts#L111) |
| Same app with `.git`, with `.git` moved away, and copied to another directory | same fingerprint, same live keys | [packaging.test.ts:441](../../test/packaging.test.ts#L441) |
| Copy to another directory, then edit `src/util.ts` | affected | [packaging.test.ts:456](../../test/packaging.test.ts#L456) |
| Monorepo app `apps/web` with `.git` moved away | same fingerprint, keys stay relative to the repo root, such as `apps/web/src/index.ts` | [packaging.test.ts:465](../../test/packaging.test.ts#L465) |
| Same `lodash/partition` import with an npm layout and with a pnpm `.pnpm/lodash@4.17.21` layout | same fingerprint, keys such as `npm:lodash/partition.js` | [packaging.test.ts:479](../../test/packaging.test.ts#L479) |
