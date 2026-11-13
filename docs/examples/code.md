# Exports, barrels and code

This page covers edits inside project source files. It shows which exports,
imports, top-level statements and comments count, and which do not.

[All examples](README.md)

Every row runs in the default `behavior` mode. Most rows commit a small app with
`src/main.ts` as the entry, edit the working tree and run git mode against
`main`. A row that names a reason shows the key the test asserts.

## An unused export next to a used one

byakugan splits a file into declarations and counts only the ones the app
reaches. A private helper counts when a used export calls it, and the reason
names the helper, not the file.

```ts
// src/utils.ts
const pad = (n: number) => String(n).padStart(2, '0');
export function formatDate(date: Date) { return `${date.getFullYear()}-${pad(date.getMonth() + 1)}`; }
export function formatMoney(value: number) { return `$${value.toFixed(2)}`; }
export const cn = (...names: string[]) => names.join(' ');

// src/main.tsx imports formatDate from './utils', and Button uses cn
```

| Change | Result | Test |
| --- | --- | --- |
| Edit `formatMoney`, which nothing imports | unaffected | [graph.test.ts:69](../../test/graph.test.ts#L69), [cli.test.ts:49](../../test/cli.test.ts#L49) |
| Edit `pad`, which `formatDate` calls | affected, reason `src/utils.ts#pad` | [graph.test.ts:70](../../test/graph.test.ts#L70), [cli.test.ts:49](../../test/cli.test.ts#L49) |
| Add a comment `// money` before `formatMoney` | unaffected | [graph.test.ts:71](../../test/graph.test.ts#L71) |
| No edit, read the graph | `src/utils.ts#formatDate`, `#pad` and `#cn` live, `#formatMoney` not | [graph.test.ts:27](../../test/graph.test.ts#L27) |

## Deleting or renaming an export

Deleting an export, or dropping its `export` keyword, counts only when some
module imports that name.

```ts
// src/main.ts
import { price } from './lib';
console.log(price(2));

// src/lib.ts
export const price = (n: number) => n * 2;
export const other = 1;
```

| Change | Result | Test |
| --- | --- | --- |
| Delete `price` | affected, reason `src/lib.ts#price` | [precision.test.ts:46](../../test/precision.test.ts#L46) |
| Delete `other` | unaffected | [precision.test.ts:52](../../test/precision.test.ts#L52) |
| Drop the `export` keyword from `price` | affected, reason `src/lib.ts#price` | [precision.test.ts:57](../../test/precision.test.ts#L57) |
| Drop the `export` keyword from `other` | unaffected | [precision.test.ts:63](../../test/precision.test.ts#L63) |
| Rename `price` to `cost` while main.ts still imports `price` | affected | [precision.test.ts:68](../../test/precision.test.ts#L68) |

## Exports used only as types

A declaration the app reaches through `import type` counts. An interface nobody
imports does not.

```ts
// src/main.ts
import type { Props } from './lib';
export const p: Props = { a: 1 };

// src/lib.ts
export interface Props { a: number }
export const other = 1;
```

| Change | Result | Test |
| --- | --- | --- |
| Basic fixture, edit `Props` in src/types.ts, which main.tsx imports with `import type` | affected | [graph.test.ts:74](../../test/graph.test.ts#L74) |
| Basic fixture, edit `Unused` in the same file, which nothing imports | unaffected | [graph.test.ts:73](../../test/graph.test.ts#L73) |
| Delete `interface Props` | affected, reason `src/lib.ts#Props` | [precision.test.ts:73](../../test/precision.test.ts#L73) |
| Delete the whole `src/lib.ts`, which holds only `Props` | affected, reason `src/lib.ts` | [precision.test.ts:92](../../test/precision.test.ts#L92) |
| Same, with the file at `src/lib/index.ts` or imported as `./lib.js` | affected | [precision.test.ts:98](../../test/precision.test.ts#L98) |
| Delete `src/spare.ts`, which nothing imports | unaffected | [precision.test.ts:105](../../test/precision.test.ts#L105) |

Once `lib.ts` is gone, the `import type` line that no longer resolves only
warns. Git mode still reports the deletion.

## Exports of an entry

Every export of an entry counts, because a framework may read it. A Next.js
route handler exports `GET`, `POST` and `revalidate`, and no project file
imports them.

```ts
// src/main.ts, the entry
export const revalidate = 60;
export function GET() { return 'ok'; }
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

| Change | Result | Test |
| --- | --- | --- |
| Delete the default export while main.ts does `import Page from './page'` | affected, reason `src/page.ts#Page` | [precision.test.ts:136](../../test/precision.test.ts#L136) |
| Delete the default export while main.ts imports only `{ x }` | unaffected | [precision.test.ts:145](../../test/precision.test.ts#L145) |

## Barrels

A barrel line counts when a name the app imports passes through it. A named
re-export of a component nobody imports stays out of the graph, and so does an
`export *` line that forwards only unused names.

Every module behind an `export *` still runs when the barrel runs. Its
top-level statements count even when the app uses none of its exports. See
[limits](../limits.md), "Modules a barrel loads still run".

```ts
// src/components/index.ts
export * from './Button';
export * from './Modal';
export { Card } from './Card';

// src/components/Button.tsx, imported by the app through the barrel
Button.displayName = 'Button';

// src/components/Modal.tsx, imported by nobody
export function Modal() { return <div>{formatMoney(10)}</div>; }
Modal.displayName = 'Modal';
```

| Change | Result | Test |
| --- | --- | --- |
| Edit `Button` | affected | [graph.test.ts:68](../../test/graph.test.ts#L68) |
| Edit `Modal` | unaffected | [graph.test.ts:67](../../test/graph.test.ts#L67) |
| Change `Button.displayName` | affected | [graph.test.ts:79](../../test/graph.test.ts#L79) |
| Change `Modal.displayName` | unaffected | [graph.test.ts:78](../../test/graph.test.ts#L78) |
| Append `console.log('loaded')` to `Modal.tsx` | affected | [graph.test.ts:80](../../test/graph.test.ts#L80) |
| No edit, read the graph | `index.ts#export*:./Button` and `Button.tsx#Button` live. `export*:./Modal` and everything in `Modal.tsx` and `Card.tsx` not | [graph.test.ts:34](../../test/graph.test.ts#L34) |

The same rule holds one file down. Here main.ts imports `price` through
`src/index.ts`.

```ts
// src/main.ts
import { price } from './index';

// src/index.ts
export * from './lib';

// src/lib.ts
export const price = (n: number) => n * 2;
export const other = 1;
```

| Change | Result | Test |
| --- | --- | --- |
| Delete `price` from lib.ts | affected | [precision.test.ts:179](../../test/precision.test.ts#L179) |
| Drop `export` from `price` in lib.ts | affected | [precision.test.ts:184](../../test/precision.test.ts#L184) |
| Delete `other` from lib.ts | unaffected | [precision.test.ts:189](../../test/precision.test.ts#L189) |

### `export *` in an entry

An entry passes on every name its `export *` lines forward, so they all count.
`export *` never forwards a default export, so a default export behind it does
not count, even in an entry.

```ts
// src/main.ts, the entry
export * from './config';
export const GET = () => 'ok';

// src/config.ts
export const revalidate = 60;
export const dynamic = 'force-static';
```

| Change | Result | Test |
| --- | --- | --- |
| Delete `revalidate` from config.ts | affected | [precision.test.ts:195](../../test/precision.test.ts#L195) |
| Delete `export default function unused()` from config.ts | unaffected | [precision.test.ts:207](../../test/precision.test.ts#L207) |
| Delete `revalidate` two hops away, main.ts to mid.ts to config.ts | affected, reason `src/config.ts#revalidate` | [precision.test.ts:225](../../test/precision.test.ts#L225) |
| Delete the default export two hops away | unaffected | [precision.test.ts:231](../../test/precision.test.ts#L231) |
| Delete `b` inside an `export *` cycle, a.ts and b.ts re-export each other | affected, reason `src/b.ts#b` | [precision.test.ts:236](../../test/precision.test.ts#L236) |
| Delete `z` behind `export * as ns from './lib'` then `export * from './deep'` | affected, reason `src/deep.ts#z` | [precision.test.ts:245](../../test/precision.test.ts#L245) |

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

// src/barrel.ts, before
export * from './one';

// src/barrel.ts, after
export * from './one';
export * from './two';
```

| Change | Result | Test |
| --- | --- | --- |
| Add the line when two.ts exports only `b`, also with one more barrel in front of barrel.ts | unaffected | [precision.test.ts:278](../../test/precision.test.ts#L278) |
| Add the line when two.ts also exports `a` | affected, reason `src/barrel.ts#export*:./two` | [precision.test.ts:284](../../test/precision.test.ts#L284) |
| Add the line when main.ts does `import * as ns from './barrel'` | affected | [precision.test.ts:290](../../test/precision.test.ts#L290) |
| Add the line when two.ts sets `globalThis.ready = true` | affected, reason `src/barrel.ts#<imports>` | [precision.test.ts:295](../../test/precision.test.ts#L295) |
| Add `export * from './nope'`, a file that does not exist | affected | [precision.test.ts:301](../../test/precision.test.ts#L301) |
| Change an existing `export * from './two'` to `export type * from './two'` | affected | [precision.test.ts:306](../../test/precision.test.ts#L306) |

### `export type *`

`export type *` forwards types and runs nothing, so the top-level code of the
module behind it does not count.

```ts
// src/main.ts
import type { Event } from './index';
import { track } from './index';

// src/index.ts
export type * from './analytics';    // analytics.ts logs at the top level
export { track } from './track';
```

| Change | Result | Test |
| --- | --- | --- |
| Change `export type *` to `export *` | affected, reasons include `src/index.ts#export*:./analytics` | [precision.test.ts:562](../../test/precision.test.ts#L562) |
| Edit the `console.log` in analytics.ts | unaffected | [precision.test.ts:569](../../test/precision.test.ts#L569) |

### `export *` cycles and long chains

byakugan follows `export *` lines through cycles and through thousands of
modules, and still counts only the names the app takes.

```ts
// src/a.ts
export const a = 1;
export * from './b';

// src/b.ts
export const b = 2;
export * from './a';

// src/index.ts imports b through d.ts (export * from './a')
// and a through c.ts (export * from './b')
```

| Setup and change | Result | Test |
| --- | --- | --- |
| The cycle above, no edit | `src/b.ts#b` live | [packaging.test.ts:155](../../test/packaging.test.ts#L155) |
| A 200-module `export *` chain into a 10-module cycle, the app imports `v0`, `v9`, `v4` and `v6` through different entry points | all four live, no warnings | [packaging.test.ts:180](../../test/packaging.test.ts#L180) |
| Same, edit `v3` in `c3.ts`, which nothing imports | unaffected | [packaging.test.ts:186](../../test/packaging.test.ts#L186) |
| Same, edit `v6` in `c6.ts` | affected | [packaging.test.ts:186](../../test/packaging.test.ts#L186) |
| A 3,000-module `export *` chain, each module also exports `v<i>`, edit `v5` in `m5.ts` | unaffected | [packaging.test.ts:103](../../test/packaging.test.ts#L103) |
| Same, edit `leaf` at the end of the chain | affected | [packaging.test.ts:103](../../test/packaging.test.ts#L103) |
| A 3,000-module `export *` chain, the entry imports `leaf` from the first module | `src/m2999.ts#leaf` live, `src/m2999.ts#other` not | [security.test.ts:802](../../test/security.test.ts#L802) |

## Namespace imports

byakugan reads `ns.price` as a use of `price` alone. A namespace that comes
through `export * as ns` in a barrel counts whole, so every export behind it
counts.

```ts
// src/main.ts
import * as ns from './lib';
export const r = ns.price(1);
```

| Change | Result | Test |
| --- | --- | --- |
| Delete `price` | affected, reason `src/lib.ts#price` | [precision.test.ts:318](../../test/precision.test.ts#L318) |
| Delete `other`, which main.ts never reads | unaffected | [precision.test.ts:324](../../test/precision.test.ts#L324) |
| Delete `price` when main.ts reads it as `ns.price` through `export * as ns from './lib'` in a barrel | affected, reason `src/lib.ts#price` | [precision.test.ts:331](../../test/precision.test.ts#L331) |
| Edit `lower` in the basic fixture, where main.tsx reads only `strings.upper` | unaffected | [graph.test.ts:72](../../test/graph.test.ts#L72) |
| No edit, read the graph | `src/strings.ts#upper` live, `#lower` not | [graph.test.ts:42](../../test/graph.test.ts#L42) |

### `import()`

`import()` hands the whole namespace to the caller. Every export of the target
counts, and its non-exported locals do not.

```ts
// src/main.ts
const m = await import('./lib');
console.log(m);
```

| Change | Result | Test |
| --- | --- | --- |
| Delete the export `price` from lib.ts | affected, reason `src/lib.ts#price` | [precision.test.ts:160](../../test/precision.test.ts#L160) |
| Delete a non-exported `const spare` from lib.ts | unaffected | [precision.test.ts:166](../../test/precision.test.ts#L166) |

### `import lib = require()` in TypeScript

byakugan reads `lib.price` as a member access, the same as `ns.price`, so it
tracks one export.

```ts
// src/main.ts
import lib = require('./lib');
console.log(lib.price);
```

| Change | Result | Test |
| --- | --- | --- |
| Change `price = 1` to `price = 3` | affected, reason `src/lib.ts#price` | [precision.test.ts:1336](../../test/precision.test.ts#L1336) |
| Change `other = 2` to `other = 4` | unaffected | [precision.test.ts:1342](../../test/precision.test.ts#L1342) |

## Imports that run modules

Importing a module runs it, whether or not the app uses the binding. Adding or
removing an import counts when the target, or a module it imports, has
top-level code. byakugan records the ordered effectful imports of a module in
its `<imports>` fragment.

```ts
// src/main.ts
import { Used } from './components';
console.log(Used);

// src/components.ts
import { X } from './some-module';   // the import being added or removed
export const Used = 1;
export const Unused = () => X;       // only an unused export reads X
```

`analytics.ts` has `console.log('tracking')` at the top. `fancy.ts` imports
`./fancy.css`. `pure.ts` only declares `export const pure = 1`.

| Change | Result | Test |
| --- | --- | --- |
| Remove an import of `./fancy` | affected, reason `src/components.ts#<imports>` | [precision.test.ts:461](../../test/precision.test.ts#L461) |
| Remove an import of `./pure` | unaffected | [precision.test.ts:467](../../test/precision.test.ts#L467) |
| Add an import of `./analytics` | affected, reason `src/components.ts#<imports>` | [precision.test.ts:472](../../test/precision.test.ts#L472) |
| Add an import of `./pure` | unaffected | [precision.test.ts:478](../../test/precision.test.ts#L478) |
| Add an import of `./mid`, which imports `./analytics` | affected | [precision.test.ts:483](../../test/precision.test.ts#L483) |
| Add an import of `./analytics` when main.ts already has `import './analytics'` | unaffected | [precision.test.ts:491](../../test/precision.test.ts#L491) |
| Add an import of package `tracker`, whose `index.js` logs at the top level | affected | [precision.test.ts:502](../../test/precision.test.ts#L502) |
| Same, with `"sideEffects": false` in tracker's package.json | unaffected | [precision.test.ts:507](../../test/precision.test.ts#L507) |
| Swap `import { a } from './a'` and `import { b } from './b'`, both log | affected, reason `src/components.ts#<imports>` | [precision.test.ts:520](../../test/precision.test.ts#L520) |
| Swap the same imports when a.ts and b.ts only declare things | unaffected | [precision.test.ts:529](../../test/precision.test.ts#L529) |

### Runtime modules

The runtime provides `bun` and `cloudflare:workers`, so the bundle never ran
their code. Dropping an unused import of one does not count.

```ts
// src/mid.ts, imported by main.ts for `a`
import { x } from '<from>';
export const a = 1;
export const unused = () => x;

// src/effect.ts
console.log('effect');
export const x = 1;
```

| Change | Result | Test |
| --- | --- | --- |
| `<from>` is `bun` or `cloudflare:workers`, drop the import | unaffected | [git-mode.test.ts:479](../../test/git-mode.test.ts#L479) |
| `<from>` is `./effect`, drop the import | affected | [git-mode.test.ts:487](../../test/git-mode.test.ts#L487) |

### Removing an import

Git mode checks a removed import against the base side, since that side ran
the module. A bare import of a module that runs belongs to the importer's
`<module>` fragment, so removing it counts even when the target is empty.

```ts
// src/main.ts
import './polyfill';
import { price } from './lib';
console.log(price(1));

// src/lib.ts
import './register';          // register.ts is `export {};`
const rate = 2;
export const price = (n: number) => n * rate;
export const legacy = () => 'old';
```

| Change | Result | Test |
| --- | --- | --- |
| Delete `import './polyfill';` from main.ts | affected, reason `src/main.ts#<module>` | [affected.test.ts:203](../../test/affected.test.ts#L203) |
| Delete `import './register';` from lib.ts | affected, reason `src/lib.ts#<module>` removed | [affected.test.ts:211](../../test/affected.test.ts#L211) |
| Delete the unused `legacy` export | unaffected | [affected.test.ts:219](../../test/affected.test.ts#L219) |
| Then delete `const rate = 2;`, which `price` still names | affected, reason `src/lib.ts#rate` removed | [affected.test.ts:219](../../test/affected.test.ts#L219) |

### Removed imports whose target also changed

If git mode checked the removed target in the working tree, where it is gone or
now pure, it would call these unaffected. The base side ran the side effect, so
the removal counts.

```ts
// src/components.ts
import { Fancy } from './fancy';     // fancy.ts: console.log('fancy boot')
export const Used = 1;
export const Unused = () => Fancy;
```

Each change removes the import line from components.ts, plus the change listed.

| Change | Result | Test |
| --- | --- | --- |
| Also delete fancy.ts | affected | [precision.test.ts:929](../../test/precision.test.ts#L929) |
| Also remove the `console.log` from fancy.ts | affected | [precision.test.ts:934](../../test/precision.test.ts#L934) |
| The target is pure.ts, deleted along with the import | unaffected | [precision.test.ts:939](../../test/precision.test.ts#L939) |
| The target is package `tracker` with `"sideEffects": false` | unaffected | [precision.test.ts:947](../../test/precision.test.ts#L947) |
| components.ts imports an unchanged mid.ts, which imports fancy.ts, and fancy.ts loses its side effect | affected | [precision.test.ts:967](../../test/precision.test.ts#L967) |
| Same chain, and fancy.ts is deleted | affected | [precision.test.ts:972](../../test/precision.test.ts#L972) |

### Removed imports whose target moved

In each affected row `./fancy` resolves to a different file in the working tree
than on `main`. The file that ran the side effect is the one on `main`.

| Change | Result | Test |
| --- | --- | --- |
| Also rename `fancy.ts` to `fancy.tsx` | affected | [precision.test.ts:990](../../test/precision.test.ts#L990) |
| The target is `pure.ts`, renamed to `pure.tsx` | unaffected | [precision.test.ts:996](../../test/precision.test.ts#L996) |
| Also move `fancy/index.ts` to `fancy.ts` | affected | [precision.test.ts:1004](../../test/precision.test.ts#L1004) |
| The import goes through a tsconfig alias `@/fancy`, and fancy.ts becomes fancy.tsx | affected | [precision.test.ts:1011](../../test/precision.test.ts#L1011) |
| components.ts imports mid.ts, which has `export * from './fancy'`, and fancy.ts becomes a side-effect-free fancy.tsx | affected | [precision.test.ts:1025](../../test/precision.test.ts#L1025) |
| Add a pure `fancy.ts` next to `fancy/index.ts`, so `./fancy` now resolves to the new file | affected | [precision.test.ts:1038](../../test/precision.test.ts#L1038) |
| Delete fancy.ts, so `./fancy` now resolves to an unchanged, pure `fancy.js` | affected | [precision.test.ts:1046](../../test/precision.test.ts#L1046) |

### `import()` turned into a static import

main.ts already has `export const load = () => import('./x')`. The change adds
a static `import { ... } from './x'` in components.ts. The module now runs at
startup instead of on demand.

| Change | Result | Test |
| --- | --- | --- |
| The target is `./analytics`, which logs at the top level | affected | [precision.test.ts:541](../../test/precision.test.ts#L541) |
| The target is `./pure` | unaffected | [precision.test.ts:547](../../test/precision.test.ts#L547) |

### Import cycles

A module in an import cycle runs the side effects that any module in the cycle
reaches.

```ts
// src/a.ts
import { b } from './b';
import { c } from './c';   // c.ts may or may not log at the top level
export const a = () => [b, c];

// src/b.ts
import { a } from './a';
export const b = () => a;
```

| Change | Result | Test |
| --- | --- | --- |
| main.ts adds `import { b } from './b'`, used only in an unused local, and c.ts logs | affected, reason `src/main.ts#<imports>` | [precision.test.ts:908](../../test/precision.test.ts#L908) |
| Same import, c.ts has no side effect | unaffected | [precision.test.ts:914](../../test/precision.test.ts#L914) |

Lower-level checks of `graph.effectful` back this up. b.ts reaches the side
effect of c.ts only through the cycle and still reads as effectful
([precision.test.ts:868](../../test/precision.test.ts#L868)). Every member of the cycle gets the same answer
whichever is asked first ([precision.test.ts:879](../../test/precision.test.ts#L879)). A cycle with no side effect
anywhere is not effectful ([precision.test.ts:889](../../test/precision.test.ts#L889), [packaging.test.ts:214](../../test/packaging.test.ts#L214)), and
one with `console.log` in c.ts makes both a.ts and b.ts effectful
([packaging.test.ts:206](../../test/packaging.test.ts#L206)).

### Import order across files

ESM runs imports depth first. An import of a module that already ran still
counts when it moves that module earlier, ahead of code that reads what it
sets.

```ts
// src/main.ts
import './a';     // a.ts imports './x', and x.ts reads globalThis.flag
import './y';     // y.ts imports t.ts, and t.ts sets globalThis.flag = 1
```

| Change | Result | Test |
| --- | --- | --- |
| x.ts adds `import { t } from './t'`, used only in an unused export | affected | [precision.test.ts:1065](../../test/precision.test.ts#L1065) |
| Same edit, but main.ts imports `./y` before `./a` | unaffected | [precision.test.ts:1071](../../test/precision.test.ts#L1071) |

In the second order y.ts already ran t.ts before x.ts, so nothing moves.

## Top-level code that runs on load

### Member assignments

An assignment to a property of a local declaration belongs to that
declaration. An assignment on a DOM node reached through a local is a side
effect of the module.

| Setup and change | Result | Test |
| --- | --- | --- |
| main.ts has `const root = document.documentElement; root.dataset.theme = 'dark'`, change it to `'light'` | affected, reason `src/main.ts#<module>` | [precision.test.ts:578](../../test/precision.test.ts#L578) |
| main.ts has `const app = document.getElementById('app'); app.innerHTML = '<p>a</p>'`, change the HTML | affected | [precision.test.ts:586](../../test/precision.test.ts#L586) |
| ui.ts, imported for another export, has `Modal.displayName = 'Modal'` on an unused function, change it to `'Dialog'` | unaffected | [precision.test.ts:597](../../test/precision.test.ts#L597) |
| ui.ts has `const config = {}; config.debug = true` and nothing uses `config`, change it to `false` | unaffected | [precision.test.ts:603](../../test/precision.test.ts#L603) |
| Same, but `config` is exported and main.ts imports it | affected, reason `src/ui.ts#config` | [precision.test.ts:609](../../test/precision.test.ts#L609) |

### Initializers

A top-level initializer that calls a function runs when the module loads,
whether or not anything uses the result. Calls that byakugan knows only build a
value, such as `cva()` or a call marked `/*#__PURE__*/`, count only when the
result is used. That assumption can miss a call with side effects. See
[limits](../limits.md).

```ts
// src/lib.ts, main.ts imports only `price`
import { cva } from 'class-variance-authority';
import { createStore } from './store';        // createStore writes to globalThis
export const price = (n: number) => n * 2;
export const store = createStore('a');
export const variants = cva('a');
```

| Change | Result | Test |
| --- | --- | --- |
| `createStore('a')` to `createStore('b')` | affected, reason `src/lib.ts#store` | [precision.test.ts:1182](../../test/precision.test.ts#L1182) |
| Edit `createStore` in store.ts | affected | [precision.test.ts:1188](../../test/precision.test.ts#L1188) |
| `cva('a')` to `cva('b')` | unaffected | [precision.test.ts:1193](../../test/precision.test.ts#L1193) |
| `/*#__PURE__*/ createStore('a')` to `'b'` | unaffected | [precision.test.ts:1198](../../test/precision.test.ts#L1198) |
| Edit an unused object literal `{ a: [1, 2].map(n => n * 2) }` and an unused arrow `() => createStore()` | unaffected | [precision.test.ts:1206](../../test/precision.test.ts#L1206) |
| `['a'].map(n => createStore(n))` to `['b']` | affected | [precision.test.ts:1215](../../test/precision.test.ts#L1215) |
| `['a'].map(register)`, where `register` calls `createStore`, to `['b']` | affected | [precision.test.ts:1221](../../test/precision.test.ts#L1221) |
| Same with a `register` that only returns its argument | unaffected | [precision.test.ts:1221](../../test/precision.test.ts#L1221) |
| `Array.prototype.push.call(list, 'a')` to `'b'` | affected | [precision.test.ts:1230](../../test/precision.test.ts#L1230) |
| `Array.isArray(['a'])` to `['b']` | unaffected | [precision.test.ts:1230](../../test/precision.test.ts#L1230) |
| Class field `static s = createStore('a')` to `'b'` | affected | [precision.test.ts:1240](../../test/precision.test.ts#L1240) |
| An unused class with `static n = 1`, changed to `2` | unaffected | [precision.test.ts:1240](../../test/precision.test.ts#L1240) |

### TypeScript syntax that compiles to running code

An `enum` or `namespace` compiles to statements that run. main.ts imports only
`price` from lib.ts, and `reg` writes to `globalThis`.

| Change | Result | Test |
| --- | --- | --- |
| `export enum Level { Low = reg(1) }`, change it to `reg(2)` | affected | [precision.test.ts:1306](../../test/precision.test.ts#L1306) |
| An unused `enum Level { Low = 1, High = Low * 2 }`, change `Low = 1` to `3` | unaffected | [precision.test.ts:1312](../../test/precision.test.ts#L1312) |
| `export namespace Setup { reg(1); }`, change it to `reg(2)` | affected | [precision.test.ts:1318](../../test/precision.test.ts#L1318) |
| An unused namespace that only declares a `const`, a function and an interface, edit both values | unaffected | [precision.test.ts:1324](../../test/precision.test.ts#L1324) |

## Declaration order

Moving a `const`, `let` or class below the top-level code that reads it throws
at runtime, so the move counts. Function declarations are hoisted, and a
reference inside a function body runs later, so order does not matter for them.

```ts
// src/lib.ts, main.ts imports `price`
export const base = 1;
export const price = base * 2;
export const other = 3;
```

| Change | Result | Test |
| --- | --- | --- |
| Move `base` below `price` | affected, reason `src/lib.ts#price` | [precision.test.ts:1257](../../test/precision.test.ts#L1257) |
| Move `other` to the top | unaffected | [precision.test.ts:1263](../../test/precision.test.ts#L1263) |
| Move `class A {}` below `export class B extends A {}` | affected | [precision.test.ts:1268](../../test/precision.test.ts#L1268) |
| Move `function f()` below `export const price = f()` | unaffected | [precision.test.ts:1277](../../test/precision.test.ts#L1277) |
| Move `const x = 1` below a top-level `console.log(x)` | affected | [precision.test.ts:1286](../../test/precision.test.ts#L1286) |
| Swap `const base` and `export const price = () => base` | unaffected | [precision.test.ts:1292](../../test/precision.test.ts#L1292) |

## TypeScript import elision and `verbatimModuleSyntax`

TypeScript drops an import that brings in only types. Under
`verbatimModuleSyntax` it keeps `import { type X }` as a bare import, so the
module still runs. `import type { X }` is dropped either way.

```ts
// src/theme.ts
document.documentElement.dataset.theme = 'dark';
export type Theme = 'dark' | 'light';

// src/main.ts
import { type Theme } from './theme';
export const t: Theme = 'dark';
```

The change edits `'dark'` to `'light'` in the top-level statement of theme.ts.

| Setup | Result | Test |
| --- | --- | --- |
| tsconfig sets `verbatimModuleSyntax: true` | affected, reason `src/theme.ts#<module>` | [precision.test.ts:757](../../test/precision.test.ts#L757) |
| tsconfig without it | unaffected | [precision.test.ts:764](../../test/precision.test.ts#L764) |
| With it, but main.ts uses `import type { Theme }` | unaffected | [precision.test.ts:770](../../test/precision.test.ts#L770) |
| With it, main.ts is `export { type Theme } from './theme'` | affected | [precision.test.ts:779](../../test/precision.test.ts#L779) |
| Set in `tsconfig.base.json`, which `tsconfig.json` extends | affected | [precision.test.ts:784](../../test/precision.test.ts#L784) |

byakugan reads the setting from the app's tsconfig chain only. A workspace
package that sets it in its own tsconfig is a known gap. See
[limits](../limits.md).

## Decorators and class bodies

Decorators run when the class is defined, so a decorator argument counts even
when the app imports no class from the file.

```ts
// src/dec.ts
export const Controller = (path) => (target) => { target.path = path; };
export const Input = (name) => (target, key) => {};

// src/users.ts
import { Controller } from './dec';
@Controller('/users')
export class UserController {}
```

When main.ts imports `UserController`:

| Change | Result | Test |
| --- | --- | --- |
| Change `@Controller('/users')` to `'/admin/users'` | affected, reasons include `src/users.ts#UserController` | [precision.test.ts:355](../../test/precision.test.ts#L355) |
| Remove the decorator | affected | [precision.test.ts:364](../../test/precision.test.ts#L364) |
| Change the argument on `export default class` | affected | [precision.test.ts:370](../../test/precision.test.ts#L370) |

When main.ts only does `import './users'`:

| Change | Result | Test |
| --- | --- | --- |
| Change a class decorator argument | affected | [precision.test.ts:389](../../test/precision.test.ts#L389) |
| Add `@Input('b')` to a field of `class Plain` | affected | [precision.test.ts:395](../../test/precision.test.ts#L395) |
| Edit a `static { console.log('a') }` block | affected | [precision.test.ts:403](../../test/precision.test.ts#L403) |
| Change field `name = 'a'` to `'b'` in an undecorated class | unaffected | [precision.test.ts:410](../../test/precision.test.ts#L410) |
| Edit the argument of a constructor parameter decorator `@Input('a') name` | affected | [precision.test.ts:423](../../test/precision.test.ts#L423) |
| Same on a parameter property `@Input('a') private name` | affected | [precision.test.ts:429](../../test/precision.test.ts#L429) |
| Same on a method parameter `handle(@Input('a') body)` | affected | [precision.test.ts:435](../../test/precision.test.ts#L435) |
| Edit a default `constructor(name = 'a')` with no decorator | unaffected | [precision.test.ts:441](../../test/precision.test.ts#L441) |

## Classic JSX factories and pragmas

With the classic runtime, `<div />` calls the factory, so the factory counts.
With the automatic runtime (`react-jsx`) an imported `h` goes unused, and
editing it does not count.

```tsx
// src/jsx.ts
export const h = (t, p) => ({ t, p });
export const f = (t, p) => [t, p];
export const Fragment = 'frag';

// src/main.tsx, the entry
import { h } from './jsx';
export const App = () => <div />;
```

| Setup and change | Result | Test |
| --- | --- | --- |
| tsconfig `jsx: react, jsxFactory: h`, edit `h` | affected, reason `src/jsx.ts#h` | [precision.test.ts:625](../../test/precision.test.ts#L625) |
| tsconfig `jsx: react-jsx`, edit `h` | unaffected | [precision.test.ts:635](../../test/precision.test.ts#L635) |
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

With `jsxImportSource: 'emo'` in byakugan.json and the automatic runtime, the
live keys include `npm:emo/jsx-runtime.js#jsx` even when a comment mentions
`@jsx` mid-sentence ([precision.test.ts:740](../../test/precision.test.ts#L740)). A `/** @jsxRuntime classic */`
pragma drops that key ([precision.test.ts:744](../../test/precision.test.ts#L744)).

## `require.context` and `import.meta.webpackContext`

byakugan reads the directory and the file pattern off the call. Files that
match count. A file added to or deleted from that directory counts too.

```ts
// src/main.ts
const icons = require.context('./icons', false, /\.svg$/);
export const names = icons.keys();
// files: src/icons/a.svg, src/icons/b.svg, src/other/c.svg
```

| Change | Result | Test |
| --- | --- | --- |
| Edit `src/icons/a.svg` | affected, reason `src/icons/a.svg` | [precision.test.ts:803](../../test/precision.test.ts#L803) |
| Edit `src/other/c.svg` | unaffected | [precision.test.ts:810](../../test/precision.test.ts#L810) |
| Delete `src/icons/b.svg` | affected, the detail says the file was "inside a directory the code reads" | [precision.test.ts:816](../../test/precision.test.ts#L816) |
| Add `src/icons/d.svg` | affected | [precision.test.ts:822](../../test/precision.test.ts#L822) |
| The `require.context` call sits in an exported function nothing uses, edit a.svg | unaffected | [precision.test.ts:827](../../test/precision.test.ts#L827) |
| Use `import.meta.webpackContext('./icons', ...)` instead, edit a.svg | affected | [precision.test.ts:840](../../test/precision.test.ts#L840) |

A directory held in a variable, as in `require.context(dir, ...)`, produces a
`src/main.ts: cannot follow` warning ([precision.test.ts:849](../../test/precision.test.ts#L849)).

## Deep code and long chains

Deep nesting and long import chains keep the per-declaration split. A file too
deep to split falls back to one hash for the whole file, with a warning, so any
edit in it counts.

```ts
// src/payload.ts
export const x = [[[[ /* 3,000 levels */ ]]]];   // nothing imports x
export const run = () => console.log('v1');      // src/index.ts uses run
```

| Setup and change | Result | Test |
| --- | --- | --- |
| The file above, `'v1'` to `'v2'` in `run` | affected | [security.test.ts:752](../../test/security.test.ts#L752) |
| Same, manifest mode | affected | [security.test.ts:766](../../test/security.test.ts#L766) |
| Same, git mode | affected | [security.test.ts:773](../../test/security.test.ts#L773) |
| `[]` to `[1]` inside the unused deep array | unaffected | [security.test.ts:759](../../test/security.test.ts#L759) |
| Same, git mode | unaffected | [security.test.ts:773](../../test/security.test.ts#L773) |
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

## Comments in a real app

A plain comment does not count. A comment that a tool reads does, such as
`@ts-expect-error`, which changes whether the type check passes. JSDoc types
count only when TypeScript checks the file.

```ts
// src/lib.ts, main.ts calls add
export function add(a: number, b: number) {
  return a + b;
}
```

| Change | Result | Test |
| --- | --- | --- |
| Add `// the sum` inside `add` | unaffected | [precision.test.ts:1084](../../test/precision.test.ts#L1084) |
| Change `a + b` to `a - b` | affected, reason `src/lib.ts#add` | [precision.test.ts:1090](../../test/precision.test.ts#L1090) |
| Add `// @ts-expect-error` inside `add` | affected, reason `src/lib.ts#add` | [precision.test.ts:1096](../../test/precision.test.ts#L1096) |
| Add `// @ts-expect-error untyped` above the import in main.ts | affected, reason `src/main.ts#<module>` | [precision.test.ts:1102](../../test/precision.test.ts#L1102) |
| Add `// the entry` above the import in main.ts | unaffected | [precision.test.ts:1108](../../test/precision.test.ts#L1108) |
| Add a `{/* the body */}` line in a used JSX component | unaffected | [precision.test.ts:1118](../../test/precision.test.ts#L1118) |
| Change JSX text `Body` to `Body text` | affected, reason `src/view.tsx#View` | [precision.test.ts:1124](../../test/precision.test.ts#L1124) |
| Change `/** @type {number} */` to `{string}` in a .js file, tsconfig has `checkJs: true` | affected, reason `src/parse.js#parse` | [precision.test.ts:1141](../../test/precision.test.ts#L1141) |
| Same edit with only `allowJs: true` | unaffected | [precision.test.ts:1147](../../test/precision.test.ts#L1147) |
| Add comments to a required `legacy.cjs` | unaffected | [precision.test.ts:1158](../../test/precision.test.ts#L1158) |
| Change `base = 2` to `3` in `legacy.cjs` | affected | [precision.test.ts:1164](../../test/precision.test.ts#L1164) |

## Comments and formatting that do not count

Each row compares the fragment hashes of one file before and after the edit.
The files are `.tsx` unless a row says otherwise. Running Prettier over a file
changes nothing byakugan sees, including quotes, semicolons, the parentheses
Prettier adds and numeric separators.

A build that keeps comments or layout still emits different files after these
edits. See [limits](../limits.md), "Comments and formatting in build output".

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
| Split a call over several lines with a trailing comma | unaffected | [parse.test.ts:230](../../test/parse.test.ts#L230) |
| `'a'` to `"a"` | unaffected | [parse.test.ts:231](../../test/parse.test.ts#L231) |
| `b="x"` to `b='x'` in a JSX attribute | unaffected | [parse.test.ts:232](../../test/parse.test.ts#L232) |
| Drop semicolons | unaffected | [parse.test.ts:233](../../test/parse.test.ts#L233) |
| Add trailing commas in objects and arrays | unaffected | [parse.test.ts:234](../../test/parse.test.ts#L234) |
| `a && b \|\| c` to `(a && b) \|\| c` | unaffected | [parse.test.ts:235](../../test/parse.test.ts#L235) |
| `x => x` to `(x) => x` | unaffected | [parse.test.ts:236](../../test/parse.test.ts#L236) |
| `1000` to `1_000` | unaffected | [parse.test.ts:237](../../test/parse.test.ts#L237) |
| Split a JSX tag's attributes over several lines | unaffected | [parse.test.ts:238](../../test/parse.test.ts#L238) |

## Comments and formatting that count

Whitespace counts where JavaScript reads it. A line break after `return`
triggers automatic semicolon insertion and changes the result. Comments that a
tool reads count: `#__PURE__`, webpack magic comments, `@vite-ignore`,
`@ts-expect-error`, `@ts-nocheck`, `@vitest-environment`, `/*! legal */` and
coverage hints. Parentheses count when they change precedence or end an
optional chain. Files in `node_modules` keep their raw text, comments included.

| Change | Result | Test |
| --- | --- | --- |
| `a + b` to `a - b` | affected | [parse.test.ts:245](../../test/parse.test.ts#L245) |
| A line break after `return`, as in `return\n a + b` | affected | [parse.test.ts:246](../../test/parse.test.ts#L246) |
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
