# Exports, barrels and code

Edits inside project source files. Most rows commit a small app with
`src/main.ts` as the entry, edit the working tree and run git mode against
`main`.

[All examples](README.md)

## An unused export next to a used one

byakugan hashes each top-level declaration on its own and counts only the ones
the app reaches. A private helper counts when a used export calls it, and the
reason names the helper, not the file.

```ts
// src/utils.ts, main.tsx imports formatDate
const pad = (n: number) => String(n).padStart(2, '0');
export function formatDate(date: Date) { return `${date.getFullYear()}-${pad(date.getMonth() + 1)}`; }
export function formatMoney(value: number) { return `$${value.toFixed(2)}`; }
```

| Affected | Unaffected |
| --- | --- |
| Edit `pad`, which `formatDate` calls. Reason `src/utils.ts#pad` [graph.test.ts:70](../../test/graph.test.ts#L70), [cli.test.ts:49](../../test/cli.test.ts#L49) | Edit `formatMoney`, which nothing imports [graph.test.ts:69](../../test/graph.test.ts#L69), [cli.test.ts:49](../../test/cli.test.ts#L49) |

<details>
<summary>2 more cases</summary>

| Change | Result | Test |
| --- | --- | --- |
| Add a comment `// money` before `formatMoney` | unaffected | [graph.test.ts:71](../../test/graph.test.ts#L71) |
| No edit, read the graph. utils.ts also exports `cn`, which Button uses | `src/utils.ts#formatDate`, `#pad` and `#cn` live, `#formatMoney` not | [graph.test.ts:27](../../test/graph.test.ts#L27) |

</details>

## Deleting or renaming an export

Deleting an export, or dropping its `export` keyword, counts only when some
module imports that name.

```ts
// src/main.ts
import { price } from './lib';

// src/lib.ts
export const price = (n: number) => n * 2;
export const other = 1;
```

| Affected | Unaffected |
| --- | --- |
| Delete `price`. Reason `src/lib.ts#price` [precision.test.ts:46](../../test/precision.test.ts#L46) | Delete `other` [precision.test.ts:52](../../test/precision.test.ts#L52) |

<details>
<summary>3 more cases</summary>

| Change | Result | Test |
| --- | --- | --- |
| Drop the `export` keyword from `price` | affected, reason `src/lib.ts#price` | [precision.test.ts:57](../../test/precision.test.ts#L57) |
| Drop the `export` keyword from `other` | unaffected | [precision.test.ts:63](../../test/precision.test.ts#L63) |
| Rename `price` to `cost` while main.ts still imports `price` | affected | [precision.test.ts:68](../../test/precision.test.ts#L68) |

</details>

## Exports used only as types

A declaration the app reaches through `import type` counts. An interface nobody
imports does not.

| Affected | Unaffected |
| --- | --- |
| Edit `Props` in `src/types.ts`, which main.tsx imports with `import type` [graph.test.ts:74](../../test/graph.test.ts#L74) | Edit `Unused` in the same file, which nothing imports [graph.test.ts:73](../../test/graph.test.ts#L73) |

<details>
<summary>4 more cases</summary>

In these rows main.ts has `import type { Props } from './lib'`, and lib.ts
exports `interface Props` and `const other`.

| Change | Result | Test |
| --- | --- | --- |
| Delete `interface Props` | affected, reason `src/lib.ts#Props` | [precision.test.ts:73](../../test/precision.test.ts#L73) |
| Delete the whole `src/lib.ts`, which holds only `Props` | affected, reason `src/lib.ts` | [precision.test.ts:92](../../test/precision.test.ts#L92) |
| Same, with the file at `src/lib/index.ts` or imported as `./lib.js` | affected | [precision.test.ts:98](../../test/precision.test.ts#L98) |
| Delete `src/spare.ts`, which nothing imports | unaffected | [precision.test.ts:105](../../test/precision.test.ts#L105) |

</details>

Once `lib.ts` is gone, the `import type` line that no longer resolves only
warns. Git mode still reports the deletion.

## Exports of an entry

Every export of an entry counts, because a framework may read it. A Next.js
route handler exports `GET`, `POST` and `revalidate`, and no project file
imports them.

```ts
// src/main.ts, the entry
export const revalidate = 60;
export function POST() { return 'posted'; }
const spare = 1;
```

| Change | Result | Test |
| --- | --- | --- |
| Delete `POST` | affected, reason `src/main.ts#POST` | [precision.test.ts:115](../../test/precision.test.ts#L115) |
| Drop `export` from `revalidate` | affected, reason `src/main.ts#revalidate` | [precision.test.ts:121](../../test/precision.test.ts#L121) |
| Delete `const spare`, which nothing uses | unaffected | [precision.test.ts:127](../../test/precision.test.ts#L127) |

## Default exports

```ts
// src/page.ts
export default function Page() { return 'page'; }
export const x = 1;
```

| Affected | Unaffected |
| --- | --- |
| Delete the default export while main.ts does `import Page from './page'`. Reason `src/page.ts#Page` [precision.test.ts:136](../../test/precision.test.ts#L136) | Delete the default export while main.ts imports only `{ x }` [precision.test.ts:145](../../test/precision.test.ts#L145) |

## Barrels

A barrel line counts when a name the app imports passes through it. Every
module behind an `export *` still runs with the barrel, so its top-level
statements count even when the app uses none of its exports.

```ts
// src/components/index.ts, the app imports Button through it
export * from './Button';
export * from './Modal';   // nothing imports Modal
export { Card } from './Card';
```

| Affected | Unaffected |
| --- | --- |
| Edit `Button` [graph.test.ts:68](../../test/graph.test.ts#L68) | Edit `Modal` [graph.test.ts:67](../../test/graph.test.ts#L67) |

<details>
<summary>7 more cases</summary>

| Setup | Change | Result | Test |
| --- | --- | --- | --- |
| The barrel above | Change `Button.displayName` | affected | [graph.test.ts:79](../../test/graph.test.ts#L79) |
| same | Change `Modal.displayName` | unaffected | [graph.test.ts:78](../../test/graph.test.ts#L78) |
| same | Append `console.log('loaded')` to `Modal.tsx` | affected | [graph.test.ts:80](../../test/graph.test.ts#L80) |
| same | No edit, read the graph | `index.ts#export*:./Button` and `Button.tsx#Button` live. `export*:./Modal` and everything in `Modal.tsx` and `Card.tsx` not | [graph.test.ts:34](../../test/graph.test.ts#L34) |
| main.ts imports `price` through `src/index.ts`, which has `export * from './lib'` | Delete `price` from lib.ts | affected | [precision.test.ts:179](../../test/precision.test.ts#L179) |
| same | Drop `export` from `price` in lib.ts | affected | [precision.test.ts:184](../../test/precision.test.ts#L184) |
| same | Delete `other` from lib.ts | unaffected | [precision.test.ts:189](../../test/precision.test.ts#L189) |

</details>

The `console.log` row is a known gap. See [limits](../limits.md), "Modules a
barrel loads still run".

### `export *` in an entry

An entry passes on every name its `export *` lines forward, so they all count.
`export *` never forwards a default export, so a default export behind it does
not count, even in an entry.

```ts
// src/main.ts, the entry
export * from './config';

// src/config.ts
export const revalidate = 60;
export default function unused() {}
```

| Affected | Unaffected |
| --- | --- |
| Delete `revalidate` from config.ts [precision.test.ts:195](../../test/precision.test.ts#L195) | Delete `export default function unused()` from config.ts [precision.test.ts:207](../../test/precision.test.ts#L207) |

<details>
<summary>4 more cases</summary>

| Change | Result | Test |
| --- | --- | --- |
| Delete `revalidate` two hops away, main.ts to mid.ts to config.ts | affected, reason `src/config.ts#revalidate` | [precision.test.ts:225](../../test/precision.test.ts#L225) |
| Delete the default export two hops away | unaffected | [precision.test.ts:231](../../test/precision.test.ts#L231) |
| Delete `b` inside an `export *` cycle, a.ts and b.ts re-export each other | affected, reason `src/b.ts#b` | [precision.test.ts:236](../../test/precision.test.ts#L236) |
| Delete `z` behind `export * as ns from './lib'` then `export * from './deep'` | affected, reason `src/deep.ts#z` | [precision.test.ts:245](../../test/precision.test.ts#L245) |

</details>

### Sibling `export *` lines

```ts
// src/main.ts
import { a } from './barrel';

// src/barrel.ts
export * from './one';   // export const a = 1;
export * from './two';   // export const b = 2;
```

| Change | Result | Test |
| --- | --- | --- |
| Rename `b` to `c` in two.ts | unaffected | [precision.test.ts:254](../../test/precision.test.ts#L254) |

### Adding a new `export *` line

Adding a line is free while the new module exports only names nobody imports
and has no top-level code.

```ts
// src/main.ts
import { a } from './barrel';

// src/barrel.ts, the change adds the second line
export * from './one';
export * from './two';
```

| Affected | Unaffected |
| --- | --- |
| Add the line when two.ts also exports `a`. Reason `src/barrel.ts#export*:./two` [precision.test.ts:284](../../test/precision.test.ts#L284) | Add the line when two.ts exports only `b`, also with one more barrel in front of barrel.ts [precision.test.ts:278](../../test/precision.test.ts#L278) |

<details>
<summary>4 more cases</summary>

| Change | Result | Test |
| --- | --- | --- |
| Add the line when main.ts does `import * as ns from './barrel'` | affected | [precision.test.ts:290](../../test/precision.test.ts#L290) |
| Add the line when two.ts sets `globalThis.ready = true` | affected, reason `src/barrel.ts#<imports>` | [precision.test.ts:295](../../test/precision.test.ts#L295) |
| Add `export * from './nope'`, a file that does not exist | affected | [precision.test.ts:301](../../test/precision.test.ts#L301) |
| Change an existing `export * from './two'` to `export type * from './two'` | affected | [precision.test.ts:306](../../test/precision.test.ts#L306) |

</details>

### `export type *`

`export type *` forwards types and runs nothing, so the top-level code of the
module behind it does not count.

```ts
// src/index.ts, main.ts imports the type Event and the value track from it
export type * from './analytics';    // analytics.ts logs at the top level
export { track } from './track';
```

| Affected | Unaffected |
| --- | --- |
| Change `export type *` to `export *`. Reasons include `src/index.ts#export*:./analytics` [precision.test.ts:562](../../test/precision.test.ts#L562) | Edit the `console.log` in analytics.ts [precision.test.ts:569](../../test/precision.test.ts#L569) |

### `export *` cycles and long chains

byakugan follows `export *` lines through cycles and through thousands of
modules, and still counts only the names the app takes.

| Affected | Unaffected |
| --- | --- |
| A 200-module `export *` chain into a 10-module cycle, the app imports `v6` among others. Edit `v6` in `c6.ts` [packaging.test.ts:186](../../test/packaging.test.ts#L186) | Same chain, edit `v3` in `c3.ts`, which nothing imports [packaging.test.ts:186](../../test/packaging.test.ts#L186) |

<details>
<summary>5 more cases</summary>

| Setup and change | Result | Test |
| --- | --- | --- |
| a.ts and b.ts each declare one name and `export *` each other. index.ts imports `b` through d.ts, which has `export * from './a'`, and `a` through c.ts, which has `export * from './b'`. No edit | `src/b.ts#b` live | [packaging.test.ts:155](../../test/packaging.test.ts#L155) |
| The 200-module chain, the app imports `v0`, `v9`, `v4` and `v6` through different entry points, no edit | all four live, no warnings | [packaging.test.ts:180](../../test/packaging.test.ts#L180) |
| A 3,000-module `export *` chain, each module also exports `v<i>`, edit `v5` in `m5.ts` | unaffected | [packaging.test.ts:103](../../test/packaging.test.ts#L103) |
| Same, edit `leaf` at the end of the chain | affected | [packaging.test.ts:103](../../test/packaging.test.ts#L103) |
| A 3,000-module `export *` chain, the entry imports `leaf` from the first module | `src/m2999.ts#leaf` live, `src/m2999.ts#other` not | [security.test.ts:802](../../test/security.test.ts#L802) |

</details>

## Namespace imports

byakugan reads `ns.price` as a use of `price` alone. A namespace that comes
through `export * as ns` in a barrel counts whole, so every export behind it
counts.

```ts
// src/main.ts
import * as ns from './lib';
export const r = ns.price(1);
```

| Affected | Unaffected |
| --- | --- |
| Delete `price`. Reason `src/lib.ts#price` [precision.test.ts:318](../../test/precision.test.ts#L318) | Delete `other`, which main.ts never reads [precision.test.ts:324](../../test/precision.test.ts#L324) |

<details>
<summary>3 more cases</summary>

| Change | Result | Test |
| --- | --- | --- |
| Delete `price` when main.ts reads it as `ns.price` through `export * as ns from './lib'` in a barrel | affected, reason `src/lib.ts#price` | [precision.test.ts:331](../../test/precision.test.ts#L331) |
| Edit `lower` in the basic fixture, where main.tsx reads only `strings.upper` | unaffected | [graph.test.ts:72](../../test/graph.test.ts#L72) |
| No edit, read the graph of the basic fixture | `src/strings.ts#upper` live, `#lower` not | [graph.test.ts:42](../../test/graph.test.ts#L42) |

</details>

### `import()`

`import()` hands the whole namespace to the caller. Every export of the target
counts, and its non-exported locals do not.

```ts
// src/main.ts
const m = await import('./lib');
console.log(m);
```

| Affected | Unaffected |
| --- | --- |
| Delete the export `price` from lib.ts. Reason `src/lib.ts#price` [precision.test.ts:160](../../test/precision.test.ts#L160) | Delete a non-exported `const spare` from lib.ts [precision.test.ts:166](../../test/precision.test.ts#L166) |

### `import lib = require()` in TypeScript

byakugan reads `lib.price` as a member access, the same as `ns.price`, so it
tracks one export.

```ts
// src/main.ts
import lib = require('./lib');
console.log(lib.price);
```

| Affected | Unaffected |
| --- | --- |
| Change `price = 1` to `price = 3`. Reason `src/lib.ts#price` [precision.test.ts:1336](../../test/precision.test.ts#L1336) | Change `other = 2` to `other = 4` [precision.test.ts:1342](../../test/precision.test.ts#L1342) |

## Imports that run modules

Importing a module runs it, whether or not the app uses the binding. Adding or
removing an import counts when the target, or a module it imports, has
top-level code, and byakugan records those imports in order in the importer's
`<imports>` fragment.

```ts
// src/components.ts, main.ts uses only Used
import { X } from './some-module';   // the import being added or removed
export const Used = 1;
export const Unused = () => X;
```

| Affected | Unaffected |
| --- | --- |
| Add an import of `./analytics`, which has `console.log('tracking')` at the top. Reason `src/components.ts#<imports>` [precision.test.ts:472](../../test/precision.test.ts#L472) | Add an import of `./pure`, which only declares `export const pure = 1` [precision.test.ts:478](../../test/precision.test.ts#L478) |

<details>
<summary>8 more cases</summary>

| Change | Result | Test |
| --- | --- | --- |
| Remove an import of `./fancy`, which imports `./fancy.css` | affected, reason `src/components.ts#<imports>` | [precision.test.ts:461](../../test/precision.test.ts#L461) |
| Remove an import of `./pure` | unaffected | [precision.test.ts:467](../../test/precision.test.ts#L467) |
| Add an import of `./mid`, which imports `./analytics` | affected | [precision.test.ts:483](../../test/precision.test.ts#L483) |
| Add an import of `./analytics` when main.ts already has `import './analytics'` | unaffected | [precision.test.ts:491](../../test/precision.test.ts#L491) |
| Add an import of package `tracker`, whose `index.js` logs at the top level | affected | [precision.test.ts:502](../../test/precision.test.ts#L502) |
| Same, with `"sideEffects": false` in tracker's package.json | unaffected | [precision.test.ts:507](../../test/precision.test.ts#L507) |
| Swap `import { a } from './a'` and `import { b } from './b'`, both log | affected, reason `src/components.ts#<imports>` | [precision.test.ts:520](../../test/precision.test.ts#L520) |
| Swap the same imports when a.ts and b.ts only declare things | unaffected | [precision.test.ts:529](../../test/precision.test.ts#L529) |

</details>

### Runtime modules

The runtime provides `bun` and `cloudflare:workers`, so the bundle never ran
their code. Dropping an unused import of one does not count.

```ts
// src/mid.ts, main.ts imports a
import { x } from '<from>';
export const a = 1;
export const unused = () => x;
```

| Affected | Unaffected |
| --- | --- |
| `<from>` is `./effect`, whose top level logs, drop the import [git-mode.test.ts:487](../../test/git-mode.test.ts#L487) | `<from>` is `bun` or `cloudflare:workers`, drop the import [git-mode.test.ts:479](../../test/git-mode.test.ts#L479) |

### Removing an import

Git mode checks a removed import against the base side, since that side ran
the module. A bare import of a module that runs belongs to the importer's
`<module>` fragment, so removing it counts even when the target is empty.

```ts
// src/lib.ts, main.ts uses price
import './register';          // register.ts is `export {};`
const rate = 2;
export const price = (n: number) => n * rate;
export const legacy = () => 'old';
```

| Affected | Unaffected |
| --- | --- |
| Delete `import './register';`. Reason `src/lib.ts#<module>` removed [affected.test.ts:211](../../test/affected.test.ts#L211) | Delete the unused `legacy` export [affected.test.ts:219](../../test/affected.test.ts#L219) |

<details>
<summary>2 more cases</summary>

| Change | Result | Test |
| --- | --- | --- |
| Delete `import './polyfill';` from main.ts | affected, reason `src/main.ts#<module>` | [affected.test.ts:203](../../test/affected.test.ts#L203) |
| After deleting `legacy`, delete `const rate = 2;`, which `price` still names | affected, reason `src/lib.ts#rate` removed | [affected.test.ts:219](../../test/affected.test.ts#L219) |

</details>

### Removed imports whose target also changed

The base side ran the side effect, so removing the import counts even when the
working tree deletes the target or makes it pure.

```ts
// src/components.ts, the change removes the first line
import { Fancy } from './fancy';     // fancy.ts: console.log('fancy boot')
export const Used = 1;
export const Unused = () => Fancy;
```

| Affected | Unaffected |
| --- | --- |
| Also delete fancy.ts [precision.test.ts:929](../../test/precision.test.ts#L929) | The target is pure.ts, deleted along with the import [precision.test.ts:939](../../test/precision.test.ts#L939) |

<details>
<summary>4 more cases</summary>

| Change | Result | Test |
| --- | --- | --- |
| Also remove the `console.log` from fancy.ts | affected | [precision.test.ts:934](../../test/precision.test.ts#L934) |
| The target is package `tracker` with `"sideEffects": false` | unaffected | [precision.test.ts:947](../../test/precision.test.ts#L947) |
| components.ts imports an unchanged mid.ts, which imports fancy.ts, and fancy.ts loses its side effect | affected | [precision.test.ts:967](../../test/precision.test.ts#L967) |
| Same chain, and fancy.ts is deleted | affected | [precision.test.ts:972](../../test/precision.test.ts#L972) |

</details>

### Removed imports whose target moved

Same setup as above. In each affected case `./fancy` resolves to a different
file in the working tree than on `main`, and the file on `main` ran the side
effect.

| Affected | Unaffected |
| --- | --- |
| Also rename `fancy.ts` to `fancy.tsx` [precision.test.ts:990](../../test/precision.test.ts#L990) | The target is `pure.ts`, renamed to `pure.tsx` [precision.test.ts:996](../../test/precision.test.ts#L996) |

<details>
<summary>5 more cases</summary>

| Change | Result | Test |
| --- | --- | --- |
| Also move `fancy/index.ts` to `fancy.ts` | affected | [precision.test.ts:1004](../../test/precision.test.ts#L1004) |
| The import goes through a tsconfig alias `@/fancy`, and fancy.ts becomes fancy.tsx | affected | [precision.test.ts:1011](../../test/precision.test.ts#L1011) |
| components.ts imports mid.ts, which has `export * from './fancy'`, and fancy.ts becomes a side-effect-free fancy.tsx | affected | [precision.test.ts:1025](../../test/precision.test.ts#L1025) |
| Add a pure `fancy.ts` next to `fancy/index.ts`, so `./fancy` now resolves to the new file | affected | [precision.test.ts:1038](../../test/precision.test.ts#L1038) |
| Delete fancy.ts, so `./fancy` now resolves to an unchanged, pure `fancy.js` | affected | [precision.test.ts:1046](../../test/precision.test.ts#L1046) |

</details>

### `import()` turned into a static import

main.ts already has `export const load = () => import('./x')`. A static
`import { ... } from './x'` in components.ts makes the module run at startup
instead of on demand.

| Affected | Unaffected |
| --- | --- |
| Add the static import, the target is `./analytics`, which logs at the top level [precision.test.ts:541](../../test/precision.test.ts#L541) | Add the static import, the target is `./pure` [precision.test.ts:547](../../test/precision.test.ts#L547) |

### Import cycles

A module in an import cycle runs the side effects that any module in the cycle
reaches.

```ts
// src/a.ts
import { b } from './b';
import { c } from './c';   // c.ts may or may not log at the top level

// src/b.ts
import { a } from './a';
```

| Affected | Unaffected |
| --- | --- |
| main.ts adds `import { b } from './b'`, used only in an unused local, and c.ts logs. Reason `src/main.ts#<imports>` [precision.test.ts:908](../../test/precision.test.ts#L908) | Same import, c.ts has no side effect [precision.test.ts:914](../../test/precision.test.ts#L914) |

<details>
<summary>4 more cases</summary>

These rows ask `graph.effectful` directly instead of running git mode.

| Change | Result | Test |
| --- | --- | --- |
| No edit, ask about b.ts, which reaches the side effect of c.ts only through the cycle | effectful | [precision.test.ts:868](../../test/precision.test.ts#L868) |
| No edit, ask about each member of the cycle in different orders | same answer whichever is asked first | [precision.test.ts:879](../../test/precision.test.ts#L879) |
| A cycle with no side effect anywhere | not effectful | [precision.test.ts:889](../../test/precision.test.ts#L889), [packaging.test.ts:214](../../test/packaging.test.ts#L214) |
| A cycle with `console.log` in c.ts | a.ts and b.ts both effectful | [packaging.test.ts:206](../../test/packaging.test.ts#L206) |

</details>

### Import order across files

ESM runs imports depth first. An import of a module that already ran still
counts when it moves that module earlier, ahead of code that reads what it
sets.

```ts
// src/main.ts
import './a';     // a.ts imports './x', and x.ts reads globalThis.flag
import './y';     // y.ts imports t.ts, and t.ts sets globalThis.flag = 1
```

| Affected | Unaffected |
| --- | --- |
| x.ts adds `import { t } from './t'`, used only in an unused export [precision.test.ts:1065](../../test/precision.test.ts#L1065) | Same edit, but main.ts imports `./y` before `./a` [precision.test.ts:1071](../../test/precision.test.ts#L1071) |

In the second order y.ts already ran t.ts before x.ts, so nothing moves.

## Top-level code that runs on load

### Member assignments

An assignment to a property of a local declaration belongs to that
declaration. An assignment on a DOM node reached through a local is a side
effect of the module.

| Affected | Unaffected |
| --- | --- |
| ui.ts has `const config = {}; config.debug = true`, and main.ts imports the exported `config`. Change `true` to `false`. Reason `src/ui.ts#config` [precision.test.ts:609](../../test/precision.test.ts#L609) | Same, but nothing uses `config` [precision.test.ts:603](../../test/precision.test.ts#L603) |

<details>
<summary>3 more cases</summary>

| Setup and change | Result | Test |
| --- | --- | --- |
| main.ts has `const root = document.documentElement; root.dataset.theme = 'dark'`, change it to `'light'` | affected, reason `src/main.ts#<module>` | [precision.test.ts:578](../../test/precision.test.ts#L578) |
| main.ts has `const app = document.getElementById('app'); app.innerHTML = '<p>a</p>'`, change the HTML | affected | [precision.test.ts:586](../../test/precision.test.ts#L586) |
| ui.ts, imported for another export, has `Modal.displayName = 'Modal'` on an unused function, change it to `'Dialog'` | unaffected | [precision.test.ts:597](../../test/precision.test.ts#L597) |

</details>

### Initializers

A top-level initializer that calls a function runs when the module loads,
whether or not anything uses the result. Calls that byakugan knows only build a
value, such as `cva()` or a call marked `/*#__PURE__*/`, count only when the
result is used.

```ts
// src/lib.ts, main.ts imports only `price`
import { cva } from 'class-variance-authority';
import { createStore } from './store';        // createStore writes to globalThis
export const price = (n: number) => n * 2;
export const store = createStore('a');
export const variants = cva('a');
```

| Affected | Unaffected |
| --- | --- |
| `createStore('a')` to `createStore('b')`. Reason `src/lib.ts#store` [precision.test.ts:1182](../../test/precision.test.ts#L1182) | `cva('a')` to `cva('b')` [precision.test.ts:1193](../../test/precision.test.ts#L1193) |

<details>
<summary>10 more cases</summary>

| Change | Result | Test |
| --- | --- | --- |
| Edit `createStore` in store.ts | affected | [precision.test.ts:1188](../../test/precision.test.ts#L1188) |
| `/*#__PURE__*/ createStore('a')` to `'b'` | unaffected | [precision.test.ts:1198](../../test/precision.test.ts#L1198) |
| Edit an unused object literal `{ a: [1, 2].map(n => n * 2) }` and an unused arrow `() => createStore()` | unaffected | [precision.test.ts:1206](../../test/precision.test.ts#L1206) |
| `['a'].map(n => createStore(n))` to `['b']` | affected | [precision.test.ts:1215](../../test/precision.test.ts#L1215) |
| `['a'].map(register)`, where `register` calls `createStore`, to `['b']` | affected | [precision.test.ts:1221](../../test/precision.test.ts#L1221) |
| Same with a `register` that only returns its argument | unaffected | [precision.test.ts:1221](../../test/precision.test.ts#L1221) |
| `Array.prototype.push.call(list, 'a')` to `'b'` | affected | [precision.test.ts:1230](../../test/precision.test.ts#L1230) |
| `Array.isArray(['a'])` to `['b']` | unaffected | [precision.test.ts:1230](../../test/precision.test.ts#L1230) |
| Class field `static s = createStore('a')` to `'b'` | affected | [precision.test.ts:1240](../../test/precision.test.ts#L1240) |
| An unused class with `static n = 1`, changed to `2` | unaffected | [precision.test.ts:1240](../../test/precision.test.ts#L1240) |

</details>

The list of value-only calls can miss a call with side effects. See
[limits](../limits.md).

### TypeScript syntax that compiles to running code

An `enum` or `namespace` compiles to statements that run. main.ts imports only
`price` from lib.ts, and `reg` writes to `globalThis`.

| Affected | Unaffected |
| --- | --- |
| `export enum Level { Low = reg(1) }`, change it to `reg(2)` [precision.test.ts:1306](../../test/precision.test.ts#L1306) | An unused `enum Level { Low = 1, High = Low * 2 }`, change `Low = 1` to `3` [precision.test.ts:1312](../../test/precision.test.ts#L1312) |

<details>
<summary>2 more cases</summary>

| Change | Result | Test |
| --- | --- | --- |
| `export namespace Setup { reg(1); }`, change it to `reg(2)` | affected | [precision.test.ts:1318](../../test/precision.test.ts#L1318) |
| An unused namespace that only declares a `const`, a function and an interface, edit both values | unaffected | [precision.test.ts:1324](../../test/precision.test.ts#L1324) |

</details>

## Declaration order

Moving a `const`, `let` or class below the top-level code that reads it throws
at runtime, so the move counts. JavaScript hoists function declarations, and a
reference inside a function body runs later, so order does not matter for them.

```ts
// src/lib.ts, main.ts imports `price`
export const base = 1;
export const price = base * 2;
export const other = 3;
```

| Affected | Unaffected |
| --- | --- |
| Move `base` below `price`. Reason `src/lib.ts#price` [precision.test.ts:1257](../../test/precision.test.ts#L1257) | Move `function f()` below `export const price = f()` [precision.test.ts:1277](../../test/precision.test.ts#L1277) |

<details>
<summary>4 more cases</summary>

| Change | Result | Test |
| --- | --- | --- |
| Move `other` to the top | unaffected | [precision.test.ts:1263](../../test/precision.test.ts#L1263) |
| Move `class A {}` below `export class B extends A {}` | affected | [precision.test.ts:1268](../../test/precision.test.ts#L1268) |
| Move `const x = 1` below a top-level `console.log(x)` | affected | [precision.test.ts:1286](../../test/precision.test.ts#L1286) |
| Swap `const base` and `export const price = () => base` | unaffected | [precision.test.ts:1292](../../test/precision.test.ts#L1292) |

</details>

## TypeScript import elision and `verbatimModuleSyntax`

TypeScript drops an import that brings in only types. Under
`verbatimModuleSyntax` it keeps `import { type X }` as a bare import, so the
module still runs, and it drops `import type { X }` either way.

```ts
// src/theme.ts, the change edits 'dark' to 'light' on the first line
document.documentElement.dataset.theme = 'dark';
export type Theme = 'dark' | 'light';

// src/main.ts
import { type Theme } from './theme';
```

| Affected | Unaffected |
| --- | --- |
| tsconfig sets `verbatimModuleSyntax: true`. Reason `src/theme.ts#<module>` [precision.test.ts:757](../../test/precision.test.ts#L757) | tsconfig without it [precision.test.ts:764](../../test/precision.test.ts#L764) |

<details>
<summary>3 more cases</summary>

| Setup | Result | Test |
| --- | --- | --- |
| With it, but main.ts uses `import type { Theme }` | unaffected | [precision.test.ts:770](../../test/precision.test.ts#L770) |
| With it, main.ts is `export { type Theme } from './theme'` | affected | [precision.test.ts:779](../../test/precision.test.ts#L779) |
| Set in `tsconfig.base.json`, which `tsconfig.json` extends | affected | [precision.test.ts:784](../../test/precision.test.ts#L784) |

</details>

byakugan reads the setting from the app's tsconfig chain only. A workspace
package that sets it in its own tsconfig is a known gap. See
[limits](../limits.md).

## Decorators and class bodies

Decorators run when the class is defined, so a decorator argument counts even
when the app imports no class from the file.

```ts
// src/users.ts
import { Controller } from './dec';
@Controller('/users')
export class UserController {}
```

| Affected | Unaffected |
| --- | --- |
| main.ts only does `import './users'`. Change a class decorator argument [precision.test.ts:389](../../test/precision.test.ts#L389) | Same import, change field `name = 'a'` to `'b'` in an undecorated class [precision.test.ts:410](../../test/precision.test.ts#L410) |

<details>
<summary>9 more cases</summary>

| Setup | Change | Result | Test |
| --- | --- | --- | --- |
| main.ts imports `UserController` | Change `@Controller('/users')` to `'/admin/users'` | affected, reasons include `src/users.ts#UserController` | [precision.test.ts:355](../../test/precision.test.ts#L355) |
| same | Remove the decorator | affected | [precision.test.ts:364](../../test/precision.test.ts#L364) |
| same | Change the argument on `export default class` | affected | [precision.test.ts:370](../../test/precision.test.ts#L370) |
| main.ts only does `import './users'` | Add `@Input('b')` to a field of `class Plain` | affected | [precision.test.ts:395](../../test/precision.test.ts#L395) |
| same | Edit a `static { console.log('a') }` block | affected | [precision.test.ts:403](../../test/precision.test.ts#L403) |
| same | Edit the argument of a constructor parameter decorator `@Input('a') name` | affected | [precision.test.ts:423](../../test/precision.test.ts#L423) |
| same | Same on a parameter property `@Input('a') private name` | affected | [precision.test.ts:429](../../test/precision.test.ts#L429) |
| same | Same on a method parameter `handle(@Input('a') body)` | affected | [precision.test.ts:435](../../test/precision.test.ts#L435) |
| same | Edit a default `constructor(name = 'a')` with no decorator | unaffected | [precision.test.ts:441](../../test/precision.test.ts#L441) |

</details>

## Classic JSX factories and pragmas

With the classic runtime, `<div />` calls the factory, so the factory counts.
The automatic runtime, `react-jsx`, leaves an imported `h` unused, so editing
it does not count.

```tsx
// src/main.tsx, the entry
import { h } from './jsx';
export const App = () => <div />;
```

| Affected | Unaffected |
| --- | --- |
| tsconfig `jsx: react, jsxFactory: h`, edit `h`. Reason `src/jsx.ts#h` [precision.test.ts:625](../../test/precision.test.ts#L625) | tsconfig `jsx: react-jsx`, edit `h` [precision.test.ts:635](../../test/precision.test.ts#L635) |

<details>
<summary>14 more cases</summary>

| Setup and change | Result | Test |
| --- | --- | --- |
| tsconfig `jsx: react` with no factory, main.tsx imports `React` from `./react`, edit `createElement` | affected | [precision.test.ts:644](../../test/precision.test.ts#L644) |
| `jsxFragmentFactory: Fragment`, the JSX uses `<>...</>`, edit `Fragment` | affected, reason `src/jsx.ts#Fragment` | [precision.test.ts:654](../../test/precision.test.ts#L654) |
| Same factory settings, no `<>` in the JSX, edit `Fragment` | unaffected | [precision.test.ts:663](../../test/precision.test.ts#L663) |
| `/** @jsx h */` pragma in main.tsx, edit `h` | affected | [precision.test.ts:673](../../test/precision.test.ts#L673) |
| `/** @jsx h */` in ui.tsx, whose JSX sits only in an unused export, edit `h` | unaffected | [precision.test.ts:679](../../test/precision.test.ts#L679) |
| Change `@jsx h` to `@jsx f` | affected, reason `src/main.tsx#<module>` | [precision.test.ts:691](../../test/precision.test.ts#L691) |
| Add `/** @jsxImportSource @emotion/react */` | affected | [precision.test.ts:699](../../test/precision.test.ts#L699) |
| Add a plain `/** The app. */` comment | unaffected | [precision.test.ts:706](../../test/precision.test.ts#L706) |
| Add `@jsxImportSource` on its own line inside a multi-line doc comment | affected | [precision.test.ts:713](../../test/precision.test.ts#L713) |
| Edit a comment `// pass @jsx through the loader` | unaffected | [precision.test.ts:722](../../test/precision.test.ts#L722) |
| Monorepo fixture, prepend `/** @jsxImportSource @emotion/react */` to `packages/ui/src/Button.tsx` | affected, reason `packages/ui/src/Button.tsx#<module>` | [git-mode.test.ts:732](../../test/git-mode.test.ts#L732) |
| Same file, prepend `/** a button */` | unaffected | [git-mode.test.ts:740](../../test/git-mode.test.ts#L740) |
| `jsxImportSource: 'emo'` in byakugan.json, automatic runtime, a comment mentions `@jsx` mid-sentence, read the graph | live keys include `npm:emo/jsx-runtime.js#jsx` | [precision.test.ts:740](../../test/precision.test.ts#L740) |
| Same, with a `/** @jsxRuntime classic */` pragma | that key drops out | [precision.test.ts:744](../../test/precision.test.ts#L744) |

</details>

## `require.context` and `import.meta.webpackContext`

byakugan reads the directory and the file pattern off the call. Files that
match count, and so does a file added to or deleted from that directory.

```ts
// src/main.ts
const icons = require.context('./icons', false, /\.svg$/);
export const names = icons.keys();
// files: src/icons/a.svg, src/icons/b.svg, src/other/c.svg
```

| Affected | Unaffected |
| --- | --- |
| Edit `src/icons/a.svg`. Reason `src/icons/a.svg` [precision.test.ts:803](../../test/precision.test.ts#L803) | Edit `src/other/c.svg` [precision.test.ts:810](../../test/precision.test.ts#L810) |

<details>
<summary>5 more cases</summary>

| Change | Result | Test |
| --- | --- | --- |
| Delete `src/icons/b.svg` | affected, the detail says the file was "inside a directory the code reads" | [precision.test.ts:816](../../test/precision.test.ts#L816) |
| Add `src/icons/d.svg` | affected | [precision.test.ts:822](../../test/precision.test.ts#L822) |
| The `require.context` call sits in an exported function nothing uses, edit a.svg | unaffected | [precision.test.ts:827](../../test/precision.test.ts#L827) |
| Use `import.meta.webpackContext('./icons', ...)` instead, edit a.svg | affected | [precision.test.ts:840](../../test/precision.test.ts#L840) |
| Hold the directory in a variable, as in `require.context(dir, ...)` | warns `src/main.ts: cannot follow` | [precision.test.ts:849](../../test/precision.test.ts#L849) |

</details>

## Deep code and long chains

Deep nesting and long import chains keep the per-declaration split. A file too
deep to split falls back to one hash for the whole file, with a warning, so any
edit in it counts.

```ts
// src/payload.ts
export const x = [[[[ /* 3,000 levels */ ]]]];   // nothing imports x
export const run = () => console.log('v1');      // src/index.ts uses run
```

| Affected | Unaffected |
| --- | --- |
| `'v1'` to `'v2'` in `run` [security.test.ts:752](../../test/security.test.ts#L752) | `[]` to `[1]` inside the unused deep array [security.test.ts:759](../../test/security.test.ts#L759) |

<details>
<summary>13 more cases</summary>

| Setup and change | Result | Test |
| --- | --- | --- |
| The file above, `'v1'` to `'v2'`, manifest mode | affected | [security.test.ts:766](../../test/security.test.ts#L766) |
| Same, git mode | affected | [security.test.ts:773](../../test/security.test.ts#L773) |
| `[]` to `[1]` inside the unused deep array, git mode | unaffected | [security.test.ts:773](../../test/security.test.ts#L773) |
| A `big` export nested 5,000 arrays deep next to `spare`, edit the innermost value of `big` | affected | [packaging.test.ts:51](../../test/packaging.test.ts#L51) |
| Same, edit `spare` | unaffected | [packaging.test.ts:62](../../test/packaging.test.ts#L62) |
| JSX nested 5,000 `<div>`s deep in `Big` next to `Spare`, edit `Spare` | unaffected | [packaging.test.ts:71](../../test/packaging.test.ts#L71) |
| Same, edit the innermost text of `Big` | affected | [packaging.test.ts:71](../../test/packaging.test.ts#L71) |
| `import('./x/' + a + a + ...)` with 20,000 terms in a used export, edit the unrelated `src/unused.ts` | unaffected | [packaging.test.ts:85](../../test/packaging.test.ts#L85) |
| Same, change `'./x/'` to `'./y/'` | affected | [packaging.test.ts:85](../../test/packaging.test.ts#L85) |
| A file with a 20,000-term expression byakugan cannot analyze, change `unused = 1` to `unused = 2`, an export nothing imports | affected, warns `src/index.ts: ... cannot analyze` | [security.test.ts:782](../../test/security.test.ts#L782) |
| A 10,000-module import chain, edit the unused `spare` in the last module | unaffected | [packaging.test.ts:122](../../test/packaging.test.ts#L122) |
| Same, edit `f9999` in the last module | affected | [packaging.test.ts:122](../../test/packaging.test.ts#L122) |
| A 5,000-module chain of bare `import './m<i>'` lines | `src/m4999.ts` counted, plus `src/index.ts#<imports>` | [security.test.ts:812](../../test/security.test.ts#L812) |
| 200,000 declarations `const a<i> = a<i-1>`, change `a0 = 1` to `a0 = 2` | affected, reason `src/index.ts#a0` | [security.test.ts:843](../../test/security.test.ts#L843) |

</details>

## Comments in a real app

A plain comment does not count. A comment that a tool reads does, such as
`@ts-expect-error`, which changes whether the type check passes.

```ts
// src/lib.ts, main.ts calls add
export function add(a: number, b: number) {
  return a + b;
}
```

| Affected | Unaffected |
| --- | --- |
| Add `// @ts-expect-error` inside `add`. Reason `src/lib.ts#add` [precision.test.ts:1096](../../test/precision.test.ts#L1096) | Add `// the sum` inside `add` [precision.test.ts:1084](../../test/precision.test.ts#L1084) |

<details>
<summary>9 more cases</summary>

| Change | Result | Test |
| --- | --- | --- |
| Change `a + b` to `a - b` | affected, reason `src/lib.ts#add` | [precision.test.ts:1090](../../test/precision.test.ts#L1090) |
| Add `// @ts-expect-error untyped` above the import in main.ts | affected, reason `src/main.ts#<module>` | [precision.test.ts:1102](../../test/precision.test.ts#L1102) |
| Add `// the entry` above the import in main.ts | unaffected | [precision.test.ts:1108](../../test/precision.test.ts#L1108) |
| Add a `{/* the body */}` line in a used JSX component | unaffected | [precision.test.ts:1118](../../test/precision.test.ts#L1118) |
| Change JSX text `Body` to `Body text` | affected, reason `src/view.tsx#View` | [precision.test.ts:1124](../../test/precision.test.ts#L1124) |
| Change `/** @type {number} */` to `{string}` in a .js file, tsconfig has `checkJs: true` | affected, reason `src/parse.js#parse` | [precision.test.ts:1141](../../test/precision.test.ts#L1141) |
| Same edit with only `allowJs: true` | unaffected | [precision.test.ts:1147](../../test/precision.test.ts#L1147) |
| Add comments to a required `legacy.cjs` | unaffected | [precision.test.ts:1158](../../test/precision.test.ts#L1158) |
| Change `base = 2` to `3` in `legacy.cjs` | affected | [precision.test.ts:1164](../../test/precision.test.ts#L1164) |

</details>

## Comments and formatting inside a fragment

Formatting and comments no tool reads drop out of the fragment hash, so running
Prettier over a file changes nothing byakugan sees. Whitespace that JavaScript
reads, comments a tool reads, and parentheses that change precedence or end an
optional chain still count.

| Affected | Unaffected |
| --- | --- |
| A line break after `return`, as in `return\n a + b` [parse.test.ts:246](../../test/parse.test.ts#L246) | Split a call over several lines with a trailing comma [parse.test.ts:230](../../test/parse.test.ts#L230) |

<details>
<summary>57 more cases</summary>

Each row compares the fragment hashes of one `.tsx` file before and after the
edit, unless the row names another file type.

Does not count:

| Change | Result | Test |
| --- | --- | --- |
| Add a line comment inside a function | unaffected | [parse.test.ts:212](../../test/parse.test.ts#L212) |
| Edit a block comment from one line to two | unaffected | [parse.test.ts:213](../../test/parse.test.ts#L213) |
| Add a trailing `// sum` | unaffected | [parse.test.ts:214](../../test/parse.test.ts#L214) |
| Add `/* left */` between tokens | unaffected | [parse.test.ts:215](../../test/parse.test.ts#L215) |
| Label an argument, `g(/* force */ true)` | unaffected | [parse.test.ts:216](../../test/parse.test.ts#L216) |
| Change spaces inside brackets and after commas | unaffected | [parse.test.ts:217](../../test/parse.test.ts#L217) |
| Reindent with tabs, double spaces and trailing spaces | unaffected | [parse.test.ts:218](../../test/parse.test.ts#L218) |
| Add a multi-line doc comment with `@deprecated` on a class method | unaffected | [parse.test.ts:219](../../test/parse.test.ts#L219) |
| Add `// eslint-disable-next-line no-console` | unaffected | [parse.test.ts:220](../../test/parse.test.ts#L220) |
| Add a `{/* note */}` line between JSX elements | unaffected | [parse.test.ts:221](../../test/parse.test.ts#L221) |
| Add `{/* note */}` after a line of JSX text | unaffected | [parse.test.ts:222](../../test/parse.test.ts#L222) |
| Reindent multi-line JSX text | unaffected | [parse.test.ts:223](../../test/parse.test.ts#L223) |
| Join two lines of JSX text with a space | unaffected | [parse.test.ts:224](../../test/parse.test.ts#L224) |
| Add a comment inside a JSX tag, `<a /* why */ b="1" />` | unaffected | [parse.test.ts:225](../../test/parse.test.ts#L225) |
| Add a comment after non-ASCII text `'żółw'` | unaffected | [parse.test.ts:226](../../test/parse.test.ts#L226) |
| Add `/** @type {number} */` in a .js file TypeScript does not check | unaffected | [parse.test.ts:227](../../test/parse.test.ts#L227) |
| Add comments to a .cjs file | unaffected | [parse.test.ts:228](../../test/parse.test.ts#L228) |
| `a+b*2` to `a + b * 2` | unaffected | [parse.test.ts:229](../../test/parse.test.ts#L229) |
| `'a'` to `"a"` | unaffected | [parse.test.ts:231](../../test/parse.test.ts#L231) |
| `b="x"` to `b='x'` in a JSX attribute | unaffected | [parse.test.ts:232](../../test/parse.test.ts#L232) |
| Drop semicolons | unaffected | [parse.test.ts:233](../../test/parse.test.ts#L233) |
| Add trailing commas in objects and arrays | unaffected | [parse.test.ts:234](../../test/parse.test.ts#L234) |
| `a && b \|\| c` to `(a && b) \|\| c` | unaffected | [parse.test.ts:235](../../test/parse.test.ts#L235) |
| `x => x` to `(x) => x` | unaffected | [parse.test.ts:236](../../test/parse.test.ts#L236) |
| `1000` to `1_000` | unaffected | [parse.test.ts:237](../../test/parse.test.ts#L237) |
| Split a JSX tag's attributes over several lines | unaffected | [parse.test.ts:238](../../test/parse.test.ts#L238) |

Counts:

| Change | Result | Test |
| --- | --- | --- |
| `a + b` to `a - b` | affected | [parse.test.ts:245](../../test/parse.test.ts#L245) |
| `return a` to `returna` | affected | [parse.test.ts:247](../../test/parse.test.ts#L247) |
| A line break between `return` and `{}` | affected | [parse.test.ts:248](../../test/parse.test.ts#L248) |
| A multi-line comment right after `return` | affected | [parse.test.ts:249](../../test/parse.test.ts#L249) |
| `'a b'` to `'a  b'` | affected | [parse.test.ts:250](../../test/parse.test.ts#L250) |
| An extra space in a template literal | affected | [parse.test.ts:251](../../test/parse.test.ts#L251) |
| An extra space in a JSX attribute value | affected | [parse.test.ts:252](../../test/parse.test.ts#L252) |
| An extra space inside one line of JSX text | affected | [parse.test.ts:253](../../test/parse.test.ts#L253) |
| Remove `{/* note */}` between two texts in `a{/* note */}b`, which joins them | affected | [parse.test.ts:254](../../test/parse.test.ts#L254) |
| Add `/* #__PURE__ */` before a call | affected | [parse.test.ts:255](../../test/parse.test.ts#L255) |
| Change a `webpackChunkName` | affected | [parse.test.ts:256](../../test/parse.test.ts#L256) |
| A plain comment in `import()` becomes `/* @vite-ignore */` | affected | [parse.test.ts:257](../../test/parse.test.ts#L257) |
| Add `// @ts-expect-error` inside a function | affected | [parse.test.ts:258](../../test/parse.test.ts#L258) |
| Add `{/* @ts-expect-error */}` in JSX | affected | [parse.test.ts:259](../../test/parse.test.ts#L259) |
| Add a legal comment `/*! keep */` | affected | [parse.test.ts:260](../../test/parse.test.ts#L260) |
| Add `/* istanbul ignore next */` | affected | [parse.test.ts:261](../../test/parse.test.ts#L261) |
| Add `// @ts-expect-error untyped` above an import | affected | [parse.test.ts:262](../../test/parse.test.ts#L262) |
| Add `// @ts-nocheck` at the top | affected | [parse.test.ts:263](../../test/parse.test.ts#L263) |
| Add `/** @vitest-environment jsdom */` at the top | affected | [parse.test.ts:264](../../test/parse.test.ts#L264) |
| Add `/** @type {number} */` inside a function in a .js file, with `checkJs` | affected | [parse.test.ts:265](../../test/parse.test.ts#L265) |
| Add `/** @type {number} */` above a declaration in a .js file, with `checkJs` | affected | [parse.test.ts:266](../../test/parse.test.ts#L266) |
| Change a JSDoc cast type in a .js file that starts with `// @ts-check` | affected | [parse.test.ts:267](../../test/parse.test.ts#L267) |
| `require('a')` to `require('b')` in a .cjs file | affected | [parse.test.ts:268](../../test/parse.test.ts#L268) |
| Add `/* #__PURE__ */` in a .cjs file | affected | [parse.test.ts:269](../../test/parse.test.ts#L269) |
| `(a + b) * 2` to `a + b * 2` | affected | [parse.test.ts:270](../../test/parse.test.ts#L270) |
| `(a?.b).c` to `a?.b.c` | affected | [parse.test.ts:271](../../test/parse.test.ts#L271) |
| Move `#__PURE__` from `a(b())` to the inner `b()` | affected | [parse.test.ts:272](../../test/parse.test.ts#L272) |
| ``String.raw`\n` `` to a real newline | affected | [parse.test.ts:273](../../test/parse.test.ts#L273) |
| `1e999`, which is `Infinity`, to `null` | affected | [parse.test.ts:274](../../test/parse.test.ts#L274) |
| `1n`, a bigint, to `1` | affected | [parse.test.ts:275](../../test/parse.test.ts#L275) |
| Add a comment inside a function in a file under `node_modules` | affected | [parse.test.ts:281](../../test/parse.test.ts#L281) |

</details>

A build that keeps comments or layout still emits different files after the
unaffected edits. See [limits](../limits.md), "Comments and formatting in
build output".
