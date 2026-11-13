# CSS, Sass and Tailwind

Which edits to CSS, Sass, Less and Tailwind make an app affected, and which ones byakugan ignores.

[All examples](README.md)

Every topic starts from these files unless its snippet names another setup, as Tailwind in a workspace and When Tailwind cannot run do:

```text
package.json      { "name": "styled" }
byakugan.json     { "entry": ["src/main.ts"] }
.gitignore        node_modules/
```

## CSS imported from code

A stylesheet counts once code the app runs imports it. A module reached only through `import type` never runs, so the CSS it imports does not ship.

```ts
// src/main.ts
import './a.css';
// src/c.css exists, nothing imports it
```

| Affected | Unaffected |
| --- | --- |
| Edit `src/c.css`, then add `import './c.css'` to `main.ts` [affected.test.ts:256](../../test/affected.test.ts#L256) | Edit `src/c.css` while nothing imports it [affected.test.ts:256](../../test/affected.test.ts#L256) |

<details>
<summary>3 more cases</summary>

| Change | Result | Test |
| --- | --- | --- |
| Edit `src/typed.css`. `typed.ts` imports it, and `main.ts` reaches `typed.ts` only through `import type { Props } from './typed'` | unaffected | [affected.test.ts:264](../../test/affected.test.ts#L264) |
| Edit `src/a.css` in the same project | affected | [affected.test.ts:264](../../test/affected.test.ts#L264) |
| No edit. `main.ts` has `import 'anim'`, a package whose only export is `{ ".": { "style": "./dist/anim.css" } }` | the graph reaches `npm:anim/dist/anim.css`, nothing unresolved | [affected.test.ts:272](../../test/affected.test.ts#L272) |

</details>

## Order of CSS imports

CSS order decides which rule wins, so moving one CSS import past another counts. Moving it past a module that puts no CSS on the page does not.

```ts
// src/main.ts
import './app.css';
import { Header } from './header';      // header.ts imports './header.css'
import styles from './x.module.css';
import { pure } from './pure';          // pure.ts only declares a const
document.body.className = Header + styles.h + pure;
```

| Affected | Unaffected |
| --- | --- |
| Swap `import './app.css'` with `import { Header } from './header'`. Reason `src/main.ts#<imports>` [styles.test.ts:353](../../test/styles.test.ts#L353) | Swap the `x.module.css` import with `import { pure } from './pure'`. Fingerprint equal [styles.test.ts:367](../../test/styles.test.ts#L367) |

<details>
<summary>2 more cases</summary>

| Change | Result | Test |
| --- | --- | --- |
| Swap `import './app.css'` with the `x.module.css` import | affected, reason `src/main.ts#<imports>` | [styles.test.ts:361](../../test/styles.test.ts#L361) |
| In a file that imports `a.css` then `b.css`, swap the two | affected, reason `src/main.ts#<module>` | [affected.test.ts:250](../../test/affected.test.ts#L250) |

</details>

## Stylesheets linked from Vite `index.html`

A `<link>` or `<script>` in `index.html` makes its file an entry. byakugan skips tags inside HTML comments.

```html
<!-- index.html -->
<link href="/src/style.css" rel="stylesheet">
<!-- <link href="/src/old.css" rel="stylesheet"> -->
<script type="module" src="/src/main.ts"></script>
```

| Affected | Unaffected |
| --- | --- |
| Add a rule to `src/style.css`. Reason `src/style.css` [styles.test.ts:161](../../test/styles.test.ts#L161) | Edit `src/old.css`, linked only inside an HTML comment [styles.test.ts:161](../../test/styles.test.ts#L161) |

<details>
<summary>4 more cases</summary>

| Change | Result | Test |
| --- | --- | --- |
| No edit, `src/style.css` is `@import "tailwindcss";` | `src/style.css` is an entry and a Tailwind root, `src/style.css#<tailwind>` is live, `src/old.css` is not an entry | [styles.test.ts:153](../../test/styles.test.ts#L153) |
| Change `'quiet words'` to `'other words'` in `src/unused.ts`, which nobody imports | unaffected | [styles.test.ts:170](../../test/styles.test.ts#L170) |
| Change it to `'skew-y-12'` | affected, reason `src/style.css#<tailwind>` | [styles.test.ts:170](../../test/styles.test.ts#L170) |
| `index.html` has `<!-- <script src="/src/old.ts"> -->` and a live `<script src="/src/main.ts">` | `src/main.ts#main` counts, nothing from `src/old.ts` | [security.test.ts:1074](../../test/security.test.ts#L1074) |

</details>

## What a stylesheet references

byakugan follows every file a stylesheet names through `composes` and `@value` in CSS Modules, Sass `@import` and `@use`, Less `@import`, `url()` and `image-set()`. A file named only in a comment does not count.

```scss
// src/main.scss, imported by src/main.ts
@import 'variables', 'mixins';
// @use 'old';
```

| Affected | Unaffected |
| --- | --- |
| Append a newline to `src/_variables.scss`. Reason `src/_variables.scss` [styles.test.ts:226](../../test/styles.test.ts#L226) | Append a newline to `src/_old.scss`, named only in a `//` comment [styles.test.ts:234](../../test/styles.test.ts#L234) |

<details>
<summary>9 more cases</summary>

Each edit appends a newline to one file and runs git mode.

| Change | Result | Test |
| --- | --- | --- |
| Edit `src/base.module.css`, the target of `composes: base from './base.module.css'` in `src/button.module.css` | affected, reason `src/base.module.css` | [styles.test.ts:226](../../test/styles.test.ts#L226) |
| Edit `src/colors.css`, the target of `@value primary from './colors.css'` | affected, reason `src/colors.css` | [styles.test.ts:226](../../test/styles.test.ts#L226) |
| Edit `src/_mixins.scss`, in the same `@import` list as `variables` | affected, reason is that file | [styles.test.ts:226](../../test/styles.test.ts#L226) |
| Edit `src/_tokens.scss`, named by a `@use 'tokens'` after a rule on the same line | affected, reason `src/_tokens.scss` | [styles.test.ts:226](../../test/styles.test.ts#L226) |
| Edit `src/tokens.less`, named by `@import (reference) "tokens.less"` in `src/theme.less` | affected, reason `src/tokens.less` | [styles.test.ts:226](../../test/styles.test.ts#L226) |
| Edit `src/hero.png` or `src/hero@2x.png`, both in `image-set()` in `src/hero.css` | affected, reason is that file | [styles.test.ts:226](../../test/styles.test.ts#L226) |
| Edit `src/other.module.css`, `src/_unused.scss`, `src/unused.less` or `src/other.png`, which nothing names | unaffected | [styles.test.ts:234](../../test/styles.test.ts#L234) |
| Edit `src/_older.scss` or `src/old.png`, named only in a `/* */` comment or a commented-out `url()` | unaffected | [styles.test.ts:234](../../test/styles.test.ts#L234) |
| `src/app.css` has `.a { background: url("./bg.png"); }`, delete `src/bg.png` | affected, the reason detail says "deleted" | [styles.test.ts:239](../../test/styles.test.ts#L239) |
| Same, delete `src/spare.png`, which no stylesheet names | unaffected | [styles.test.ts:249](../../test/styles.test.ts#L249) |

</details>

## Comments in stylesheets

An `@import` inside a comment does not count, and one after a closed comment does. An unclosed comment runs to the end of the file and hides everything after it.

```css
/* src/app.css */
/* old */ @import './tokens.css';
/* @import './draft.css';
```

| Change | Result | Test |
| --- | --- | --- |
| Edit `src/tokens.css`, imported after a closed comment | affected, reason `src/tokens.css` | [styles.test.ts:1165](../../test/styles.test.ts#L1165) |
| Edit `src/draft.css`, imported only inside the unclosed comment | unaffected | [styles.test.ts:1165](../../test/styles.test.ts#L1165) |
| `src/a.css` holds `/* @import './old.css'; */` then `@import './new.css';` | `src/new.css` counts, `src/old.css` does not | [security.test.ts:1061](../../test/security.test.ts#L1061) |

## Aliases and Sass load paths

byakugan resolves stylesheet paths through tsconfig `paths`, `sassOptions.includePaths` in `next.config.js` and `css.preprocessorOptions.scss.loadPaths` in `vite.config.ts`. Only the file a path resolves to counts, not its siblings.

```scss
// app/page.module.scss, Next.js with tsconfig paths "@/*" -> "./*"
@use '@/styles/variables' as *;
.hero { color: $brand; }
```

| Affected | Unaffected |
| --- | --- |
| Edit `styles/_variables.scss`. Reason `styles/_variables.scss` [styles.test.ts:270](../../test/styles.test.ts#L270) | Edit the sibling `styles/_other.scss`. No unresolved imports [styles.test.ts:270](../../test/styles.test.ts#L270) |

<details>
<summary>6 more cases</summary>

| Setup | Change | Result | Test |
| --- | --- | --- | --- |
| tsconfig `@/*` -> `./src/*`, `@import "@/styles/tokens.css"` in a CSS module | Edit `src/styles/spare.css` | unaffected | [styles.test.ts:284](../../test/styles.test.ts#L284) |
| Same | Edit `src/styles/tokens.css` | affected, reason `src/styles/tokens.css` | [styles.test.ts:284](../../test/styles.test.ts#L284) |
| `next.config.js` has `sassOptions.includePaths: [path.join(__dirname, 'styles')]`, the stylesheet has `@use 'abstracts/colors'` | Edit `styles/abstracts/_spacing.scss` | unaffected | [styles.test.ts:301](../../test/styles.test.ts#L301) |
| Same | Edit `styles/abstracts/_colors.scss` | affected, reason `styles/abstracts/_colors.scss` | [styles.test.ts:301](../../test/styles.test.ts#L301) |
| `vite.config.ts` has `css.preprocessorOptions.scss.loadPaths: ['shared']`, the stylesheet has `@use 'tokens'` | Edit `shared/_spare.scss` | unaffected | [styles.test.ts:314](../../test/styles.test.ts#L314) |
| Same | Edit `shared/_tokens.scss` | affected, reason `shared/_tokens.scss` | [styles.test.ts:314](../../test/styles.test.ts#L314) |

</details>

## Sass `additionalData`, `prependData`, `pkg:` and built-in modules

A partial that the Sass options load into every file counts for every Sass file. An app with no Sass file ignores it.

```ts
// vite.config.ts, with tsconfig "@/*" -> "./src/*"
export default {
  css: { preprocessorOptions: { scss: { additionalData: '@use "@/styles/vars" as *;' } } },
};
```

```scss
// src/card.module.scss, imported by src/main.ts
.card { color: $brand; }
```

| Affected | Unaffected |
| --- | --- |
| Edit `src/styles/_vars.scss`, loaded by `additionalData`. Reason `src/styles/_vars.scss` [styles.test.ts:946](../../test/styles.test.ts#L946) | Edit the sibling partial `src/styles/_other.scss` [styles.test.ts:946](../../test/styles.test.ts#L946) |

<details>
<summary>7 more cases</summary>

| Setup | Change | Result | Test |
| --- | --- | --- | --- |
| The Vite config above | Delete `src/styles/_vars.scss` | affected | [styles.test.ts:955](../../test/styles.test.ts#L955) |
| `additionalData` also has `@use "sass:math";` | Edit `_other.scss` | unaffected, no unresolved import | [styles.test.ts:961](../../test/styles.test.ts#L961) |
| The app imports only `src/app.css` and has no Sass | Edit `_vars.scss` | unaffected | [styles.test.ts:992](../../test/styles.test.ts#L992) |
| Next.js `sassOptions: { includePaths: ['styles'], prependData: '@import "variables";' }` | Edit `styles/_spacing.scss` | unaffected | [styles.test.ts:998](../../test/styles.test.ts#L998) |
| Same | Edit `styles/_variables.scss` | affected, reason `styles/_variables.scss` | [styles.test.ts:998](../../test/styles.test.ts#L998) |
| `@use "pkg:bootstrap/scss/grid"` | Edit `node_modules/bootstrap/scss/_grid.scss` | affected, fingerprint changes | [styles.test.ts:971](../../test/styles.test.ts#L971) |
| `@use "sass:math"` in a stylesheet | No edit | not followed, no unresolved imports, no warnings | [styles.test.ts:985](../../test/styles.test.ts#L985) |

</details>

## `url()` behind an alias, and `@value` paths

A `url()` resolves through tsconfig `paths` like an import. `@value` with a quoted path names a file, and a quoted value that is not a path, such as a font name, stays a string.

```css
/* src/app.css, imported by src/main.ts, with tsconfig paths "@/*" -> "./src/*" */
.hero { background: url("@/assets/hero.png"); }
```

| Affected | Unaffected |
| --- | --- |
| Replace `src/assets/hero.png`. Reason `src/assets/hero.png` [styles.test.ts:1030](../../test/styles.test.ts#L1030) | Replace `src/assets/spare.png` [styles.test.ts:1030](../../test/styles.test.ts#L1030) |

<details>
<summary>8 more cases</summary>

| Change | Result | Test |
| --- | --- | --- |
| Delete `src/assets/hero.png` | affected | [styles.test.ts:1038](../../test/styles.test.ts#L1038) |
| Delete `src/assets/spare.png` | unaffected | [styles.test.ts:1044](../../test/styles.test.ts#L1044) |
| tsconfig has no `@/*` alias, replace `src/assets/hero.png` | affected | [styles.test.ts:1051](../../test/styles.test.ts#L1051) |
| No edit, with the alias tsconfig names | no unresolved import | [styles.test.ts:1057](../../test/styles.test.ts#L1057) |
| `@/*` maps to `./src/*` then `./fallback/*`, delete `src/assets/hero.png` so the alias falls back | affected, fingerprint changes | [styles.test.ts:1073](../../test/styles.test.ts#L1073) |
| Same, delete `fallback/assets/hero.png` while the first target exists | unaffected | [styles.test.ts:1081](../../test/styles.test.ts#L1081) |
| `src/button.module.css` has `@value colors: "./colors.css";` and `@value font: "Inter";`, edit `src/spare.css` | unaffected, `"Inter"` is not a file | [styles.test.ts:1087](../../test/styles.test.ts#L1087) |
| Same, edit `src/colors.css` | affected, reason `src/colors.css` | [styles.test.ts:1087](../../test/styles.test.ts#L1087) |

</details>

With an alias that tsconfig does not define, byakugan cannot resolve the `url()`, and the asset edit still counts. [limits.md](../limits.md) explains why unresolved paths fail closed.

## `@import` from the project root

A path that starts with `/` resolves from the project root, as Vite does it. That works quoted, inside `url()`, without an extension, and in Sass `@use`.

```css
/* src/app.css */
@import "/src/theme.css";
.app { color: red; }
```

| Affected | Unaffected |
| --- | --- |
| Edit `src/theme.css`. Reason `src/theme.css` [styles.test.ts:791](../../test/styles.test.ts#L791) | Edit `src/other.css` [styles.test.ts:797](../../test/styles.test.ts#L797) |

<details>
<summary>5 more cases</summary>

| Change | Result | Test |
| --- | --- | --- |
| With `@import url(/src/theme.css);`, edit `src/theme.css` | affected, reason `src/theme.css` | [styles.test.ts:803](../../test/styles.test.ts#L803) |
| With `@import url(/src/theme.css);`, edit `src/other.css` | unaffected | [styles.test.ts:809](../../test/styles.test.ts#L809) |
| `@import "/src/theme";` with no extension, delete `src/theme.css` | affected, fingerprint changes | [styles.test.ts:820](../../test/styles.test.ts#L820) |
| `@use "/src/styles/vars";` in `src/app.scss`, delete `src/styles/_vars.scss` | affected, fingerprint changes | [styles.test.ts:820](../../test/styles.test.ts#L820) |
| Either setup, delete `src/other.css` | unaffected | [styles.test.ts:828](../../test/styles.test.ts#L828) |

</details>

## Tailwind v4: class names in files nobody imports

Tailwind scans files the app never imports, so byakugan runs the project's Tailwind and hashes the CSS it generates as `<root>.css#<tailwind>`. A file nobody imports counts only when it adds a class that changes that CSS.

```css
/* src/app.css */
@import "tailwindcss";
```

```ts
// src/main.ts
import './app.css';
import { button } from './button';   // export const button = 'flex p-4 text-sm';
document.body.className = button;
```

```ts
// src/unused.ts, never imported, but Tailwind scans it
export const banner = () => ['rounded', 'quiet words'];
```

| Affected | Unaffected |
| --- | --- |
| Add `skew-y-12`, a new class, to `src/unused.ts`. Reason `src/app.css#<tailwind>`, the detail names `src/unused.ts` [tailwind.test.ts:57](../../test/tailwind.test.ts#L57), [tailwind.test.ts:80](../../test/tailwind.test.ts#L80) | Change `'quiet words'` to `'other words'` in `src/unused.ts`. Git mode lists `src/unused.ts` under `ignored` [tailwind.test.ts:57](../../test/tailwind.test.ts#L57), [tailwind.test.ts:80](../../test/tailwind.test.ts#L80) |

<details>
<summary>3 more cases</summary>

| Change | Result | Test |
| --- | --- | --- |
| No edit | `src/app.css#<tailwind>` is live, `src/unused.ts#banner` is not, no warnings | [tailwind.test.ts:50](../../test/tailwind.test.ts#L50) |
| Add `flex` to `src/unused.ts`, a class `button.ts` already uses | unaffected | [tailwind.test.ts:57](../../test/tailwind.test.ts#L57) |
| Add a prose line to `README.md` | unaffected | [tailwind.test.ts:57](../../test/tailwind.test.ts#L57) |

</details>

This counts classes, not rendered markup. A class in a component nobody renders yet still changes the CSS, and [limits.md](../limits.md) lists this.

## Tailwind v4: `@source`

`@source` sets which files Tailwind scans, so it also sets which files can count.

```css
/* src/app.css */
@import "tailwindcss" source(none);
@source "../src";
```

| Affected | Unaffected |
| --- | --- |
| Add `skew-y-12` to `src/unused.ts`, inside `@source`. Fingerprint changes [tailwind.test.ts:70](../../test/tailwind.test.ts#L70) | Add `skew-y-12` to `scripts/seed.ts`, outside `@source` [tailwind.test.ts:70](../../test/tailwind.test.ts#L70) |

## Tailwind v4: deleting scanned files

Deleting a scanned file counts when it held the only use of a class.

```text
src/app.css       one of three forms:
                    automatic source, @import "tailwindcss";
                    source(none) plus @source "../content"; @source "./";
                    @source "../**/*.{md,ts}";
content/rare.md   <div class="skew-y-12">x</div>   only file with this class
content/plain.md  <div class="flex">x</div>        src/main.ts also uses flex
```

| Change | Result | Test |
| --- | --- | --- |
| Delete `content/rare.md` | affected in all three forms, reason `src/app.css#<tailwind>`, the detail names `content/rare.md` | [styles.test.ts:533](../../test/styles.test.ts#L533) |
| Delete `content/plain.md` | unaffected in all three forms | [styles.test.ts:541](../../test/styles.test.ts#L541) |
| With `@source "../content"` only, delete `scripts/seed.md`, which has `skew-y-6` | unaffected | [styles.test.ts:548](../../test/styles.test.ts#L548) |

## Tailwind v4: which stylesheet is the root

The root is the stylesheet code imports, even when `@import "tailwindcss"` sits in a file it imports or in a package. Theme colors and `@utility` rules in the root decide which class names produce CSS.

```css
/* src/app.css, imported by src/main.ts */
@import "./tw.css";
@theme { --color-brand: #f00; }

/* src/tw.css */
@import "tailwindcss";
```

| Affected | Unaffected |
| --- | --- |
| Change `'other words'` to `'bg-brand'` in `src/unused.ts`, the color the root's `@theme` defines. Reason `src/app.css#<tailwind>` [styles.test.ts:390](../../test/styles.test.ts#L390) | Change `'quiet words'` to `'other words'` in `src/unused.ts` [styles.test.ts:390](../../test/styles.test.ts#L390) |

<details>
<summary>5 more cases</summary>

| Setup | Change | Result | Test |
| --- | --- | --- | --- |
| The files above | No edit | the root is `src/app.css#<tailwind>`, not `src/tw.css#<tailwind>` | [styles.test.ts:390](../../test/styles.test.ts#L390) |
| `src/app.css` is `@import "@acme/design/tailwind.css";`, and the package file has `@import "tailwindcss"` and `@theme { --color-brand: #f00; }` | Write `bg-blue`, a color nobody defines, in `src/unused.ts` | unaffected | [styles.test.ts:405](../../test/styles.test.ts#L405) |
| Same | Change it to `bg-brand` | affected, reason `src/app.css#<tailwind>` | [styles.test.ts:405](../../test/styles.test.ts#L405) |
| `src/app.css` is `@import "tailwindcss"; @utility glass { ... }` | Write `glass` in `src/unused.ts` | affected, reason `src/app.css#<tailwind>` | [styles.test.ts:721](../../test/styles.test.ts#L721) |
| Same, plus a `src/legacy.css` nobody imports | Add `/* skew-y-12 */` to `src/legacy.css` | unaffected | [styles.test.ts:727](../../test/styles.test.ts#L727) |

</details>

Tailwind v4 skips stylesheets when it scans for classes. A class name in a `.css` file nobody imports does not count.

## Tailwind v3: content globs

In v3, the `content` globs of `tailwind.config.js` decide which files Tailwind scans.

```js
// tailwind.config.js
module.exports = { content: ['./src/**/*.ts'] };
```

```css
/* src/app.css */
@tailwind utilities;
```

| Affected | Unaffected |
| --- | --- |
| Add `skew-y-12` to `src/unused.ts`. Fingerprint changes [tailwind.test.ts:107](../../test/tailwind.test.ts#L107) | Add a new file `scripts/seed.ts` with `skew-y-12`, outside the globs [tailwind.test.ts:107](../../test/tailwind.test.ts#L107) |

<details>
<summary>6 more cases</summary>

| Setup | Change | Result | Test |
| --- | --- | --- | --- |
| The config above | No edit | `src/app.css#<tailwind>` is live, no warnings | [tailwind.test.ts:107](../../test/tailwind.test.ts#L107) |
| Same | Change `'quiet words'` to `'other words'` in `src/unused.ts` | unaffected | [tailwind.test.ts:107](../../test/tailwind.test.ts#L107) |
| Absolute globs, `content: [path.join(__dirname, 'src/**/*.ts')]` | Write `skew-y-6` in `other/seed.ts`, outside the globs | unaffected | [styles.test.ts:488](../../test/styles.test.ts#L488) |
| Same | Write `skew-y-6` in `src/unused.ts` | affected, reason `src/app.css#<tailwind>` | [styles.test.ts:488](../../test/styles.test.ts#L488) |
| Same | Delete `src/rare.ts`, the only file with `skew-y-12` | affected, reason `src/app.css#<tailwind>`, the detail names `src/rare.ts` | [styles.test.ts:488](../../test/styles.test.ts#L488) |
| Same | Delete `src/copy.ts`, whose only class `flex` also appears in `src/main.ts` | unaffected | [styles.test.ts:507](../../test/styles.test.ts#L507) |

</details>

## Tailwind v3: PostCSS and imported component classes

A component class defined in a file the root imports counts once a scanned file uses it. A class nobody defines does not.

```css
/* src/app.css, with postcss-import in postcss.config.js */
@import "tailwindcss/base";
@import "tailwindcss/components";
@import "./buttons.css";          /* @layer components { .btn-primary { ... } } */
@import "tailwindcss/utilities";
```

| Affected | Unaffected |
| --- | --- |
| Change `btn-secondary` to `btn-primary` in `src/unused.ts`. Reason `src/app.css#<tailwind>` [styles.test.ts:435](../../test/styles.test.ts#L435) | Write `btn-secondary`, which nobody defines, in `src/unused.ts` [styles.test.ts:435](../../test/styles.test.ts#L435) |

<details>
<summary>8 more cases</summary>

| Setup | Change | Result | Test |
| --- | --- | --- | --- |
| No postcss-import, `src/app.css` imports `./base.css` with `@tailwind base` and `./utilities.css` with `@tailwind utilities` | No edit | no warnings, `src/app.css#<tailwind>` live | [styles.test.ts:450](../../test/styles.test.ts#L450) |
| Same | Write `'other words'` in `src/unused.ts` | unaffected | [styles.test.ts:450](../../test/styles.test.ts#L450) |
| Same | Write `'skew-y-12'` in `src/unused.ts` | affected, reason `src/app.css#<tailwind>` | [styles.test.ts:450](../../test/styles.test.ts#L450) |
| `postcss.config.js` points at `./config/tailwind.config.js`, which scans `./src/**/*.ts`. A decoy `tailwind.config.js` at the default path scans `./other/**/*.ts`. The test spells the PostCSS config three ways: `plugins: { tailwindcss: { config } }`, `tailwindcss({ config })` after `require`, and `require('tailwindcss')({ config })` inline | Write `skew-y-12` in `other/seed.ts`, which only the decoy scans | unaffected in all three spellings | [styles.test.ts:471](../../test/styles.test.ts#L471) |
| Same | Write `skew-y-12` in `src/unused.ts` | affected in all three spellings, reason `src/app.css#<tailwind>` | [styles.test.ts:471](../../test/styles.test.ts#L471) |
| Root `postcss.config.js` names `tailwind.a.js`, which scans `src/a`, through `path.join(__dirname, ...)`. `src/b/postcss.config.js` names `tailwind.b.js`, which scans `src/b`. `src/main.ts` imports `src/a/a.css` and `src/b/b.css`, both `@tailwind utilities;` | Add `skew-y-12` to `src/a/x.ts` | affected, fingerprint changes | [tailwind.test.ts:249](../../test/tailwind.test.ts#L249) |
| Same, with `"postcssFromStylesheet": true` | Add `skew-y-12` to `src/b/y.ts` | affected, fingerprint changes | [tailwind.test.ts:256](../../test/tailwind.test.ts#L256) |
| Same, without that option | Add `skew-y-12` to `src/b/y.ts` | unaffected | [tailwind.test.ts:263](../../test/tailwind.test.ts#L263) |

</details>

By default every stylesheet uses the project's root PostCSS config. Set `"postcssFromStylesheet": true` in byakugan.json if your build picks the config nearest each stylesheet.

## Tailwind v3 in Vite

Vite runs its own postcss-import before the PostCSS plugins, so an imported component class counts even when no PostCSS config names postcss-import.

```js
// postcss.config.cjs
module.exports = { plugins: { tailwindcss: {} } };
// tailwind.config.cjs
module.exports = { content: ['./index.html', './src/**/*.ts'] };
```

```css
/* src/buttons.css */
@layer components { .btn-primary { color: red; } }

/* src/app.css pulls in buttons.css one of five ways:
   @import "./buttons.css"
   the Tailwind layer imports, such as @import "tailwindcss/base"
   @import url(./buttons.css)
   @import "/src/buttons.css"
   @import url(/src/buttons.css) */
```

| Change | Result | Test |
| --- | --- | --- |
| Write `btn-secondary` in `src/unused.ts` | unaffected in all five, no warnings | [styles.test.ts:762](../../test/styles.test.ts#L762) |
| Change it to `btn-primary` | affected in all five, reason `src/app.css#<tailwind>` | [styles.test.ts:762](../../test/styles.test.ts#L762) |
| With `@import url(/src/buttons.css)` and `btn-primary` used in `src/main.ts`, change `red` to `blue` in `src/buttons.css` | affected, fingerprint changes | [styles.test.ts:774](../../test/styles.test.ts#L774) |

## Tailwind v3 root written in Sass

With sass installed, byakugan compiles the Sass first and runs Tailwind on the result.

```scss
// src/app.scss
@import 'buttons';          // _buttons.scss: @layer components { .btn-primary {...} }
@tailwind base;
@tailwind components;
@tailwind utilities;
```

| Affected | Unaffected |
| --- | --- |
| Change `btn-secondary` to `btn-primary` in `src/unused.ts`. Reason `src/app.scss#<tailwind>` [styles.test.ts:856](../../test/styles.test.ts#L856) | Write `btn-secondary` in `src/unused.ts`. No warnings [styles.test.ts:856](../../test/styles.test.ts#L856) |

<details>
<summary>5 more cases</summary>

| Setup | Change | Result | Test |
| --- | --- | --- | --- |
| Directives in the partial `_tailwind.scss`, `app.scss` is `@import 'tailwind'; @import 'buttons';` | Write `btn-primary` | affected, reason `src/app.scss#<tailwind>` | [styles.test.ts:878](../../test/styles.test.ts#L878) |
| Same | Write `btn-secondary` | unaffected | [styles.test.ts:884](../../test/styles.test.ts#L884) |
| Directives in a plain `src/tw.css`, `app.scss` is `@import "./tw.css"; .app {...}` | Write `flex` in `src/unused.ts` | affected, fingerprint changes | [styles.test.ts:904](../../test/styles.test.ts#L904) |
| Same | Write `other words` | unaffected | [styles.test.ts:912](../../test/styles.test.ts#L912) |
| Directives in `app.scss`, sass not installed | Write `other words` | affected, warns "could not run Tailwind" | [styles.test.ts:918](../../test/styles.test.ts#L918) |

</details>

In the plain-CSS case, `flex` counts even though `src/main.ts` sets no class. Sass leaves `@import "./tw.css"` alone, so Tailwind compiles `tw.css` on its own, and that output gains the `flex` rule.

## Tailwind and `.gitignore`

v4 automatic source detection skips git-ignored files, so a `.gitignore` edit can change which classes exist. v3 content globs do not read `.gitignore`.

| Affected | Unaffected |
| --- | --- |
| v4 root with `@import "tailwindcss"`, `src/legacy/old.ts` has `skew-y-12`. Add `src/legacy/` to `.gitignore`. Reason `.gitignore` [styles.test.ts:1123](../../test/styles.test.ts#L1123) | The same edit with a v3 root, `content: ['./src/**/*.ts']` [styles.test.ts:1139](../../test/styles.test.ts#L1139) |

## Tailwind in a workspace

Tailwind often scans a workspace package through a `node_modules` link. byakugan follows the link and reads the base side of the linked file in git mode.

```text
apps/web/src/app.css             v4: @import "tailwindcss"; @source "../node_modules/@acme/ui/src";
                                 v3: tailwind.config.js content includes './node_modules/@acme/ui/src/**/*.ts'
apps/web/node_modules/@acme/ui -> ../../../../packages/ui   (symlink)
packages/ui/src/card.ts          export const card = () => ['rounded', 'quiet words'];
```

| Affected | Unaffected |
| --- | --- |
| Add `skew-y-12` to `packages/ui/src/card.ts`. Affected in v3 and v4, reason `apps/web/src/app.css#<tailwind>` [tailwind.test.ts:155](../../test/tailwind.test.ts#L155) | Change `'quiet words'` to `'other words'` in `packages/ui/src/card.ts`. Unaffected in v3 and v4 [tailwind.test.ts:155](../../test/tailwind.test.ts#L155) |

<details>
<summary>3 more cases</summary>

| Setup | Change | Result | Test |
| --- | --- | --- | --- |
| The package linked a second time as `@acme/ui-again`, Tailwind scans both paths | Add `skew-y-12` to `card.ts` | affected in v3 and v4, fingerprint changes | [tailwind.test.ts:165](../../test/tailwind.test.ts#L165) |
| `"tailwindDir": "../../apps/host"` in the package's byakugan.json, the host config also scans `apps/host/stories` | Add `skew-y-12` to `apps/host/stories/card.ts` | affected, fingerprint changes | [tailwind.test.ts:211](../../test/tailwind.test.ts#L211) |
| Same project without `tailwindDir` | Same edit | unaffected | [tailwind.test.ts:218](../../test/tailwind.test.ts#L218) |

</details>

A package such as `packages/ui` may get its Tailwind config from the app that hosts it. `"tailwindDir"` in the package's byakugan.json compiles its stylesheets with that directory's configs.

## When Tailwind cannot run

If Tailwind fails, byakugan hashes every file Tailwind might scan whole and warns "could not run Tailwind". Plain text edits then count, a fallback that [limits.md](../limits.md) describes.

```text
apps/web                                  Next.js app, imports '@workspace/ui/globals.css'
packages/ui/src/styles/globals.css        @import "tailwindcss"; @plugin "./broken.mjs"; @source "../**/*.{ts,tsx}";
packages/ui/src/styles/broken.mjs         throw new Error('boom');
packages/ui/src/components/dialog.tsx     className='rounded skew-y-12'
packages/ui/src/components/plain.tsx      className='flex'
```

| Affected | Unaffected |
| --- | --- |
| Delete `plain.tsx` [styles.test.ts:680](../../test/styles.test.ts#L680) | Delete `plain.tsx` with the broken `@plugin` removed, so Tailwind runs [styles.test.ts:686](../../test/styles.test.ts#L686) |

<details>
<summary>5 more cases</summary>

| Change | Result | Test |
| --- | --- | --- |
| Change `skew-y-12` to `skew-y-6` in `dialog.tsx` | affected, warns "could not run Tailwind" | [styles.test.ts:663](../../test/styles.test.ts#L663) |
| Replace `packages/ui/src/icon.png` | unaffected, the fallback leaves binary files out | [styles.test.ts:673](../../test/styles.test.ts#L673) |
| A v4 project without `@tailwindcss/node` and `@tailwindcss/oxide`, change `'quiet words'` to `'other words'` | affected, warns "could not run Tailwind" | [tailwind.test.ts:96](../../test/tailwind.test.ts#L96) |
| Run `byakugan hash` and `byakugan affected` on the broken project | both print the warning on stderr | [styles.test.ts:695](../../test/styles.test.ts#L695) |
| Run `byakugan hash` with the `@plugin` removed | prints no warning | [styles.test.ts:705](../../test/styles.test.ts#L705) |

</details>

## Turning Tailwind off

`"tailwind": false` in byakugan.json runs no Tailwind. The root stylesheet still counts as a file.

| Change | Result | Test |
| --- | --- | --- |
| No edit | no `src/app.css#<tailwind>`, `src/app.css` itself is live | [tailwind.test.ts:178](../../test/tailwind.test.ts#L178) |
| Add `skew-y-12` to `src/unused.ts` | unaffected | [tailwind.test.ts:178](../../test/tailwind.test.ts#L178) |

## Vite query imports

Vite emits a file imported with `?raw` or `?url` byte for byte, so byakugan hashes its whole text as `<raw>` and a comment edit counts. Vite bundles a `?worker` file like a normal import, so comments and unused exports in its imports do not count.

```ts
// src/main.ts
import snippet from './snippet.ts?raw';
import { used } from './used';

// src/snippet.ts
// shown on the docs page
export const answer = 42;

// src/used.ts
// a helper
export const used = 1;
```

| Affected | Unaffected |
| --- | --- |
| Edit the comment in `src/snippet.ts`, imported with `?raw`. Reason `src/snippet.ts#<raw>` [styles.test.ts:108](../../test/styles.test.ts#L108) | Edit the comment in `src/used.ts`, imported normally. Fingerprint equal [styles.test.ts:118](../../test/styles.test.ts#L118) |

<details>
<summary>9 more cases</summary>

| Setup | Change | Result | Test |
| --- | --- | --- | --- |
| A Vite app with tsconfig paths `"~/*" -> "./src/*"`. `main.ts` also imports `~/app.css?url`, `./inline.css?inline` and `./counter.ts?worker` | No edit | `src/app.css` and `src/inline.css` are live, no key keeps the `?query`, `src/other.css` is not live | [styles.test.ts:85](../../test/styles.test.ts#L85) |
| Same | Edit `src/app.css`, imported with `?url` | affected, reason `src/app.css` | [styles.test.ts:93](../../test/styles.test.ts#L93) |
| Same | Edit `src/inline.css`, imported with `?inline` | affected, reason `src/inline.css` | [styles.test.ts:93](../../test/styles.test.ts#L93) |
| Same | Edit `src/other.css`, which nothing imports | unaffected | [styles.test.ts:102](../../test/styles.test.ts#L102) |
| `src/counter.ts` imports `step` from `./step` and runs `self.onmessage = () => postMessage((count += step))` | Change `count += step` to `count -= step` in the `?worker` file | affected, reason `src/counter.ts#<module>` | [styles.test.ts:126](../../test/styles.test.ts#L126) |
| `src/step.ts` exports `step` and `unused` | Edit `unused` | unaffected | [styles.test.ts:132](../../test/styles.test.ts#L132) |
| Same | Then edit `step` | affected, reason `src/step.ts#step` | [styles.test.ts:132](../../test/styles.test.ts#L132) |
| `main.ts` imports `./worklet.js?url` and `./counter.ts?worker`, each file starts with a comment. `worklet.js` imports `./width.js` and calls `registerPaint` | Edit the comment in `src/worklet.js` | affected, reason `src/worklet.js#<raw>` | [styles.test.ts:1109](../../test/styles.test.ts#L1109) |
| Same | Edit the comment in `src/counter.ts` | unaffected | [styles.test.ts:1115](../../test/styles.test.ts#L1115) |

</details>

## CSS tool versions in the lockfile

Some packages change the CSS without code importing them, so byakugan tracks `tailwindcss` for a Tailwind root, `caniuse-lite` and `browserslist` when `autoprefixer` is a dependency, and the PostCSS plugins the config names. A version bump of a tracked package counts.

| Affected | Unaffected |
| --- | --- |
| A v3 project with `tailwindcss` 3.3.0 in the lockfile, bump it to 3.4.17. Reason `tailwindcss` [styles.test.ts:556](../../test/styles.test.ts#L556) | Same project, bump `left-pad` from 1.0.0 to 1.0.1, which the app does not import [styles.test.ts:556](../../test/styles.test.ts#L556) |

<details>
<summary>7 more cases</summary>

| Setup | Change | Result | Test |
| --- | --- | --- | --- |
| `tailwindcss` not in package.json, `src/app.css` has `@tailwind utilities` | No edit | `npm:tailwindcss#<version>` is live | [styles.test.ts:585](../../test/styles.test.ts#L585) |
| Same, but `src/app.css` is plain CSS | No edit | `npm:tailwindcss#<version>` is not live | [styles.test.ts:585](../../test/styles.test.ts#L585) |
| `autoprefixer` in devDependencies | No edit | `caniuse-lite` and `browserslist` are tracked | [styles.test.ts:593](../../test/styles.test.ts#L593) |
| Only `postcss` in devDependencies | No edit | `caniuse-lite` is not tracked | [styles.test.ts:593](../../test/styles.test.ts#L593) |
| With `autoprefixer` | Bump `caniuse-lite` in the lockfile | affected, reason `caniuse-lite` | [styles.test.ts:603](../../test/styles.test.ts#L603) |
| Without `autoprefixer` | Same bump | unaffected | [styles.test.ts:603](../../test/styles.test.ts#L603) |
| `postcss.config.js` has `plugins: { '@tailwindcss/postcss': {}, cssnano: {} }`, `postcss-nested` is also in devDependencies | No edit | `cssnano` is tracked, `postcss-nested` is not | [styles.test.ts:625](../../test/styles.test.ts#L625) |

</details>
