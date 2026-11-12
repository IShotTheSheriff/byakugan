# Configuration

Everything is optional. Put a `byakugan.json` next to the app's `package.json`.
byakugan reads it from the directory it runs in (`-C <dir>`). The file does two
things:

- It fills in what byakugan cannot detect: entries outside the framework's
  conventions, files that a tool reads without an import, imports that a
  bundler plugin provides, and how Tailwind compiles the stylesheets.
- It makes a directory an app. `--workspace` gives a verdict to every package
  with a `byakugan.json`, even a library or a test package with no framework.
  A test package with `{ "entry": ["tests/**/*.spec.ts"] }` gets one verdict,
  and an edited spec counts.

An app that uses most fields:

```json
{
  "entry": ["scripts/seed.ts"],
  "inputs": ["messages/*.json"],
  "packages": ["@sentry/nextjs"],
  "conditions": ["source"],
  "generated": ["src/generated/**"],
  "virtual": ["~icons/**"],
  "modularizeImports": {
    "my-icons": { "transform": "my-icons/icons/{{ kebabCase member }}" }
  }
}
```

| Field               | Meaning                                                                                                         |
| ------------------- | --------------------------------------------------------------------------------------------------------------- |
| `entry`             | Extra entry globs, added to the detected ones.                                                                  |
| `inputs`            | Extra globs hashed as whole files.                                                                              |
| `packages`          | Packages tracked by installed version.                                                                          |
| `framework`         | `next`, `vite`, `react-router`, `nuxt`, `sveltekit`, `astro`, `react-native` or `none`. Overrides detection; `none` disables framework entries. |
| `conditions`        | Export conditions tried first. Use `["source"]` when workspace packages point `exports` at `dist`.              |
| `modularizeImports` | Same shape as the Next.js option. Merged over the built-in `lodash` rule.                                       |
| `jsxImportSource`   | Defaults to `compilerOptions.jsxImportSource` from `tsconfig.json`, then `react`.                               |
| `generated`         | Git-ignored files the build generates, such as a Prisma client. Git mode skips its "ignored by git" reason for them. List the generator's inputs in `inputs`. |
| `virtual`           | Specifiers a bundler plugin provides (globs), such as `~icons/**` for unplugin-icons. They no longer count as unresolved. |
| `env`               | Environment variables whose values count when live code reads them (globs over names), such as `API_*`. |
| `mode`              | `behavior` (default) or `strict`. See [Modes](commands.md#modes).                                                          |
| `tailwind`          | `false` skips Tailwind and the hash of the CSS it generates. For a graph that feeds a typecheck or unit tests, which never read that CSS. |
| `tailwindDir`       | Directory whose PostCSS and Tailwind configs compile the stylesheets, relative to the project and inside the repository. Storybook in a host package compiles other packages' stylesheets with the host's configs. |
| `postcssFromStylesheet` | `true` reads each stylesheet's PostCSS config from its own directory up to the repository root, as webpack's postcss-loader does. By default the project's own config counts, as in Next.js and Vite. |

byakugan rejects a `byakugan.json` that is not valid JSON or has a field of
the wrong type, for example a string where a list belongs.
