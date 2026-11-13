# Git mode, manifests and --each

How `byakugan affected` picks the base side, how a saved manifest replaces it, which files `--each` selects, and what `byakugan compare` ignores between two builds.

[All examples](README.md)

## Branches and merge base

`affected --base main` compares the working tree with the merge base of `main` and `HEAD`. Commits that landed on `main` after you branched do not count, unless the clone is too shallow to hold the merge base.

```ts
// src/main.ts
import { greet } from './greet';
console.log(greet());
```

| Affected | Unaffected |
| --- | --- |
| `main` edits `greet.ts` after the branch point, in a shallow clone where `main` and `feature` share no commit. Reason `src/greet.ts#greet`, warns `main and HEAD have no merge base` [git-mode.test.ts:1098](../../test/git-mode.test.ts#L1098) | `main` edits `greet.ts` after the branch point, `feature` edits nothing the app uses. No warnings [git-mode.test.ts:1092](../../test/git-mode.test.ts#L1092) |

<details>
<summary>2 more cases</summary>

| Setup | Change | Result | Test |
| --- | --- | --- | --- |
| `test/fixtures/monorepo`, a Next.js app in `apps/web` that renders `Hero` | On branch `feature`, commit an edit to `components/Unused.tsx` | unaffected | [affected.test.ts:88](../../test/affected.test.ts#L88) |
| same | Then commit an edit to `components/Hero.tsx` on the same branch | affected, reason `apps/web/components/Hero.tsx#Hero` | [affected.test.ts:88](../../test/affected.test.ts#L88) |

</details>

Without a merge base, byakugan compares against the tip of `main`, so the edit `main` made to `greet.ts` shows up as yours. Set `fetch-depth: 0` on `actions/checkout`, as [ci.md](../ci.md) shows.

## Manifest mode

`hash --manifest <file>` saves a hash per fragment, and `affected --base-manifest <file>` compares the current graph with that file instead of the git base. A manifest from another byakugan version, format or mode can't be compared fragment by fragment, so byakugan reports affected with one reason that says why.

| Affected | Unaffected |
| --- | --- |
| The manifest has a fragment `__proto__` that the current graph lacks. Reason `__proto__: no longer used` [security.test.ts:930](../../test/security.test.ts#L930) | Write a manifest, compare the same tree against it [security.test.ts:947](../../test/security.test.ts#L947), [git-mode.test.ts:1127](../../test/git-mode.test.ts#L1127) |

<details>
<summary>4 more cases</summary>

| Change | Result | Test |
| --- | --- | --- |
| Manifest written by byakugan 0.0.1 | affected, one reason, `written by byakugan 0.0.1 and this is ...` | [select.test.ts:231](../../test/select.test.ts#L231) |
| Manifest in format 1 | affected, `has format 1 and this byakugan writes format 2` | [select.test.ts:239](../../test/select.test.ts#L239) |
| Manifest written in `behavior` mode, run in `strict` | affected, `written in behavior mode and this run is in strict mode` | [select.test.ts:246](../../test/select.test.ts#L246) |
| Same version and mode, no change | unaffected | [select.test.ts:252](../../test/select.test.ts#L252) |

</details>

## --each in git mode

`affected --each 'src/**/*.test.ts'` makes every matching file a root and prints the ones a change reaches, walking back from each reason to the test files. A change to the test runner config or `package.json` selects every test.

```ts
// src/ui/index.ts
export { Button } from './Button';
export { Card } from './Card';
// src/button.test.ts imports Button from './ui'
// src/card.test.ts imports Card from './ui'
```

| Change | Result | Test |
| --- | --- | --- |
| Edit `src/ui/Card.ts`, behind the barrel | selects `src/card.test.ts` | [select.test.ts:57](../../test/select.test.ts#L57) |

<details>
<summary>12 more cases</summary>

The rest of the fixture:

```ts
// src/math.ts
export const add = (a, b) => a + b;
export const sub = (a, b) => a - b;
export const unused = () => 0;
// src/pad.ts
import pad from 'left-pad';
export const padded = (s) => pad(s, 4);
// src/add.test.ts imports add
// src/sub.test.ts imports sub and padded
// also vitest.config.ts, and package.json and package-lock.json with left-pad 1.0.0
```

| Change | Result | Test |
| --- | --- | --- |
| Edit `add` in `math.ts` | selects `src/add.test.ts` | [select.test.ts:49](../../test/select.test.ts#L49) |
| Edit `unused` in `math.ts` | selects none | [select.test.ts:53](../../test/select.test.ts#L53) |
| Bump left-pad to 1.0.1 in `package-lock.json` | selects `src/sub.test.ts` | [select.test.ts:61](../../test/select.test.ts#L61) |
| Edit `vitest.config.ts` | selects all four | [select.test.ts:65](../../test/select.test.ts#L65) |
| Change `type` in `package.json` | selects all | [select.test.ts:71](../../test/select.test.ts#L71) |
| Add `src/new.test.ts` | selects `src/new.test.ts` | [select.test.ts:76](../../test/select.test.ts#L76) |
| Delete `src/card.test.ts` | selects none | [select.test.ts:76](../../test/select.test.ts#L76) |
| Edit `src/add.test.ts` | selects `src/add.test.ts` | [select.test.ts:81](../../test/select.test.ts#L81) |
| `uses.test.ts` imports `check` from `shared.test.ts`, which uses `add`. Edit `add` | selects `add.test.ts`, `shared.test.ts` and `uses.test.ts` | [select.test.ts:85](../../test/select.test.ts#L85) |
| Same setup, edit `sub` | selects `src/sub.test.ts` only | [select.test.ts:85](../../test/select.test.ts#L85) |
| `one.test.ts` and `two.test.ts` both import `./snippet.ts?raw`. Add a comment to `snippet.ts` | selects both | [select.test.ts:96](../../test/select.test.ts#L96) |
| `"env": ["API_*"]`, `url.ts` reads `process.env.API_URL` and two tests import it. `API_URL` changes from `a` to `b`, compared against a manifest | selects the two tests, not a third | [select.test.ts:106](../../test/select.test.ts#L106) |

</details>

The `?raw` row counts a comment because a `?raw` import hands the test the file's text. Through a normal import, comments do not count.

## --each against a manifest

`hash --each <glob> --manifest <file>` also saves one fingerprint per matched file, over the fragments that file reaches, and `affected --each <glob> --base-manifest <file>` selects the files whose fingerprint moved. This catches a fragment that left the graph, which gives the walk nowhere to start.

Same fixture as the previous section.

| Change | Result | Test |
| --- | --- | --- |
| Delete the `sub` export from `math.ts` | selects `src/sub.test.ts` | [select.test.ts:175](../../test/select.test.ts#L175) |

<details>
<summary>16 more cases</summary>

The last three rows run the CLI on a smaller app.

```sh
byakugan hash --each 'src/**/*.test.ts' --manifest out/tests.json
byakugan affected --each 'src/**/*.test.ts' --base-manifest out/tests.json --exit-code
```

| Setup | Change | Result | Test |
| --- | --- | --- | --- |
| previous section | No change | selects none | [select.test.ts:154](../../test/select.test.ts#L154) |
| same | Edit `add` | selects `src/add.test.ts` | [select.test.ts:158](../../test/select.test.ts#L158) |
| same | Edit `unused` | selects none | [select.test.ts:162](../../test/select.test.ts#L162) |
| same | Edit `src/ui/Card.ts` | selects `src/card.test.ts` | [select.test.ts:166](../../test/select.test.ts#L166) |
| same | `sub.test.ts` drops its `padded` import | selects `src/sub.test.ts` only | [select.test.ts:170](../../test/select.test.ts#L170) |
| same | Edit `node_modules/left-pad/index.js` | selects `src/sub.test.ts` | [select.test.ts:180](../../test/select.test.ts#L180) |
| same | Edit `vitest.config.ts` | selects all four | [select.test.ts:185](../../test/select.test.ts#L185) |
| same | Add `src/new.test.ts` | selects `src/new.test.ts` | [select.test.ts:189](../../test/select.test.ts#L189) |
| same | Delete `src/card.test.ts` | selects none | [select.test.ts:189](../../test/select.test.ts#L189) |
| same | `add.test.ts` gains `import './gone'`, which does not resolve | selects all four | [select.test.ts:195](../../test/select.test.ts#L195) |
| same | Manifest saved in `behavior` mode, run in `strict` | selects all | [select.test.ts:201](../../test/select.test.ts#L201) |
| same | Manifest saved without per-file fingerprints | selects all | [select.test.ts:209](../../test/select.test.ts#L209) |
| same | Edit `src/ui/Button.ts` | the fingerprint of `button.test.ts` moves, the other three stay the same | [select.test.ts:215](../../test/select.test.ts#L215) |
| CLI, `src/math.ts` exports `add` and `sub`, one test file for each | No change | prints nothing | [cli.test.ts:213](../../test/cli.test.ts#L213) |
| same | Replace `src/sub.test.ts` with `console.log(1);` | prints only `src/sub.test.ts`, exit code 1 | [cli.test.ts:213](../../test/cli.test.ts#L213) |
| same | The manifest came from `hash` without `--each` | exit code 2, error `has no per-file fingerprints` | [cli.test.ts:225](../../test/cli.test.ts#L225) |

</details>

An import that does not resolve in one test file selects every test, because byakugan cannot tell what that file reaches.

## Storybook

`--each 'src/**/*.stories.ts'` selects stories the same way. `.storybook/main.ts` and whatever `.storybook/preview.ts` imports reach every story.

```ts
// .storybook/preview.ts
import { theme } from '../src/theme';
// src/button.stories.ts imports Button from './ui'
// src/card.stories.ts imports Card from './ui'
```

| Change | Result | Test |
| --- | --- | --- |
| Edit `src/ui/Card.ts` | selects `src/card.stories.ts` | [select.test.ts:276](../../test/select.test.ts#L276) |
| Edit `src/theme.ts`, which `.storybook/preview.ts` imports | selects both stories | [select.test.ts:280](../../test/select.test.ts#L280) |
| Edit `.storybook/main.ts` | selects all | [select.test.ts:286](../../test/select.test.ts#L286) |

## byakugan compare

`byakugan compare <base build dir> <fresh build dir>` lists the files that differ between two build outputs. In a Next.js build it drops the build ID, the encryption key, the checkout path, `cache/` and `trace`, so two builds of the same code match.

| Change between build A and build B | Result | Test |
| --- | --- | --- |
| Different build ID, encryption key, checkout path, cache and trace, same code | no differences | [compare.test.ts:20](../../test/compare.test.ts#L20) |

<details>
<summary>4 more cases</summary>

Where the noise lives in a Next.js build:

```
BUILD_ID
required-server-files.json            outputFileTracingRoot is the checkout path
static/<build id>/_buildManifest.js
server/app/page.js
server/server-reference-manifest.json  holds encryptionKey
cache/
trace
```

| Change between build A and build B | Result | Test |
| --- | --- | --- |
| `render(1)` becomes `render(2)` in `server/app/page.js` | a difference in `server/app/page.js` | [compare.test.ts:26](../../test/compare.test.ts#L26) |
| B has an extra `server/app/extra.js` | `server/app/extra.js: only in the fresh build` | [compare.test.ts:32](../../test/compare.test.ts#L32) |
| `page.js.map` differs only in `sourcesContent` | no differences, and a difference with `--maps` | [compare.test.ts:38](../../test/compare.test.ts#L38) |
| Output that is not Next.js, `cache/data.js` and `trace` differ | both are differences | [compare.test.ts:47](../../test/compare.test.ts#L47) |

</details>

## Many changed files

Git mode checks each changed fragment on its own, however many files change. An edit counts only if it hits a fragment the app uses.

| Affected | Unaffected |
| --- | --- |
| 300 modules, edit the unused `g<i>` in every one plus the used `f2` in `src/zażółć.ts` and `f299`. Reasons `src/m299.ts#f299` and `src/zażółć.ts#f2` only [packaging.test.ts:243](../../test/packaging.test.ts#L243) | 300 modules, edit the unused export `g<i>` in every one [packaging.test.ts:235](../../test/packaging.test.ts#L235) |

<details>
<summary>3 more cases</summary>

| Change | Result | Test |
| --- | --- | --- |
| `src/used.ts` and `src/unused.ts` both `export * from './a'` and `'./b'`, the app imports `a` from `used.ts`. Remove `export * from './b'` in `unused.ts` | unaffected | [packaging.test.ts:295](../../test/packaging.test.ts#L295) |
| Then remove the same line in `used.ts` | affected, reason `src/used.ts#export*:./b` | [packaging.test.ts:295](../../test/packaging.test.ts#L295) |
| 60 barrels of 50 `export *` lines each, drop every other line | 1500 reasons, one per removed line | [packaging.test.ts:269](../../test/packaging.test.ts#L269) |

</details>

The app takes `a` through `./a`, yet removing `export * from './b'` from `used.ts` counts, because the removed line could have supplied a name the app takes.

## Git edge cases

The app imports `src/gen.ts`, which `.gitignore` lists, and a file from the submodule `vendor/lib`.

| Change | Result | Test |
| --- | --- | --- |
| Edit `src/gen.ts` | affected, reason `src/gen.ts` | [packaging.test.ts:581](../../test/packaging.test.ts#L581) |
| Same setup with nothing ignored, edit `README.md` | unaffected | [packaging.test.ts:589](../../test/packaging.test.ts#L589) |
