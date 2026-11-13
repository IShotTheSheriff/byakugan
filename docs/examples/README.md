# Examples

Each page lists cases of the form "you have this code, you make this change,
byakugan says affected or unaffected". Every row links to the test that
asserts its result, where you can read the exact setup. Each topic
shows its rule and the pair that marks where the line falls. The rest of its
cases sit under "N more cases".

| Page | Cases | What it covers |
| --- | --- | --- |
| [Exports, barrels and code](code.md) | 251 | Unused exports next to used ones, named re-exports, `export *` barrels, imports that run modules, top-level code, declaration order, TypeScript and JSX settings, comments and formatting |
| [npm packages, lockfiles and resolution](packages.md) | 180 | lodash and ES module packages, files in `node_modules`, lockfile formats, patches, workspace packages, tsconfig paths, imports that do not resolve |
| [CSS, Sass and Tailwind](styles.md) | 145 | CSS import order, CSS Modules, Sass and Less, `url()`, Tailwind v3 and v4, Tailwind in a workspace, Vite `?raw` and `?url` imports |
| [Files, renames, deletions and links](files.md) | 121 | Case-only renames, deleted files, computed `import()`, `import.meta.glob`, `fs` reads, `inputs`, git-ignored files, symlinks, submodules |
| [Frameworks and workspaces](frameworks.md) | 108 | Next.js `'use server'` and `'use client'`, Vite, Hono, SvelteKit, Nuxt, Astro, React Router, Expo, Vue and Svelte components, environment variables, which packages are apps |
| [Git mode, manifests and --each](git-mode.md) | 55 | The merge base, shallow clones, manifest mode, which test files `--each` selects, `byakugan compare` |

## Reading a row

"Affected" means `byakugan affected --base main` reports a change, or the
fingerprint moves. Some rows name the reason key the test checks, such as
`src/lib.ts#price` (one declaration) or `npm:lodash` (a package). Rows run in
the default `behavior` mode unless they say `strict`. [Modes](../commands.md#modes)
has the difference.

Most cases come in pairs: a change that counts and a change next to it that
does not. A pair shows where the line falls. For example, renaming `Hello.ts`
to `hello.ts` is affected when `main.ts` imports `./Hello`, and renaming
`Unused.ts` to `unused.ts` is not.

When a result is a known gap, the row links to [limits](../limits.md).
[How byakugan works](../how-it-works.md) explains the model behind the rows.
