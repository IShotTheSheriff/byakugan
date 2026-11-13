# CSS, Sass and Tailwind

This page covers stylesheets. It shows which CSS, Sass, Less and Tailwind edits make an app affected, and which ones byakugan ignores.

[All examples](README.md)

Most projects below start from this file set unless a snippet says otherwise:

```text
package.json      { "name": "styled" }
byakugan.json     { "entry": ["src/main.ts"] }
.gitignore        node_modules/
```

"Affected" means `byakugan affected --base main` reports a change, or the fingerprint changes. A key such as `src/app.css#<tailwind>` is the reason git mode reports.

## CSS imported from code

A stylesheet counts once code the app runs imports it. A stylesheet nobody imports does not count. A module reached only through `import type` never runs, so the CSS it imports does not ship.

```ts
// src/main.ts
import './a.css';
import './b.css';
import 'anim';                          // package exports only { ".": { "style": "./dist/anim.css" } }
import type { Props } from './typed';   // typed.ts does `import './typed.css'`
export const run = (p: Props) => p;
// src/c.css exists, nothing imports it
```

| Change | Result | Test |
| --- | --- | --- |
| Edit `src/c.css` | unaffected | [affected.test.ts:256](../../test/affected.test.ts#L256) |
| Then add `import './c.css'` to `main.ts` | affected | [affected.test.ts:256](../../test/affected.test.ts#L256) |
| Edit `src/typed.css`, imported by a module reached only through `import type` | unaffected | [affected.test.ts:264](../../test/affected.test.ts#L264) |
| Edit `src/a.css` | affected | [affected.test.ts:264](../../test/affected.test.ts#L264) |
| No edit. `import 'anim'` names a package whose only export is a `style` condition | the graph reaches `npm:anim/dist/anim.css`, nothing unresolved | [affected.test.ts:272](../../test/affected.test.ts#L272) |

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

| Change | Result | Test |
| --- | --- | --- |
| Swap `import './app.css'` with `import { Header } from './header'` | affected, reason `src/main.ts#<imports>` | [styles.test.ts:353](../../test/styles.test.ts#L353) |
| Swap `import './app.css'` with the `x.module.css` import | affected, reason `src/main.ts#<imports>` | [styles.test.ts:361](../../test/styles.test.ts#L361) |
| Swap the `x.module.css` import with `import { pure } from './pure'` | unaffected, fingerprint equal | [styles.test.ts:367](../../test/styles.test.ts#L367) |
| In a file that imports `a.css` then `b.css`, swap the two | affected, reason `src/main.ts#<module>` | [affected.test.ts:250](../../test/affected.test.ts#L250) |

## Stylesheets linked from Vite `index.html`

A `<link>` or `<script>` in `index.html` makes its file an entry. byakugan skips tags inside HTML comments.

```html
<!-- index.html -->
<link href="/src/style.css" rel="stylesheet">
<!-- <link href="/src/old.css" rel="stylesheet"> -->
<script type="module" src="/src/main.ts"></script>
```

```css
/* src/style.css */
@import "tailwindcss";
```

```ts
// src/unused.ts, nobody imports it
export const banner = ['quiet words'];
```

| Change | Result | Test |
| --- | --- | --- |
| No edit | `src/style.css` is an entry and a Tailwind root, `src/style.css#<tailwind>` is live, `src/old.css` is not an entry | [styles.test.ts:153](../../test/styles.test.ts#L153) |
| Edit `src/old.css`, linked only inside an HTML comment | unaffected | [styles.test.ts:161](../../test/styles.test.ts#L161) |
| Add a rule to `src/style.css` | affected, reason `src/style.css` | [styles.test.ts:161](../../test/styles.test.ts#L161) |
| Change `'quiet words'` to `'other words'` in `src/unused.ts` | unaffected | [styles.test.ts:170](../../test/styles.test.ts#L170) |
| Change it to `'skew-y-12'` | affected, reason `src/style.css#<tailwind>` | [styles.test.ts:170](../../test/styles.test.ts#L170) |
| `index.html` has `<!-- <script src="/src/old.ts"> -->` and a live `<script src="/src/main.ts">` | `src/main.ts#main` counts, nothing from `src/old.ts` | [security.test.ts:1074](../../test/security.test.ts#L1074) |

## What a stylesheet references

byakugan follows every file a stylesheet names. That covers `composes` and `@value` in CSS Modules, Sass `@import` and `@use`, Less `@import`, `url()` and `image-set()`. A file named only in a comment does not count.

```ts
// src/main.ts
import styles from './button.module.css';
import './main.scss';
import './theme.less';
import './hero.css';
document.body.className = styles.btn;
```

```css
/* src/button.module.css */
@value primary from './colors.css';
.btn {
  composes: base from './base.module.css';
  color: primary;
}
```

```scss
// src/main.scss
@import 'variables', 'mixins';
// @use 'old';
/* @import 'older'; */
.a { background: url(https://cdn.example.com/a.png); } @use 'tokens';
body { color: $c; }
```

```less
// src/theme.less
@import (reference) "tokens.less";
.a { color: @brand; }
```

```css
/* src/hero.css */
.hero { background-image: image-set("./hero.png" 1x, "./hero@2x.png" 2x); }
/* .old { background: url(./old.png); } */
```

Each row appends a newline to one file and runs git mode.

| Change | Result | Test |
| --- | --- | --- |
| Edit `src/base.module.css`, the target of `composes: ... from` | affected, reason `src/base.module.css` | [styles.test.ts:226](../../test/styles.test.ts#L226) |
| Edit `src/colors.css`, the target of `@value ... from` | affected, reason `src/colors.css` | [styles.test.ts:226](../../test/styles.test.ts#L226) |
| Edit `src/_variables.scss` or `src/_mixins.scss`, both in one `@import` list | affected, reason is that file | [styles.test.ts:226](../../test/styles.test.ts#L226) |
| Edit `src/_tokens.scss`, named by a `@use` after a rule on the same line | affected, reason `src/_tokens.scss` | [styles.test.ts:226](../../test/styles.test.ts#L226) |
| Edit `src/tokens.less`, named by `@import (reference)` | affected, reason `src/tokens.less` | [styles.test.ts:226](../../test/styles.test.ts#L226) |
| Edit `src/hero.png` or `src/hero@2x.png`, both in `image-set()` | affected, reason is that file | [styles.test.ts:226](../../test/styles.test.ts#L226) |
| Edit `src/other.module.css`, `src/_unused.scss`, `src/unused.less` or `src/other.png`, which nothing names | unaffected | [styles.test.ts:234](../../test/styles.test.ts#L234) |
| Edit `src/_old.scss`, `src/_older.scss` or `src/old.png`, named only in a `//` comment, a `/* */` comment or a commented-out `url()` | unaffected | [styles.test.ts:234](../../test/styles.test.ts#L234) |

Deleting assets, with `src/app.css` containing `.a { background: url("./bg.png"); }`:

| Change | Result | Test |
| --- | --- | --- |
| Delete `src/bg.png` | affected, the reason detail says "deleted" | [styles.test.ts:239](../../test/styles.test.ts#L239) |
| Delete `src/spare.png`, which no stylesheet names | unaffected | [styles.test.ts:249](../../test/styles.test.ts#L249) |

## Comments in stylesheets

An `@import` inside a comment does not count. One after a closed comment does. An unclosed comment runs to the end of the file, so it hides everything after it.

```css
/* src/app.css */
/* old */ @import './tokens.css';
/* @import './draft.css';
```

| Change | Result | Test |
| --- | --- | --- |
| Edit `src/draft.css`, imported only inside the unclosed comment | unaffected | [styles.test.ts:1165](../../test/styles.test.ts#L1165) |
| Edit `src/tokens.css`, imported after a closed comment | affected, reason `src/tokens.css` | [styles.test.ts:1165](../../test/styles.test.ts#L1165) |
| `src/a.css` holds `/* @import './old.css'; */` then `@import './new.css';` | `src/new.css` counts, `src/old.css` does not | [security.test.ts:1061](../../test/security.test.ts#L1061) |

## Aliases and Sass load paths

byakugan resolves stylesheet paths the way the build does. It reads tsconfig `paths`, `sassOptions.includePaths` in `next.config.js` and `css.preprocessorOptions.scss.loadPaths` in `vite.config.ts`. Only the file the path resolves to counts, not its siblings.

```scss
// app/page.module.scss, Next.js with tsconfig paths "@/*" -> "./*"
@use '@/styles/variables' as *;
.hero { color: $brand; }
```

| Setup | Change | Result | Test |
| --- | --- | --- | --- |
| tsconfig `@/*` alias in a Sass `@use` | Edit the sibling `styles/_other.scss` | unaffected, no unresolved imports | [styles.test.ts:270](../../test/styles.test.ts#L270) |
| Same | Edit `styles/_variables.scss` | affected, reason `styles/_variables.scss` | [styles.test.ts:270](../../test/styles.test.ts#L270) |
| tsconfig `@/*` -> `./src/*`, `@import "@/styles/tokens.css"` in a CSS module | Edit `src/styles/spare.css` | unaffected | [styles.test.ts:284](../../test/styles.test.ts#L284) |
| Same | Edit `src/styles/tokens.css` | affected, reason `src/styles/tokens.css` | [styles.test.ts:284](../../test/styles.test.ts#L284) |
| `next.config.js` has `sassOptions.includePaths: [path.join(__dirname, 'styles')]`, the stylesheet has `@use 'abstracts/colors'` | Edit `styles/abstracts/_spacing.scss` | unaffected | [styles.test.ts:301](../../test/styles.test.ts#L301) |
| Same | Edit `styles/abstracts/_colors.scss` | affected, reason `styles/abstracts/_colors.scss` | [styles.test.ts:301](../../test/styles.test.ts#L301) |
| `vite.config.ts` has `css.preprocessorOptions.scss.loadPaths: ['shared']`, the stylesheet has `@use 'tokens'` | Edit `shared/_spare.scss` | unaffected | [styles.test.ts:314](../../test/styles.test.ts#L314) |
| Same | Edit `shared/_tokens.scss` | affected, reason `shared/_tokens.scss` | [styles.test.ts:314](../../test/styles.test.ts#L314) |

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

| Change | Result | Test |
| --- | --- | --- |
| Edit the sibling partial `src/styles/_other.scss` | unaffected | [styles.test.ts:946](../../test/styles.test.ts#L946) |
| Edit `src/styles/_vars.scss`, loaded by `additionalData` | affected, reason `src/styles/_vars.scss` | [styles.test.ts:946](../../test/styles.test.ts#L946) |
| Delete `src/styles/_vars.scss` | affected | [styles.test.ts:955](../../test/styles.test.ts#L955) |
| Add `@use "sass:math";` to `additionalData`, then edit `_other.scss` | unaffected, no unresolved import | [styles.test.ts:961](../../test/styles.test.ts#L961) |
| The app imports only `src/app.css` and has no Sass, edit `_vars.scss` | unaffected | [styles.test.ts:992](../../test/styles.test.ts#L992) |
| Next.js `sassOptions: { includePaths: ['styles'], prependData: '@import "variables";' }`, edit `styles/_spacing.scss` | unaffected | [styles.test.ts:998](../../test/styles.test.ts#L998) |
| Same, edit `styles/_variables.scss` | affected, reason `styles/_variables.scss` | [styles.test.ts:998](../../test/styles.test.ts#L998) |
| `@use "pkg:bootstrap/scss/grid"`, edit `node_modules/bootstrap/scss/_grid.scss` | affected, fingerprint changes | [styles.test.ts:971](../../test/styles.test.ts#L971) |
| `@use "sass:math"` in a stylesheet | not followed, no unresolved imports, no warnings | [styles.test.ts:985](../../test/styles.test.ts#L985) |

## `url()` behind an alias, and `@value` paths

A `url()` resolves through tsconfig `paths` like an import. `@value` with a quoted path names a file. A quoted value that is not a path, such as a font name, stays a string.

```ts
// src/main.ts, with tsconfig paths "@/*" -> "./src/*"
import './app.css';
import styles from './button.module.css';
```

```css
/* src/app.css */
.hero { background: url("@/assets/hero.png"); }
```

```css
/* src/button.module.css */
@value colors: "./colors.css";
@value font: "Inter";
@value primary from colors;
.btn { color: primary; font-family: font; }
```

| Change | Result | Test |
| --- | --- | --- |
| Replace `src/assets/spare.png` | unaffected | [styles.test.ts:1030](../../test/styles.test.ts#L1030) |
| Replace `src/assets/hero.png` | affected, reason `src/assets/hero.png` | [styles.test.ts:1030](../../test/styles.test.ts#L1030) |
| Delete `src/assets/hero.png` | affected | [styles.test.ts:1038](../../test/styles.test.ts#L1038) |
| Delete `src/assets/spare.png` | unaffected | [styles.test.ts:1044](../../test/styles.test.ts#L1044) |
| tsconfig has no `@/*` alias, replace `src/assets/hero.png` | affected | [styles.test.ts:1051](../../test/styles.test.ts#L1051) |
| No edit, with the alias tsconfig names | no unresolved import | [styles.test.ts:1057](../../test/styles.test.ts#L1057) |
| `@/*` maps to `./src/*` then `./fallback/*`, delete `src/assets/hero.png` so the alias falls back | affected, fingerprint changes | [styles.test.ts:1073](../../test/styles.test.ts#L1073) |
| Same, delete `fallback/assets/hero.png` while the first target exists | unaffected | [styles.test.ts:1081](../../test/styles.test.ts#L1081) |
| Edit `src/spare.css` | unaffected, `"Inter"` is not a file | [styles.test.ts:1087](../../test/styles.test.ts#L1087) |
| Edit `src/colors.css`, named by `@value colors: "./colors.css"` | affected, reason `src/colors.css` | [styles.test.ts:1087](../../test/styles.test.ts#L1087) |

With an alias that tsconfig does not define, byakugan cannot resolve the `url()`, and the asset edit still counts. [limits.md](../limits.md) explains why unresolved paths fail closed.

## `@import` from the project root

A path that starts with `/` resolves from the project root, as Vite does it. That works quoted, inside `url()`, without an extension, and in Sass `@use`.

```css
/* src/app.css */
@import "/src/theme.css";
.app { color: red; }
```

| Change | Result | Test |
| --- | --- | --- |
| Edit `src/theme.css` | affected, reason `src/theme.css` | [styles.test.ts:791](../../test/styles.test.ts#L791) |
| Edit `src/other.css` | unaffected | [styles.test.ts:797](../../test/styles.test.ts#L797) |
| With `@import url(/src/theme.css);`, edit `src/theme.css` | affected, reason `src/theme.css` | [styles.test.ts:803](../../test/styles.test.ts#L803) |
| With `@import url(/src/theme.css);`, edit `src/other.css` | unaffected | [styles.test.ts:809](../../test/styles.test.ts#L809) |
| `@import "/src/theme";` with no extension, delete `src/theme.css` | affected, fingerprint changes | [styles.test.ts:820](../../test/styles.test.ts#L820) |
| `@use "/src/styles/vars";` in `src/app.scss`, delete `src/styles/_vars.scss` | affected, fingerprint changes | [styles.test.ts:820](../../test/styles.test.ts#L820) |
| Either setup, delete `src/other.css` | unaffected | [styles.test.ts:828](../../test/styles.test.ts#L828) |

## Tailwind v4: class names in files nobody imports

Tailwind scans files the app never imports. byakugan runs the project's Tailwind and hashes the CSS it generates as `<root>.css#<tailwind>`. A file nobody imports makes the app affected only when it adds a class that changes that CSS.

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

| Change | Result | Test |
| --- | --- | --- |
| No edit | `src/app.css#<tailwind>` is live, `src/unused.ts#banner` is not, no warnings | [tailwind.test.ts:50](../../test/tailwind.test.ts#L50) |
| Change `'quiet words'` to `'other words'` in `src/unused.ts` | unaffected, git mode lists `src/unused.ts` under `ignored` | [tailwind.test.ts:57](../../test/tailwind.test.ts#L57), [tailwind.test.ts:80](../../test/tailwind.test.ts#L80) |
| Add `flex` to `src/unused.ts`, a class `button.ts` already uses | unaffected | [tailwind.test.ts:57](../../test/tailwind.test.ts#L57) |
| Add a prose line to `README.md` | unaffected | [tailwind.test.ts:57](../../test/tailwind.test.ts#L57) |
| Add `skew-y-12`, a new class, to `src/unused.ts` | affected, reason `src/app.css#<tailwind>`, the detail names `src/unused.ts` | [tailwind.test.ts:57](../../test/tailwind.test.ts#L57), [tailwind.test.ts:80](../../test/tailwind.test.ts#L80) |

This counts classes, not rendered markup. A class in a component nobody renders yet still changes the CSS. [limits.md](../limits.md) lists this.

## Tailwind v4: `@source`

`@source` sets which files Tailwind scans, so it also sets which files can count.

```css
/* src/app.css */
@import "tailwindcss" source(none);
@source "../src";
```

| Change | Result | Test |
| --- | --- | --- |
| Add `skew-y-12` to `scripts/seed.ts`, outside `@source` | unaffected | [tailwind.test.ts:70](../../test/tailwind.test.ts#L70) |
| Add `skew-y-12` to `src/unused.ts`, inside `@source` | affected, fingerprint changes | [tailwind.test.ts:70](../../test/tailwind.test.ts#L70) |

## Tailwind v4: deleting scanned files

Deleting a scanned file counts when it held the only use of a class.

```text
src/app.css       one of the three forms below
content/rare.md   <div class="skew-y-12">x</div>   only file with this class
content/plain.md  <div class="flex">x</div>        src/main.ts also uses flex
```

The three `src/app.css` forms are automatic source with `@import "tailwindcss";`, `@source` with `../` (`source(none)` plus `@source "../content"; @source "./";`), and `@source` with a glob (`@source "../**/*.{md,ts}";`).

| Change | Result | Test |
| --- | --- | --- |
| Delete `content/rare.md` | affected in all three forms, reason `src/app.css#<tailwind>`, the detail names `content/rare.md` | [styles.test.ts:533](../../test/styles.test.ts#L533) |
| Delete `content/plain.md` | unaffected in all three forms | [styles.test.ts:541](../../test/styles.test.ts#L541) |
| With `@source "../content"` only, delete `scripts/seed.md`, which has `skew-y-6` | unaffected | [styles.test.ts:548](../../test/styles.test.ts#L548) |

## Tailwind v4: which stylesheet is the root

The root is the stylesheet code imports, even when `@import "tailwindcss"` sits in a file it imports or in a package. Theme colors and `@utility` rules in the root decide which class names produce CSS.

| Setup | Change | Result | Test |
| --- | --- | --- | --- |
| `src/app.css` is `@import "./tw.css"; @theme { --color-brand: #f00; }`, `src/tw.css` is `@import "tailwindcss";` | No edit | the root is `src/app.css#<tailwind>`, not `src/tw.css#<tailwind>` | [styles.test.ts:390](../../test/styles.test.ts#L390) |
| Same | Change `'quiet words'` to `'other words'` in `src/unused.ts` | unaffected | [styles.test.ts:390](../../test/styles.test.ts#L390) |
| Same | Then change it to `'bg-brand'`, the color the root's `@theme` defines | affected, reason `src/app.css#<tailwind>` | [styles.test.ts:390](../../test/styles.test.ts#L390) |
| `src/app.css` is `@import "@acme/design/tailwind.css";`, and the package file has `@import "tailwindcss"` and `@theme { --color-brand: #f00; }` | Write `bg-blue`, a color nobody defines, in `src/unused.ts` | unaffected | [styles.test.ts:405](../../test/styles.test.ts#L405) |
| Same | Change it to `bg-brand` | affected, reason `src/app.css#<tailwind>` | [styles.test.ts:405](../../test/styles.test.ts#L405) |
| `src/app.css` is `@import "tailwindcss"; @utility glass { ... }` | Write `glass` in `src/unused.ts` | affected, reason `src/app.css#<tailwind>` | [styles.test.ts:721](../../test/styles.test.ts#L721) |
| Same, plus a `src/legacy.css` nobody imports | Add `/* skew-y-12 */` to `src/legacy.css` | unaffected | [styles.test.ts:727](../../test/styles.test.ts#L727) |

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

| Change | Result | Test |
| --- | --- | --- |
| No edit | `src/app.css#<tailwind>` is live, no warnings | [tailwind.test.ts:107](../../test/tailwind.test.ts#L107) |
| Change `'quiet words'` to `'other words'` in `src/unused.ts` | unaffected | [tailwind.test.ts:107](../../test/tailwind.test.ts#L107) |
| Add a new file `scripts/seed.ts` with `skew-y-12`, outside the globs | unaffected | [tailwind.test.ts:107](../../test/tailwind.test.ts#L107) |
| Add `skew-y-12` to `src/unused.ts` | affected, fingerprint changes | [tailwind.test.ts:107](../../test/tailwind.test.ts#L107) |

Content globs written as absolute paths, `content: [path.join(__dirname, 'src/**/*.ts')]`:

| Change | Result | Test |
| --- | --- | --- |
| Write `skew-y-6` in `other/seed.ts`, outside the globs | unaffected | [styles.test.ts:488](../../test/styles.test.ts#L488) |
| Write `skew-y-6` in `src/unused.ts` | affected, reason `src/app.css#<tailwind>` | [styles.test.ts:488](../../test/styles.test.ts#L488) |
| Delete `src/rare.ts`, the only file with `skew-y-12` | affected, reason `src/app.css#<tailwind>`, the detail names `src/rare.ts` | [styles.test.ts:488](../../test/styles.test.ts#L488) |
| Delete `src/copy.ts`, whose only class `flex` also appears in `src/main.ts` | unaffected | [styles.test.ts:507](../../test/styles.test.ts#L507) |

## Tailwind v3: PostCSS and imported component classes

A component class defined in a file the root imports counts once a scanned file uses it. A class nobody defines does not.

```css
/* src/app.css, with postcss-import in postcss.config.js */
@import "tailwindcss/base";
@import "tailwindcss/components";
@import "./buttons.css";          /* @layer components { .btn-primary { ... } } */
@import "tailwindcss/utilities";
```

| Setup | Change | Result | Test |
| --- | --- | --- | --- |
| postcss-import installed and configured | Write `btn-secondary`, which nobody defines, in `src/unused.ts` | unaffected | [styles.test.ts:435](../../test/styles.test.ts#L435) |
| Same | Change it to `btn-primary` | affected, reason `src/app.css#<tailwind>` | [styles.test.ts:435](../../test/styles.test.ts#L435) |
| No postcss-import, `src/app.css` imports `./base.css` with `@tailwind base` and `./utilities.css` with `@tailwind utilities` | No edit | no warnings, `src/app.css#<tailwind>` live | [styles.test.ts:450](../../test/styles.test.ts#L450) |
| Same | Write `'other words'` in `src/unused.ts` | unaffected | [styles.test.ts:450](../../test/styles.test.ts#L450) |
| Same | Write `'skew-y-12'` in `src/unused.ts` | affected, reason `src/app.css#<tailwind>` | [styles.test.ts:450](../../test/styles.test.ts#L450) |

byakugan runs the Tailwind config that PostCSS names. Here `postcss.config.js` points at `./config/tailwind.config.js`, which scans `./src/**/*.ts`. A decoy `tailwind.config.js` at the default path scans `./other/**/*.ts`. The test spells the PostCSS config three ways: `plugins: { tailwindcss: { config } }`, `tailwindcss({ config })` after `require`, and `require('tailwindcss')({ config })` inline.

| Change | Result | Test |
| --- | --- | --- |
| Write `skew-y-12` in `other/seed.ts`, which only the decoy scans | unaffected in all three spellings | [styles.test.ts:471](../../test/styles.test.ts#L471) |
| Write `skew-y-12` in `src/unused.ts` | affected in all three spellings, reason `src/app.css#<tailwind>` | [styles.test.ts:471](../../test/styles.test.ts#L471) |

By default every stylesheet uses the project's root PostCSS config. Set `"postcssFromStylesheet": true` in byakugan.json if your build picks the config nearest each stylesheet. In this project the root `postcss.config.js` names `tailwind.a.js`, which scans `src/a`, through `path.join(__dirname, ...)`. `src/b/postcss.config.js` names `tailwind.b.js`, which scans `src/b`. `src/main.ts` imports `src/a/a.css` and `src/b/b.css`, both `@tailwind utilities;`.

| Change | Result | Test |
| --- | --- | --- |
| Add `skew-y-12` to `src/a/x.ts` | affected, fingerprint changes | [tailwind.test.ts:249](../../test/tailwind.test.ts#L249) |
| Add `skew-y-12` to `src/b/y.ts`, with `"postcssFromStylesheet": true` | affected, fingerprint changes | [tailwind.test.ts:256](../../test/tailwind.test.ts#L256) |
| Add `skew-y-12` to `src/b/y.ts`, without that option | unaffected | [tailwind.test.ts:263](../../test/tailwind.test.ts#L263) |

## Tailwind v3 in Vite

Vite runs its own postcss-import before the PostCSS plugins, so an imported component class counts even when no PostCSS config names postcss-import.

```js
// postcss.config.cjs
module.exports = { plugins: { tailwindcss: {} } };
```

```js
// tailwind.config.cjs
module.exports = { content: ['./index.html', './src/**/*.ts'] };
```

```css
/* src/buttons.css */
@layer components { .btn-primary { color: red; } }
```

`src/app.css` pulls in `buttons.css` in five ways: `@import "./buttons.css"`, the Tailwind layer imports such as `@import "tailwindcss/base"`, `@import url(./buttons.css)`, `@import "/src/buttons.css"` and `@import url(/src/buttons.css)`.

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

| Setup | Change | Result | Test |
| --- | --- | --- | --- |
| Directives in `app.scss` | Write `btn-secondary` in `src/unused.ts` | unaffected, no warnings | [styles.test.ts:856](../../test/styles.test.ts#L856) |
| Same | Change it to `btn-primary` | affected, reason `src/app.scss#<tailwind>` | [styles.test.ts:856](../../test/styles.test.ts#L856) |
| Directives in the partial `_tailwind.scss`, `app.scss` is `@import 'tailwind'; @import 'buttons';` | Write `btn-primary` | affected, reason `src/app.scss#<tailwind>` | [styles.test.ts:878](../../test/styles.test.ts#L878) |
| Same | Write `btn-secondary` | unaffected | [styles.test.ts:884](../../test/styles.test.ts#L884) |
| Directives in a plain `src/tw.css`, `app.scss` is `@import "./tw.css"; .app {...}` | Write `flex` in `src/unused.ts` | affected, fingerprint changes | [styles.test.ts:904](../../test/styles.test.ts#L904) |
| Same | Write `other words` | unaffected | [styles.test.ts:912](../../test/styles.test.ts#L912) |
| Directives in `app.scss`, sass not installed | Write `other words` | affected, warns "could not run Tailwind" | [styles.test.ts:918](../../test/styles.test.ts#L918) |

In the plain-CSS case, `flex` counts even though `src/main.ts` sets no class. Sass leaves `@import "./tw.css"` alone, so Tailwind compiles `tw.css` on its own, and that output gains the `flex` rule.

## Tailwind and `.gitignore`

v4 automatic source detection skips git-ignored files, so a `.gitignore` edit can change which classes exist. v3 content globs do not read `.gitignore`.

| Setup | Change | Result | Test |
| --- | --- | --- | --- |
| v4 root with `@import "tailwindcss"`, `src/legacy/old.ts` has `skew-y-12` | Add `src/legacy/` to `.gitignore` | affected, reason `.gitignore` | [styles.test.ts:1123](../../test/styles.test.ts#L1123) |
| v3 root with `content: ['./src/**/*.ts']`, same file | Same edit | unaffected | [styles.test.ts:1139](../../test/styles.test.ts#L1139) |

## Tailwind in a workspace

Tailwind often scans a workspace package through a `node_modules` link. byakugan follows the link and reads the base side of the linked file in git mode.

```text
apps/web/src/app.css             v4: @import "tailwindcss"; @source "../node_modules/@acme/ui/src";
                                 v3: tailwind.config.js content includes './node_modules/@acme/ui/src/**/*.ts'
apps/web/node_modules/@acme/ui -> ../../../../packages/ui   (symlink)
packages/ui/src/card.ts          export const card = () => ['rounded', 'quiet words'];
```

| Change | Result | Test |
| --- | --- | --- |
| Change `'quiet words'` to `'other words'` in `packages/ui/src/card.ts` | unaffected in v3 and v4 | [tailwind.test.ts:155](../../test/tailwind.test.ts#L155) |
| Add `skew-y-12` to `packages/ui/src/card.ts` | affected in v3 and v4, reason `apps/web/src/app.css#<tailwind>` | [tailwind.test.ts:155](../../test/tailwind.test.ts#L155) |
| Link the package a second time as `@acme/ui-again`, scan both paths, add `skew-y-12` to `card.ts` | affected in v3 and v4, fingerprint changes | [tailwind.test.ts:165](../../test/tailwind.test.ts#L165) |

A package such as `packages/ui` may get its Tailwind config from the app that hosts it. `"tailwindDir": "../../apps/host"` in the package's byakugan.json compiles its stylesheets with that directory's configs. In this test the host config also scans `apps/host/stories`.

| Setup | Change | Result | Test |
| --- | --- | --- | --- |
| `"tailwindDir": "../../apps/host"` | Add `skew-y-12` to `apps/host/stories/card.ts` | affected, fingerprint changes | [tailwind.test.ts:211](../../test/tailwind.test.ts#L211) |
| Same project without `tailwindDir` | Same edit | unaffected | [tailwind.test.ts:218](../../test/tailwind.test.ts#L218) |

## When Tailwind cannot run

If Tailwind fails, byakugan hashes every file Tailwind might scan whole and warns "could not run Tailwind". Plain text edits then count. That costs rebuilds, but no class change slips through. [limits.md](../limits.md) describes this fallback.

```text
apps/web                                  Next.js app, imports '@workspace/ui/globals.css'
packages/ui/src/styles/globals.css        @import "tailwindcss"; @plugin "./broken.mjs"; @source "../**/*.{ts,tsx}";
packages/ui/src/styles/broken.mjs         throw new Error('boom');
packages/ui/src/components/dialog.tsx     className='rounded skew-y-12'
packages/ui/src/components/plain.tsx      className='flex'
```

| Change | Result | Test |
| --- | --- | --- |
| Change `skew-y-12` to `skew-y-6` in `dialog.tsx` | affected, warns "could not run Tailwind" | [styles.test.ts:663](../../test/styles.test.ts#L663) |
| Replace `packages/ui/src/icon.png` | unaffected, the fallback leaves binary files out | [styles.test.ts:673](../../test/styles.test.ts#L673) |
| Delete `plain.tsx` | affected | [styles.test.ts:680](../../test/styles.test.ts#L680) |
| Delete `plain.tsx` with the broken `@plugin` removed, so Tailwind runs | unaffected | [styles.test.ts:686](../../test/styles.test.ts#L686) |
| v4 project without `@tailwindcss/node` and `@tailwindcss/oxide`, change `'quiet words'` to `'other words'` | affected, warns "could not run Tailwind" | [tailwind.test.ts:96](../../test/tailwind.test.ts#L96) |
| Run `byakugan hash` and `byakugan affected` on the broken project | both print the warning on stderr | [styles.test.ts:695](../../test/styles.test.ts#L695) |
| Run `byakugan hash` with the `@plugin` removed | prints no warning | [styles.test.ts:705](../../test/styles.test.ts#L705) |

## Turning Tailwind off

`"tailwind": false` in byakugan.json runs no Tailwind. The root stylesheet still counts as a file.

| Change | Result | Test |
| --- | --- | --- |
| No edit | no `src/app.css#<tailwind>`, `src/app.css` itself is live | [tailwind.test.ts:178](../../test/tailwind.test.ts#L178) |
| Add `skew-y-12` to `src/unused.ts` | unaffected | [tailwind.test.ts:178](../../test/tailwind.test.ts#L178) |

## Vite query imports

The query decides whether comments count. Vite emits a file imported with `?raw` or `?url` byte for byte, so byakugan hashes its whole text as `<raw>` and a comment edit counts. Vite bundles a `?worker` file like a normal import, so comments and unused exports in its imports do not count. No graph key keeps the `?query`.

```ts
// src/main.ts, a Vite app with tsconfig paths "~/*" -> "./src/*"
import sheet from '~/app.css?url';
import inline from './inline.css?inline';
import snippet from './snippet.ts?raw';
import { used } from './used';
import Counter from './counter.ts?worker';
export const links = [sheet, inline, snippet, used, new Counter()];
```

```ts
// src/snippet.ts
// shown on the docs page
export const answer = 42;
```

```ts
// src/used.ts
// a helper
export const used = 1;
```

```ts
// src/counter.ts
import { step } from './step';
let count = 0;
self.onmessage = () => postMessage((count += step));
```

```ts
// src/step.ts
export const step = 1;
export const unused = 2;
```

| Change | Result | Test |
| --- | --- | --- |
| No edit | `src/app.css` and `src/inline.css` are live, no key keeps the `?query`, `src/other.css` is not live | [styles.test.ts:85](../../test/styles.test.ts#L85) |
| Edit `src/app.css`, imported with `?url` | affected, reason `src/app.css` | [styles.test.ts:93](../../test/styles.test.ts#L93) |
| Edit `src/inline.css`, imported with `?inline` | affected, reason `src/inline.css` | [styles.test.ts:93](../../test/styles.test.ts#L93) |
| Edit `src/other.css`, which nothing imports | unaffected | [styles.test.ts:102](../../test/styles.test.ts#L102) |
| Edit the comment in `src/snippet.ts`, imported with `?raw` | affected, reason `src/snippet.ts#<raw>` | [styles.test.ts:108](../../test/styles.test.ts#L108) |
| Edit the comment in `src/used.ts`, imported normally | unaffected, fingerprint equal | [styles.test.ts:118](../../test/styles.test.ts#L118) |
| Change `count += step` to `count -= step` in the `?worker` file | affected, reason `src/counter.ts#<module>` | [styles.test.ts:126](../../test/styles.test.ts#L126) |
| Edit `unused` in `src/step.ts`, which the worker imports | unaffected | [styles.test.ts:132](../../test/styles.test.ts#L132) |
| Then edit `step` in the same file | affected, reason `src/step.ts#step` | [styles.test.ts:132](../../test/styles.test.ts#L132) |

A second setup imports scripts with `?url` and `?worker`, each starting with a comment:

```ts
// src/main.ts
import worklet from './worklet.js?url';
import Counter from './counter.ts?worker';
```

```js
// src/worklet.js
// paints a border
import { width } from './width.js';
registerPaint('border', class { paint() { return width; } });
```

| Change | Result | Test |
| --- | --- | --- |
| Edit the comment in `src/worklet.js`, imported with `?url` | affected, reason `src/worklet.js#<raw>` | [styles.test.ts:1109](../../test/styles.test.ts#L1109) |
| Edit the comment in `src/counter.ts`, imported with `?worker` | unaffected | [styles.test.ts:1115](../../test/styles.test.ts#L1115) |

## CSS tool versions in the lockfile

Some packages change the CSS without any code importing them. byakugan tracks `tailwindcss` for a Tailwind root, `caniuse-lite` and `browserslist` when `autoprefixer` is a dependency, and the PostCSS plugins the config names. A version bump of a tracked package counts.

| Setup | Change | Result | Test |
| --- | --- | --- | --- |
| v3 project, no framework, lockfile has `tailwindcss` 3.3.0 and `left-pad` 1.0.0, which the app does not import | Bump `left-pad` to 1.0.1 | unaffected | [styles.test.ts:556](../../test/styles.test.ts#L556) |
| Same | Bump `tailwindcss` to 3.4.17 | affected, reason `tailwindcss` | [styles.test.ts:556](../../test/styles.test.ts#L556) |
| `tailwindcss` not in package.json, `src/app.css` has `@tailwind utilities` | No edit | `npm:tailwindcss#<version>` is live | [styles.test.ts:585](../../test/styles.test.ts#L585) |
| Same, but `src/app.css` is plain CSS | No edit | `npm:tailwindcss#<version>` is not live | [styles.test.ts:585](../../test/styles.test.ts#L585) |
| `autoprefixer` in devDependencies | No edit | `caniuse-lite` and `browserslist` are tracked | [styles.test.ts:593](../../test/styles.test.ts#L593) |
| Only `postcss` in devDependencies | No edit | `caniuse-lite` is not tracked | [styles.test.ts:593](../../test/styles.test.ts#L593) |
| With `autoprefixer` | Bump `caniuse-lite` in the lockfile | affected, reason `caniuse-lite` | [styles.test.ts:603](../../test/styles.test.ts#L603) |
| Without `autoprefixer` | Same bump | unaffected | [styles.test.ts:603](../../test/styles.test.ts#L603) |
| `postcss.config.js` has `plugins: { '@tailwindcss/postcss': {}, cssnano: {} }`, `postcss-nested` is also in devDependencies | No edit | `cssnano` is tracked, `postcss-nested` is not | [styles.test.ts:625](../../test/styles.test.ts#L625) |
