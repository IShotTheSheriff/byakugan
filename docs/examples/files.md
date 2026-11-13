# Files, renames, deletions and links

This page covers files the app reads by path instead of a plain import, and changes to the file tree itself: renames, deletions, ignored files, symlinks and submodules.
"Git mode" means `byakugan affected --base main`. Rows without it compare fingerprints.

[All examples](README.md)

## Case-only renames

A rename that changes only the case of a file name counts when an import spells the old name.
On macOS the import of `./Hello` still finds `hello.ts`, so the app builds locally. A Linux CI runner looks for `Hello.ts` and fails, so byakugan reports it.

```ts
// src/main.ts
import { hello } from './Hello';
console.log(hello());
// src/Hello.ts
export const hello = () => 'hi';
// src/Unused.ts
export const unused = 1;
```

| Change | Result | Test |
| --- | --- | --- |
| `git mv src/Hello.ts src/hello.ts` | affected, reason `src/Hello.ts` with detail `renamed by case only` | [git-mode.test.ts:758](../../test/git-mode.test.ts#L758) |
| `git mv src/Unused.ts src/unused.ts`, which nothing imports | unaffected | [git-mode.test.ts:766](../../test/git-mode.test.ts#L766) |
| Rename the directory `src/lib` to `src/Lib` while `main.ts` imports `./lib/greet` | affected | [git-mode.test.ts:772](../../test/git-mode.test.ts#L772) |

These tests need a case-insensitive file system. They run on macOS and skip on Linux, so Linux CI does not run them.

## Deleted files the app still refers to

Deleting a file that an import, a `url()` or a path in code names is affected, even though the file is no longer there to compare. Git mode matches the deleted path against what the base graph resolved. Deleting a file nothing names is unaffected.

| Setup | Change | Result | Test |
| --- | --- | --- | --- |
| tsconfig `baseUrl: "."`, `main.ts` imports `lib/greet` | Delete `lib/greet.ts` | affected, reason `unresolved` for `src/main.ts -> lib/greet` | [git-mode.test.ts:215](../../test/git-mode.test.ts#L215) |
| same | Delete `lib/other.ts`, which nothing imports | unaffected | [git-mode.test.ts:221](../../test/git-mode.test.ts#L221) |
| same | Delete both files and the `lib` directory | affected | [git-mode.test.ts:254](../../test/git-mode.test.ts#L254) |
| tsconfig `paths` maps `@components/*` to `./src/components/*`, `main.ts` imports `@components/Hero` | Delete `src/components/Hero.ts` | affected | [git-mode.test.ts:262](../../test/git-mode.test.ts#L262) |
| Workspace package `@acme/ui` exports `src/index.ts` | Delete `packages/ui/src/index.ts` | affected, reason `unresolved` for `apps/web/app/page.tsx -> @acme/ui` | [git-mode.test.ts:275](../../test/git-mode.test.ts#L275) |
| same, plus a committed `Legacy.tsx` that nothing imports | Delete `Legacy.tsx` | unaffected, `ignored` lists it | [git-mode.test.ts:281](../../test/git-mode.test.ts#L281) |
| same | Delete the whole `packages/ui` directory | affected | [git-mode.test.ts:291](../../test/git-mode.test.ts#L291) |
| Next.js app imports `@/components/Hero` | Delete `apps/web/components/Hero.tsx` | affected, reason `unresolved` | [affected.test.ts:145](../../test/affected.test.ts#L145) |
| `style.css` has `background: url("./bg.png")` | Delete `bg.png` | affected, reason `src/bg.png` with detail `deleted (the code refers to this path)` | [git-mode.test.ts:308](../../test/git-mode.test.ts#L308) |
| same | Delete `unused.png` | unaffected | [git-mode.test.ts:316](../../test/git-mode.test.ts#L316) |
| `main.ts` has `new URL('./data.txt', import.meta.url)` | Delete `data.txt` | affected, reason `src/data.txt` | [git-mode.test.ts:332](../../test/git-mode.test.ts#L332) |
| same | Delete `other.txt` | unaffected | [git-mode.test.ts:338](../../test/git-mode.test.ts#L338) |
| `import './util'` resolves to `util.ts`, and `util/index.ts` also exists | Delete `util.ts` | affected, reason `src/util.ts` with detail `now resolves to another file` | [git-mode.test.ts:356](../../test/git-mode.test.ts#L356) |
| Same layout for `helper.ts` and `helper/index.ts`, nothing imports `./helper` | Delete `helper.ts` | unaffected | [git-mode.test.ts:364](../../test/git-mode.test.ts#L364) |

After `util.ts` goes, `./util` still resolves, to `util/index.ts`. Nothing fails, but the import now loads different code, so byakugan reports it.

## Dynamic imports, styles and public assets

A file the app loads through `import()`, a CSS `@import`, a Sass `@use` or Next.js `public/` counts like a statically imported module. These rows use a Next.js app in a workspace.

| Change | Result | Test |
| --- | --- | --- |
| Edit `components/Chart.tsx`, loaded through `next/dynamic(() => import(...))` | affected | [affected.test.ts:101](../../test/affected.test.ts#L101) |
| Edit `app/theme.css`, pulled in by a relative `@import` | affected, reason `apps/web/app/theme.css` | [affected.test.ts:107](../../test/affected.test.ts#L107) |
| Edit the Sass partial `_tokens.scss`, reached by `@use './tokens'` from `main.scss` | affected, reason `apps/web/app/styles/_tokens.scss` | [affected.test.ts:113](../../test/affected.test.ts#L113) |
| Edit `public/logo.svg` | affected, reason `input` for `apps/web/public/logo.svg` | [affected.test.ts:123](../../test/affected.test.ts#L123) |

## Computed `import()` patterns

A template `import()` with a relative prefix becomes a pattern. byakugan adds every file the pattern matches to the graph and records the pattern, so git mode also catches a deleted match.

```ts
// src/index.ts
const x = String(Math.random());
export const load = () => import(`./l/${x}a${x}b.js`);
// src/l/1a2b.js matches the pattern
// src/l/zzz.js does not
```

| Change | Result | Test |
| --- | --- | --- |
| Pattern `./l/${x}a${x}a${x}b.js` with `src/l/1a2a3b.js` present | the file is in the graph | [security.test.ts:81](../../test/security.test.ts#L81) |
| Same pattern with `src/l/1a2b.js`, which has too few parts, and `src/l/1a2a3b.ts`, which has the wrong extension | neither is in the graph | [security.test.ts:90](../../test/security.test.ts#L90) |
| Delete `src/l/1a2b.js`, which the pattern matches | git mode: affected | [security.test.ts:111](../../test/security.test.ts#L111) |
| Delete `src/l/zzz.js`, which it does not match | git mode: unaffected | [security.test.ts:117](../../test/security.test.ts#L117) |
| `` import(`./locales/${locale}.json`) `` with `src/locales/en.json` present | `en.json` is in the graph | [security.test.ts:543](../../test/security.test.ts#L543) |
| `src/l` links to `../shared/locales`, pattern `./l/${x}.json` | `src/l/en.json` is in the graph | [security.test.ts:673](../../test/security.test.ts#L673) |
| 30 modules in `src/l/`, each with `` import(`./${x}.ts`) ``, and only `m0` imported | every sibling up to `src/l/m29.ts#load29` is in the graph | [security.test.ts:1361](../../test/security.test.ts#L1361) |
| A pattern that climbs to `/etc` | nothing outside the repository enters the graph or the manifest, warns `points outside the repository` | [security.test.ts:528](../../test/security.test.ts#L528), [security.test.ts:535](../../test/security.test.ts#L535) |

Locale directories linked into the `import()` directory:

```ts
// src/index.ts
export const load = (l: string) => import(`./l/${l}/messages.json`);
// src/l/de -> ../../shared/de
// src/l/fr -> ../../shared/fr
```

| Change | Result | Test |
| --- | --- | --- |
| Add a second link `src/l/at -> ../../shared/de` | affected | [security.test.ts:1258](../../test/security.test.ts#L1258) |
| Add a link `src/other -> ../shared/de`, outside the `import()` directory | unaffected | [security.test.ts:1268](../../test/security.test.ts#L1268) |

The new `at` link adds no new file content. It counts because the app can now load `at`.

### Patterns byakugan cannot follow

An `import()` whose template starts with an alias does not become a pattern. byakugan warns and treats the files it might load as outside the graph.

```ts
// tsconfig.json paths: "@/*": ["./src/*"]
// src/index.ts
export const load = (l: string) => import(`@/messages/${l}.json`);
```

| Change | Result | Test |
| --- | --- | --- |
| Edit `src/messages/de.json` | unaffected, warns `cannot follow import(...)` | [packaging.test.ts:364](../../test/packaging.test.ts#L364) |

This is a known gap, listed under "Paths byakugan cannot read off the code" in [limits](../limits.md#limits). An unresolved static import fails closed and always counts. This one only warns, so add the files to `inputs` when you see the warning.

## `import.meta.glob`

byakugan matches the glob against the directory it names and adds each match to the graph. Exclusions with `!` drop files. A glob or a link that leads outside the repository reads nothing and warns.

```ts
// src/index.ts
export const pages = import.meta.glob(['./pages/*.ts', '!./pages/skip.ts']);
```

| Change | Result | Test |
| --- | --- | --- |
| `src/pages/home.ts` and `src/pages/skip.ts` | `home.ts` is in the graph, `skip.ts` is not | [security.test.ts:1401](../../test/security.test.ts#L1401) |
| Exclusion `!./pages/*a*a*a?.ts`, which `home.ts` does not match | `home.ts` stays in the graph | [security.test.ts:1394](../../test/security.test.ts#L1394) |
| Glob `./l/*a*a...*b.ts` with 12 wildcards | the matching file in `src/l/` is in the graph, a file with the same name in `src/other/` is not | [security.test.ts:159](../../test/security.test.ts#L159), [security.test.ts:168](../../test/security.test.ts#L168) |
| Glob with 512 brace expansions, `./l/{a,b}{a,b}....ts` | `src/l/ababababa.ts` is in the graph, `src/other/ababababa.ts` is not | [security.test.ts:201](../../test/security.test.ts#L201), [security.test.ts:205](../../test/security.test.ts#L205) |
| Glob `./**/**/.../x.ts` with 20 globstars, over `x.ts` files 1 to 30 levels deep and `src/d/d/y.ts` | every `x.ts` is in the graph, `y.ts` is not | [security.test.ts:1457](../../test/security.test.ts#L1457) |
| `src/cfg` links to `../shared`, glob `./cfg/*.ts` | `src/cfg/a.ts#a` is in the graph, no warning | [security.test.ts:1595](../../test/security.test.ts#L1595) |
| `src/cfg` links to a directory outside the repository | nothing from it enters the graph, warns `points outside the repository` | [security.test.ts:1584](../../test/security.test.ts#L1584) |
| A glob that climbs above the repository to `/etc` | nothing outside the repository enters the graph, warns | [security.test.ts:571](../../test/security.test.ts#L571) |
| `require.context` that climbs to `/etc` | not followed, warns | [security.test.ts:578](../../test/security.test.ts#L578) |

Past 256 brace expansions byakugan widens a group to `*`. The paired tests show that widening never pulls in a file from another directory and never drops a file the original glob keeps.

## Files read through `process.cwd()`

byakugan reads `join(process.cwd(), 'dir', ...)` as a path in code and counts the files under it. A path that leaves the repository reads nothing and warns.

```ts
// src/index.ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
export const post = (slug: string) => readFileSync(join(process.cwd(), 'content', slug));
```

| Change | Result | Test |
| --- | --- | --- |
| `join(process.cwd(), 'content/a.md')` | `content/a.md` counts | [security.test.ts:562](../../test/security.test.ts#L562) |
| `join(process.cwd(), '../../.../etc/hosts')` | nothing outside the repository counts, warns `outside the repository` | [security.test.ts:552](../../test/security.test.ts#L552) |
| `content/` holds `a.md` and a link to a FIFO | `content/a.md` still counts, warns `content/feed: cannot read it` | [security.test.ts:404](../../test/security.test.ts#L404) |
| `content/a` and `content/b` link to `../shared/b`, `content/c` links to `../shared/c`. Point `content/a` at `../shared/c` | affected | [security.test.ts:1292](../../test/security.test.ts#L1292) |
| Same setup, edit `notes.md` at the repository root | unaffected | [security.test.ts:1302](../../test/security.test.ts#L1302) |
| `join(process.cwd(), 'vendor/node_modules/cfg', name)`, where `cfg` links outside the repository | the outside file does not count | [security.test.ts:601](../../test/security.test.ts#L601) |

The retarget row edits no file, and both targets were already reachable through another link. It counts because `content/a` now serves the bytes of `shared/c` instead of `shared/b`.

## Files and links outside the repository

byakugan reads nothing outside the git root, with one exception. Installed packages are read through their real path wherever the package store lives, and keyed as `npm:<pkg>/<file>`, so the key holds no absolute path.

| Setup | Result | Test |
| --- | --- | --- |
| `import hosts from '../../.../etc/hosts?raw'` | no key outside the repository | [security.test.ts:613](../../test/security.test.ts#L613) |
| `import hosts from '/etc/hosts?raw'` | no key outside the repository, warns `etc/hosts: outside the repository, so it is not read` | [security.test.ts:618](../../test/security.test.ts#L618) |
| `import text from './notes.txt?raw'` | `src/notes.txt` counts | [security.test.ts:630](../../test/security.test.ts#L630) |
| `package.json` has `"main": "/etc/hosts"` | not an entry, `src/index.ts#x` still counts | [security.test.ts:624](../../test/security.test.ts#L624) |
| `node_modules/left-pad` links into a package store outside the repository, as pnpm lays it out | `npm:left-pad/index.js` counts | [security.test.ts:635](../../test/security.test.ts#L635) |

## MDX

byakugan reads the imports of an `.mdx` file and follows them like imports in code.

```ts
// src/index.ts
import Post from './post.mdx';
// src/post.mdx holds 1000 blank lines, then
//   import { Note } from './note'
//   <Note />
// src/other.ts exports Other, which nothing imports
```

| Change | Result | Test |
| --- | --- | --- |
| The setup above | `src/note.ts#Note` is in the graph | [security.test.ts:325](../../test/security.test.ts#L325) |
| The setup above | nothing from `src/other.ts` is in the graph | [security.test.ts:329](../../test/security.test.ts#L329) |

## `byakugan.json` inputs

`inputs` lists files the build reads that no code imports. byakugan matches each glob the way picomatch would, applies `!` exclusions, and hashes every match.

```json
{ "inputs": ["data/**/*.{json,yml}", "!data/skip/**", ".env*"] }
```

| Change | Result | Test |
| --- | --- | --- |
| Files `data/a.json`, `data/deep/b.yml`, `data/c.txt`, `data/skip/d.json` and `.env.production` | inputs are `data/a.json`, `data/deep/b.yml` and `.env.production` only | [security.test.ts:249](../../test/security.test.ts#L249) |
| `["data/**", "!data/skip.json"]` | `data/x.json` counts, `data/skip.json` does not | [security.test.ts:1380](../../test/security.test.ts#L1380) |
| `["data/**", "!data/{a,b}{a,b}....json"]`, a negation with more than 256 expansions | `data/x.json` still counts | [security.test.ts:1373](../../test/security.test.ts#L1373) |
| `["data/**"]` with a link `data/root -> /` | `data/a.json` counts, byakugan does not walk the link | [security.test.ts:665](../../test/security.test.ts#L665) |

`.env.production` counts here because the list names `.env*`.

Links under an inputs glob:

```json
{ "inputs": ["content/**/*.md"] }
```

```
content/v1/a.md
```

| Change | Result | Test |
| --- | --- | --- |
| Add a link `content/v2 -> v1` | affected | [security.test.ts:1192](../../test/security.test.ts#L1192) |
| Commit the same link on a PR branch | git mode: affected | [security.test.ts:1202](../../test/security.test.ts#L1202) |
| Add `content/v1/notes.txt`, which `*.md` does not match | git mode: unaffected | [security.test.ts:1212](../../test/security.test.ts#L1212) |

## Files git ignores

An ignored file the app imports is affected on every run, with no edit at all. Git has no base version to compare, and CI will not have the file unless the build makes it. List such files under `generated` in `byakugan.json` to say the build makes them, and the reason goes away.

```ts
// .gitignore
src/gen/
// src/main.ts
import { label } from './gen/label';
```

| Change | Result | Test |
| --- | --- | --- |
| No edit, the app imports the ignored `src/gen/label.ts` | affected, reason `src/gen/label.ts` with detail `ignored by git` | [git-mode.test.ts:81](../../test/git-mode.test.ts#L81) |
| No edit, the ignored file exists but nothing imports it | unaffected | [git-mode.test.ts:87](../../test/git-mode.test.ts#L87) |
| Force-add `src/gen/label.ts` and commit it | unaffected. An edit then gives reason `src/gen/label.ts#label` | [git-mode.test.ts:92](../../test/git-mode.test.ts#L92) |
| Add `"generated": ["src/gen/**"]` | unaffected | [git-mode.test.ts:101](../../test/git-mode.test.ts#L101) |
| Add `"generated": ["src/other/**"]`, which does not match | affected, reason `src/gen/label.ts` | [git-mode.test.ts:105](../../test/git-mode.test.ts#L105) |
| Ignored `packages/ui/src/gen/tone.ts` in a workspace package, app sets `"generated": ["../../packages/ui/src/gen/**"]` | unaffected | [git-mode.test.ts:120](../../test/git-mode.test.ts#L120) |
| Same with `"generated": ["../../packages/ui/src/other/**"]` | affected, reason `packages/ui/src/gen/tone.ts` | [git-mode.test.ts:124](../../test/git-mode.test.ts#L124) |
| The app imports an ignored file and a file in a git submodule | affected, the only reason is `src/gen/text.ts` | [git-mode.test.ts:128](../../test/git-mode.test.ts#L128) |
| `config/` is ignored and listed in `"inputs": ["config/*.json"]` | affected, reason `input` for `config/flags.json` with detail `ignored by git` | [git-mode.test.ts:148](../../test/git-mode.test.ts#L148) |
| Same with `"generated": ["config/**"]` | unaffected | [git-mode.test.ts:170](../../test/git-mode.test.ts#L170) |
| Add an ignored `config/.DS_Store` under `"inputs": ["config/**"]` | unaffected, fingerprint unchanged | [git-mode.test.ts:154](../../test/git-mode.test.ts#L154) |
| Add an ignored `.env.local` | unaffected, warns `.env.local: ignored by git` | [git-mode.test.ts:162](../../test/git-mode.test.ts#L162) |

## Symlinks

Git stores a symlink as its target path. Retargeting a link the app imports through counts. Retargeting one nothing reads does not.

```
src/theme.ts -> themes/dark.ts   main.ts imports './theme'
src/old.ts   -> themes/old.ts    nothing imports it
```

| Change | Result | Test |
| --- | --- | --- |
| Point `src/theme.ts` at `themes/light.ts` | affected, reason `src/theme.ts` with detail `symlink changed` | [git-mode.test.ts:581](../../test/git-mode.test.ts#L581) |
| Point `src/old.ts` at `themes/older.ts` | unaffected | [git-mode.test.ts:587](../../test/git-mode.test.ts#L587) |

## Entries and inputs behind a symlink

An entry or input glob follows directory links. Git reports an edit under the real path, and byakugan maps it back to the path the glob lists.

```
linked -> real
real/a.ts
real/b.ts
real/notes.md
real2/a.ts
```

Entry glob `linked/*.ts` unless a row says otherwise.

| Change | Result | Test |
| --- | --- | --- |
| No edit | unaffected | [git-mode.test.ts:182](../../test/git-mode.test.ts#L182) |
| No edit, entry glob `real/*.ts` | unaffected | [git-mode.test.ts:192](../../test/git-mode.test.ts#L192) |
| Edit `real/a.ts` | affected, reason `linked/a.ts#a`, `ignored` is empty | [git-mode.test.ts:186](../../test/git-mode.test.ts#L186), [git-mode.test.ts:196](../../test/git-mode.test.ts#L196) |
| Delete `real/b.ts` | affected | [git-mode.test.ts:611](../../test/git-mode.test.ts#L611) |
| Delete the `real` directory | affected | [git-mode.test.ts:617](../../test/git-mode.test.ts#L617) |
| Delete `real/notes.md`, which no glob lists | unaffected | [git-mode.test.ts:623](../../test/git-mode.test.ts#L623) |
| Point `linked` at `real2` | affected | [git-mode.test.ts:629](../../test/git-mode.test.ts#L629) |
| Remove the `linked` link | affected | [git-mode.test.ts:636](../../test/git-mode.test.ts#L636) |
| Add `linked2 -> real2` under the glob `linked*/*.ts` | affected | [git-mode.test.ts:642](../../test/git-mode.test.ts#L642) |
| Add, retarget, then remove a link `spare` that no glob lists | unaffected each time | [git-mode.test.ts:648](../../test/git-mode.test.ts#L648) |
| `linked` is in `.gitignore` and untracked | affected | [git-mode.test.ts:702](../../test/git-mode.test.ts#L702) |

The last row counts on every run. CI will not have an ignored link, so the entries behind it are missing there.

File links work the same way:

| Change | Result | Test |
| --- | --- | --- |
| File link `entries/page.ts -> ../lib/page.ts`, entry glob `entries/*.ts`. Edit `lib/page.ts` | affected | [git-mode.test.ts:668](../../test/git-mode.test.ts#L668) |
| Same, edit `lib/spare.ts` next to it | unaffected | [git-mode.test.ts:674](../../test/git-mode.test.ts#L674) |
| File link `public/logo.svg -> ../assets/logo.svg`, input `public/**`. Edit `assets/logo.svg` | affected | [git-mode.test.ts:688](../../test/git-mode.test.ts#L688) |
| Same, edit `assets/spare.svg` | unaffected | [git-mode.test.ts:694](../../test/git-mode.test.ts#L694) |

## Symlinks in Next.js `public/`

Next.js serves every link in `public/` at its own URL. Adding or removing a link counts even when the file it points to stays the same.

```
public/a.txt
public/b.txt -> a.txt
public/img/x.png
public/img2 -> img
```

| Change | Result | Test |
| --- | --- | --- |
| Remove the link `public/b.txt` | affected | [security.test.ts:699](../../test/security.test.ts#L699) |
| Add a link `public/c.txt -> a.txt` | git mode: affected | [security.test.ts:706](../../test/security.test.ts#L706) |
| Remove the link `public/img2` | git mode: affected | [security.test.ts:712](../../test/security.test.ts#L712) |
| `public/shared -> ../assets`, inside the repository | `public/shared/logo.svg` counts | [security.test.ts:595](../../test/security.test.ts#L595) |
| `public/cfg` links to a directory outside the repository | nothing from it counts, warns `public/cfg: points outside the repository, so it is not read` | [security.test.ts:585](../../test/security.test.ts#L585) |
| `public/root -> /` | not walked, warns, `public/logo.svg` still counts | [security.test.ts:644](../../test/security.test.ts#L644) |
| `public/zero -> /dev/zero` | does not count, warns `public/zero: points outside the repository` | [security.test.ts:385](../../test/security.test.ts#L385) |
| `public/feed` links to a FIFO inside the repository | does not count, `public/logo.svg` still counts | [security.test.ts:375](../../test/security.test.ts#L375) |
| `public/a/up -> ..` and `public/a/self -> .` form a loop | the run ends, `public/a/x.txt` counts | [security.test.ts:718](../../test/security.test.ts#L718) |
| 2,000 links `public/l<i> -> ../assets/d<i>` | `public/l0/f.txt` through `public/l1999/f.txt` all count | [security.test.ts:1339](../../test/security.test.ts#L1339) |

## A directory linked from elsewhere

A file outside `public/` and `app/` counts when a link brings it into the build. Without the link, edits to it are unaffected.

```
app/media/hero.jpg
public/media -> ../app/media   only in the linked rows
```

| Change | Result | Test |
| --- | --- | --- |
| Edit `app/media/hero.jpg` while `public/media` links to it | affected | [security.test.ts:1103](../../test/security.test.ts#L1103) |
| Same | git mode: affected | [security.test.ts:1120](../../test/security.test.ts#L1120) |
| Edit `app/media/hero.jpg` with no link | unaffected | [security.test.ts:1113](../../test/security.test.ts#L1113) |
| Same | git mode: unaffected | [security.test.ts:1129](../../test/security.test.ts#L1129) |

A `brand/` directory holds `logo.svg` and `icon.png`:

| Change | Result | Test |
| --- | --- | --- |
| `app/brand` and `public/brand` both link to it. Edit `brand/logo.svg` | affected | [security.test.ts:1142](../../test/security.test.ts#L1142) |
| Only `app/brand` links to it. Edit `brand/logo.svg` | unaffected | [security.test.ts:1152](../../test/security.test.ts#L1152) |
| Only `app/brand` links to it. Edit `brand/icon.png` | affected | [security.test.ts:1152](../../test/security.test.ts#L1152) |

Under `app/`, Next.js reads only the files it treats specially, such as `icon.png`. So `logo.svg` there is not part of the build until `public/` also links to it.

Retargeting a committed link, with `assets/` and `assets2/` outside every pattern:

| Change | Result | Test |
| --- | --- | --- |
| Point `public/shared` from `../assets` to `../assets2` | git mode: affected | [security.test.ts:1227](../../test/security.test.ts#L1227) |
| Point `lib/shared`, which no pattern reaches, from `../assets` to `../assets2` | git mode: unaffected | [security.test.ts:1237](../../test/security.test.ts#L1237) |

## Next.js routes added through links in `app/`

A link in `app/` to a directory with route files adds a route.

```
app/page.tsx
app/docs/page.tsx
notes/readme.md
```

| Change | Result | Test |
| --- | --- | --- |
| Add a link `app/blog -> docs`, a new `/blog` route | affected | [security.test.ts:1165](../../test/security.test.ts#L1165) |
| Commit the same link on a PR branch | git mode: affected | [security.test.ts:1175](../../test/security.test.ts#L1175) |
| Add a link `app/notes -> ../notes`, a directory with no route files | unaffected | [security.test.ts:1182](../../test/security.test.ts#L1182) |

## Submodules

A submodule bump counts when the app reads a file inside the submodule. byakugan checks this even when `.gitmodules` sets `ignore = all`.
Here `vendor/lib` is a submodule, and branch `bump` moves it to a commit that changes `label.ts`.

| Change | Result | Test |
| --- | --- | --- |
| Bump, and the app imports `../vendor/lib/label` | affected, reason `vendor/lib` with detail `submodule changed` | [git-mode.test.ts:543](../../test/git-mode.test.ts#L543) |
| Bump, and the app reads nothing inside it | unaffected, `ignored` lists `vendor/lib` | [git-mode.test.ts:548](../../test/git-mode.test.ts#L548) |
| Bump with `ignore = all` in `.gitmodules` | affected | [git-mode.test.ts:554](../../test/git-mode.test.ts#L554) |

## Large binary inputs

byakugan hashes an input over 16 MB the same way as a small one, by its bytes. A change to the file mode alone does not count.

```
public/big.bin   17 MB, in a Next.js app
```

| Change | Result | Test |
| --- | --- | --- |
| The setup above | the hash is the first 20 hex characters of the file's sha256, as for a small file | [security.test.ts:499](../../test/security.test.ts#L499) |
| `chmod 755`, same bytes | git mode: unaffected | [security.test.ts:507](../../test/security.test.ts#L507) |
| Change the last byte | git mode: affected, reason `public/big.bin` | [security.test.ts:515](../../test/security.test.ts#L515) |

## Odd file names

Git mode reads base contents by exact path, so names with spaces, quotes, tabs, newlines or carriage returns map to the right file.

| Change | Result | Test |
| --- | --- | --- |
| Five files named with a space, Polish letters, a double quote, a tab and a newline. Edit a used export in three and an unused export in two | affected for exactly the three used exports `#used0`, `#used2` and `#used4`, `ignored` lists the other two | [git-mode.test.ts:1135](../../test/git-mode.test.ts#L1135) |
| Input `data/a\r b`, with a CR inside the name, changes from `one` to `two` while `data/a b` already holds `two` | affected, reason `input` for `data/a\r b` | [git-mode.test.ts:1160](../../test/git-mode.test.ts#L1160) |
| Same with `data/a b\r`, a name that ends in CR | affected, reason `input` for `data/a b\r` | [git-mode.test.ts:1164](../../test/git-mode.test.ts#L1164) |
