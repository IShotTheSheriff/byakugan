# Configuration

Everything is optional. Put a `byakugan.json` next to the app's `package.json`:

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

byakugan rejects a `byakugan.json` that is not valid JSON or has a field of
the wrong type, for example a string where a list belongs.
