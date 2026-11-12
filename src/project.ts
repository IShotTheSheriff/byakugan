import { existsSync, lstatSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { globSync } from 'tinyglobby';
import { readText, stripBlocks } from './fs.ts';
import { gitRoot, trackedLinks } from './git.ts';
import { OS_FILES, safeGlob } from './glob.ts';
import { parseJsonc } from './jsonc.ts';
import type { ParseOptions } from './parse.ts';
import type { ModularizeRule } from './resolve.ts';

export type Framework = 'next' | 'vite' | 'react-router' | 'nuxt' | 'sveltekit' | 'astro' | 'react-native' | 'none';

/** Contents of `byakugan.json`. Every field is optional. */
export interface Config {
  /** Extra entry files (globs). Every export of an entry counts as used. */
  entry?: string[];
  /** Extra files hashed whole, e.g. `.env.production` or `messages/*.json`. */
  inputs?: string[];
  /** Packages tracked by installed version, for tools that read your code without importing it. */
  packages?: string[];
  /** Skip auto-detection. `none` disables framework entries. */
  framework?: Framework;
  /** Same shape as Next.js `modularizeImports`. Merged over the built-in `lodash` rule. */
  modularizeImports?: Record<string, ModularizeRule>;
  /** Export conditions tried first, e.g. `["source"]` for workspace packages that point `exports` at `dist`. */
  conditions?: string[];
  jsxImportSource?: string;
  /**
   * Git-ignored files the build generates from tracked inputs (globs relative to the project),
   * e.g. a Prisma client in `src/generated/**`. List the generator's inputs in `inputs`.
   * Git mode cannot compare ignored files, so without this it reports them as affected.
   */
  generated?: string[];
  /**
   * Specifiers a bundler plugin provides, which no file on disk backs (globs), e.g. `~icons/**`
   * for unplugin-icons. Other unresolved imports of project code count as affected.
   */
  virtual?: string[];
  /**
   * Environment variables whose values count when live code reads them (globs over names).
   * Added to the ones the framework inlines at build time, `NEXT_PUBLIC_*` or `VITE_*`.
   */
  env?: string[];
  /**
   * What a verdict promises. `behavior` (the default): an unaffected app runs the same, so its
   * tests can be skipped. `strict`: its build output is the same too, so the build can be reused.
   * `strict` also counts code the bundler ships but nothing runs.
   */
  mode?: Mode;
  /** `false` skips Tailwind, for checks that never read the CSS it generates, such as a typecheck. */
  tailwind?: boolean;
  /**
   * Directory whose PostCSS and Tailwind configs compile the stylesheets, relative to the project.
   * Storybook in a host package compiles other packages' stylesheets with the host's configs.
   */
  tailwindDir?: string;
  /** Read each stylesheet's PostCSS config from its own directory up, as webpack's postcss-loader does. */
  postcssFromStylesheet?: boolean;
}

export type Mode = 'behavior' | 'strict';
const MODES = ['behavior', 'strict'];

export interface Project {
  dir: string;
  /** Workspace root: the nearest directory with a lockfile, else the git root. Fragment keys are relative to it. */
  root: string;
  /** Git root, or `root` outside git. Paths in code and inputs must stay inside it. */
  repo: string;
  framework: Framework;
  config: Config;
  entries: string[];
  inputs: string[];
  /** Globs (relative to `dir`) that produced `inputs`. Used to notice deleted inputs. */
  inputPatterns: string[];
  /** Globs (relative to `dir`) that produced `entries`. A deleted file matching one was an entry. */
  entryPatterns: string[];
  /** Absolute paths that config files name, present or not. Deleting one changes the build. */
  namedFiles: string[];
  packages: string[];
  jsxImportSource: string;
  manifest: Record<string, unknown> | undefined;
  /** The lockfile installs come from, if any. Without one, dependency ranges in package.json count. */
  lockfile: string | undefined;
  /** jsconfig.json when the project has no tsconfig.json; the resolver reads `paths` from it. */
  tsconfig: string | undefined;
  /** Compiler options that change what code means (`verbatimModuleSyntax`, classic JSX). */
  parseOptions: ParseOptions;
  /** Absolute `baseUrl` directories. */
  baseUrls: string[];
  /** Sass `includePaths` / `loadPaths` from next.config or vite.config. */
  styleLoadPaths: string[];
  /** Specifiers Sass `additionalData` loads at the top of every stylesheet. */
  styleGlobals: string[];
  /** A Cloudflare Workers config exists. */
  workers: boolean;
  /** Import aliases the framework sets up, such as SvelteKit's `$lib`, as absolute directories. */
  aliases: Record<string, string[]>;
  /** Candidate paths for `specifier` under tsconfig `paths` and `baseUrl`. */
  aliasTargets(specifier: string): string[];
  /** Candidate paths for `specifier` under tsconfig `paths` only. */
  pathTargets(specifier: string): string[];
}

export interface LoadProjectOptions {
  cwd?: string;
  config?: Config;
}

const IGNORE = [
  '**/node_modules/**',
  '**/.git/**',
  '**/.next/**',
  '**/.turbo/**',
  '**/.vercel/**',
  '**/dist/**',
  '**/build/**',
  '**/out/**',
  '**/coverage/**',
];

const CODE = '{js,jsx,ts,tsx,mjs,cjs,mts,cts}';
const CONFIG_EXT = '{js,mjs,cjs,ts,mts,cts}';
const ROUTE_EXTENSIONS = ['js', 'jsx', 'ts', 'tsx', 'mjs', 'md', 'mdx'];

const NEXT_APP_FILES = [
  'page',
  'layout',
  'template',
  'loading',
  'error',
  'global-error',
  'global-not-found',
  'not-found',
  'forbidden',
  'unauthorized',
  'default',
  'route',
  'icon',
  'apple-icon',
  'opengraph-image',
  'twitter-image',
  'sitemap',
  'robots',
  'manifest',
].join(',');

const NEXT_STATIC_METADATA =
  '{favicon.ico,icon*.{ico,jpg,jpeg,png,svg},apple-icon*.{jpg,jpeg,png},opengraph-image*.{jpg,jpeg,png,gif},twitter-image*.{jpg,jpeg,png,gif},*.alt.txt,robots.txt,sitemap.xml,manifest.{json,webmanifest}}';

const TOOL_CONFIGS = [`postcss.config.${CONFIG_EXT}`, `tailwind.config.${CONFIG_EXT}`, `babel.config.${CONFIG_EXT}`];

/** Build settings that are not code. Next.js looks them up in parent directories too. */
const TOOL_FILES = [
  '.babelrc',
  '.babelrc.json',
  'babel.config.json',
  '.swcrc',
  '.browserslistrc',
  'browserslist',
  '.postcssrc*',
  'postcss.config.json',
];

const TOOL_INPUTS = [
  'package.json',
  'tsconfig*.json',
  'jsconfig*.json',
  '.env*',
  ...TOOL_FILES,
  '**/*.d.ts',
  'wrangler.{toml,json,jsonc}',
  'vercel.json',
  'netlify.toml',
];

/** Generated by `next dev` and `next build`, often git-ignored: hashing it would differ before and after a build. */
const INPUT_IGNORE = [...IGNORE, ...OS_FILES, '**/next-env.d.ts', '**/.react-router/**'];

/** Entry points hosting platforms pick up from the file layout. */
const PLATFORM_ENTRIES = [`api/**/*.${CODE}`, `netlify/{functions,edge-functions}/**/*.${CODE}`];

/** Build and runtime tools tracked by version in every project, when they are dependencies. */
const TOOL_PACKAGES = ['typescript', 'wrangler', 'esbuild', 'tsx', 'tsup', 'tsdown', '@swc/core', '@vercel/node'];

const NEXT_PACKAGES = [
  'next',
  'react',
  'react-dom',
  'typescript',
  'tailwindcss',
  '@tailwindcss/postcss',
  '@tailwindcss/turbopack',
  'postcss',
  'autoprefixer',
  'sass',
  'babel-plugin-react-compiler',
  '@next/mdx',
];

const VITE_PACKAGES = ['vite', 'react', 'react-dom', 'typescript', 'tailwindcss', '@tailwindcss/vite', 'postcss', 'autoprefixer', 'sass'];
const NUXT_PACKAGES = ['nuxt', 'vue', 'vue-router', 'typescript', 'vite', 'postcss', 'sass', 'tailwindcss'];
const SVELTEKIT_PACKAGES = ['@sveltejs/kit', 'svelte', 'vite', '@sveltejs/vite-plugin-svelte', 'typescript', 'postcss', 'sass', 'tailwindcss'];
const REACT_NATIVE_PACKAGES = ['react-native', 'react', 'expo', 'expo-router', 'typescript', 'metro', '@expo/metro-config', 'babel-preset-expo', '@react-native/babel-preset'];
const ASTRO_PACKAGES = ['astro', 'vite', 'typescript', 'postcss', 'sass', 'tailwindcss'];
/** Code a component framework compiles: its own files plus scripts. */
const COMPONENT_CODE = '{vue,svelte,astro,js,jsx,ts,tsx,mjs,cjs,mts,cts}';

/**
 * Directories a framework generates on install or build (`nuxt prepare`, `svelte-kit sync`).
 * The app's tsconfig extends a file in them, so git mode skips them like `generated` files.
 */
export const FRAMEWORK_GENERATED: Partial<Record<Framework, string[]>> = {
  nuxt: ['.nuxt/**', '.output/**'],
  sveltekit: ['.svelte-kit/**'],
  astro: ['.astro/**'],
  'react-native': ['.expo/**'],
};

/** Aliases a framework defines in a tsconfig it generates, for runs before that file exists. */
const frameworkAliases = (framework: Framework, dir: string): Record<string, string[]> => {
  if (framework === 'sveltekit') return { $lib: [join(dir, 'src/lib')] };
  if (framework === 'nuxt') {
    const src = existsSync(join(dir, 'app', 'app.vue')) || existsSync(join(dir, 'app', 'pages')) ? join(dir, 'app') : dir;
    return { '~': [src], '@': [src], '~~': [dir], '@@': [dir] };
  }
  return {};
};

/** Modules a framework provides at build time, which no file backs. */
export const FRAMEWORK_VIRTUAL: Partial<Record<Framework, string[]>> = {
  nuxt: ['#*', '#*/**'],
  sveltekit: ['$app/**', '$env/**', '$service-worker'],
  astro: ['astro:*', 'astro:*/**'],
};

/** Browser targets come from caniuse-lite data, a transitive dependency nobody declares. */
const BROWSER_DATA_USERS = ['autoprefixer', 'postcss-preset-env', 'browserslist', '@babel/preset-env'];
const BROWSER_DATA = ['caniuse-lite', 'browserslist'];

const both = (pattern: string) => [pattern, `src/${pattern}`];

/** Files Next.js plugins load by convention, without an import from app code. */
const PLUGIN_ENTRIES: Record<string, string[]> = {
  'next-intl': [...both(`i18n/request.${CODE}`), ...both(`i18n.${CODE}`)],
  '@sentry/nextjs': [`sentry.{client,server,edge}.config.${CODE}`],
  // HonoX: the Vite plugin loads app/server.ts and app/client.ts, createApp() globs the routes.
  honox: [`app/{server,client}.${CODE}`, 'app/routes/**/*.{ts,tsx,js,jsx,md,mdx}', `app/islands/**/*.${CODE}`, 'app/**/$*.{ts,tsx,js,jsx}'],
};

const isBuildOutput = (path: string) => /(^|\/)(dist|build|out|\.output|\.wrangler)(\/|$)/.test(path.replace(/^\.\//, ''));

/** Cloudflare Workers: `main` is the entry, `assets.directory` (or `site.bucket`) ships as is. */
const wrangler = (dir: string): { entries: string[]; inputs: string[]; named: string[]; found: boolean } => {
  const out = { entries: [] as string[], inputs: [] as string[], named: [] as string[], found: false };
  for (const name of ['wrangler.jsonc', 'wrangler.json', 'wrangler.toml']) {
    const file = join(dir, name);
    if (!existsSync(file)) continue;
    out.found = true;
    const text = readText(file) ?? '';
    const values: string[][] = [[], []];
    if (name.endsWith('.toml')) {
      for (const m of text.matchAll(/^[ \t]*main[ \t]*=[ \t]*["']([^"']+)["']/gm)) values[0].push(m[1]);
      for (const m of text.matchAll(/^[ \t]*(?:directory|bucket)[ \t]*=[ \t]*["']([^"']+)["']/gm)) values[1].push(m[1]);
    } else {
      const visit = (config: Record<string, unknown> | undefined) => {
        if (typeof config?.main === 'string') values[0].push(config.main);
        const assets = config?.assets as Record<string, unknown> | undefined;
        const site = config?.site as Record<string, unknown> | undefined;
        for (const d of [assets?.directory, site?.bucket]) if (typeof d === 'string') values[1].push(d);
        for (const env of Object.values((config?.env as Record<string, Record<string, unknown>>) ?? {})) visit(env);
      };
      visit(readJson(file));
    }
    for (const main of values[0]) {
      if (isBuildOutput(main)) continue;
      out.named.push(resolve(dir, main));
      if (existsSync(resolve(dir, main))) out.entries.push(resolve(dir, main));
    }
    for (const assets of values[1]) if (!isBuildOutput(assets)) out.inputs.push(`${assets.replace(/^\.\//, '').replace(/\/$/, '')}/**`);
  }
  return out;
};

/** Config files whose string literals can name packages or files: `plugins: ["@tailwindcss/postcss"]`. */
const CONFIG_FILE = /(^|[\\/])(next|postcss|tailwind|babel|vite|react-router)\.config\.[cm]?[jt]s$|(^|[\\/])\.(babelrc|postcssrc)(\.json)?$/;

/** React Router `app/routes.ts` names route modules by path. */
const NAMES_FILES = /(^|[\\/])routes\.[cm]?[jt]s$/;

/**
 * Files a config file names in a string, such as Vite inputs (`/app/client.ts`),
 * `entry: 'src/index.tsx'` for a Hono Vite build, or `route('about', 'routes/about.tsx')`.
 * A leading `/` is the project root.
 */
const filesNamedIn = (files: string[], dir: string, named: string[]): string[] => {
  const out: string[] = [];
  for (const file of files) {
    if (!CONFIG_FILE.test(file) && !NAMES_FILES.test(file)) continue;
    const text = readText(file);
    if (text === undefined) continue;
    for (const match of text.matchAll(/['"`]([^'"`\s*?:<>|{}$]+\.[A-Za-z0-9]{1,6})['"`]/g)) {
      const path = match[1];
      const target = path.startsWith('/') ? join(dir, path) : resolve(dirname(file), path);
      if (target !== file && /\.[cm]?[jt]sx?$|\.css$/.test(target)) named.push(target);
      if (target !== file && !target.includes('/node_modules/') && !isBuildOutput(relative(dir, target)) && isFile(target)) out.push(target);
    }
  }
  return out;
};

const isFile = (path: string) => {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
};

/** Dependencies a config file names, quoted (`"@tailwindcss/postcss"`) or as a plain key (`cssnano: {}`). */
const packagesNamedIn = (files: string[], deps: string[]): string[] => {
  const out = new Set<string>();
  for (const file of files) {
    if (!CONFIG_FILE.test(file)) continue;
    const text = readText(file);
    if (text === undefined) continue;
    for (const dep of deps) {
      if (!text.includes(dep)) continue;
      const escaped = dep.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
      const quoted = new RegExp(`['"\`]${escaped}(/[^'"\`]*)?['"\`]`);
      const key = /^[A-Za-z_$][\w$]*$/.test(dep) && new RegExp(`(^|[\\s{,])${escaped}\\s*:`).test(text);
      if (key || quoted.test(text)) out.add(dep);
    }
  }
  return [...out];
};

const readJson = (file: string): Record<string, unknown> | undefined => {
  const text = readText(file);
  if (text === undefined) return;
  try {
    const value = parseJsonc(text);
    return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined;
  } catch {
    return;
  }
};

/** Globs relative to `dir`; byakugan.json may hold `!` patterns. Symlinks are followed only inside `boundary`. */
const glob = (dir: string, patterns: string[], boundary: string, ignore = IGNORE) => safeGlob(patterns, { cwd: dir, dot: true, ignore, boundary });

/** Files directly in `dir` (no crawl): config files and project signs. */
const topLevel = (dir: string, patterns: string[]) => globSync(patterns, { cwd: dir, absolute: true, dot: true, onlyFiles: true, deep: 0 });

/**
 * What a Vite HTML entry loads: `<script src>`, `<link href>` (stylesheets, preloads, icons) and
 * other `src` attributes. A leading `/` is the project root; files under public/ are inputs already.
 */
const htmlReferences = (html: string, dir: string): string[] => {
  const text = readText(html);
  if (text === undefined) return [];
  const out: string[] = [];
  for (const match of stripBlocks(text, '<!--', '-->').matchAll(/\b(?:src|href)\s*=\s*["']([^"'#?]+)/gi)) {
    const ref = match[1].trim();
    if (ref === '' || /^([a-z][\w+.-]*:|\/\/)/i.test(ref)) continue;
    const file = ref.startsWith('/') ? join(dir, ref.slice(1)) : resolve(dirname(html), ref);
    if (isFile(file) && !file.startsWith(join(dir, 'public') + sep)) out.push(file);
  }
  return out;
};

const manifestEntries = (dir: string, manifest: Record<string, unknown> | undefined): string[] => {
  const candidates = new Set<string>();
  const add = (value: unknown) => {
    if (typeof value === 'string') candidates.add(value);
    else if (typeof value === 'object' && value !== null) for (const v of Object.values(value)) add(v);
  };
  if (manifest) for (const field of ['source', 'main', 'module', 'browser', 'exports', 'bin']) add(manifest[field]);
  const files: string[] = [];
  for (const c of candidates) {
    const file = resolve(dir, c);
    if (existsSync(file) && !file.includes('/dist/')) files.push(file);
  }
  return [...files, ...glob(dir, both(`{index,main,server,app}.${CODE}`), dir)];
};

/** `extends: "@acme/tsconfig/nextjs.json"`: a package, resolved like TypeScript does from node_modules. */
const packageTsconfig = (from: string, specifier: string): string | undefined => {
  for (let dir = dirname(from); ; dir = dirname(dir)) {
    const base = join(dir, 'node_modules', specifier);
    for (const candidate of [base, `${base}.json`, join(base, 'tsconfig.json')]) if (isFile(candidate)) return candidate;
    if (dirname(dir) === dir) return;
  }
};

interface Tsconfig {
  /** The config and everything it extends, derived first. */
  files: string[];
  /** `extends` targets that do not exist. tsc fails on them, so deleting one matters. */
  missing: string[];
  compilerOptions: Record<string, unknown>;
  /** Directory `paths` entries are relative to: `baseUrl`, else the file that set `paths`. */
  pathsBase?: string;
  baseUrl?: string;
}

/** tsconfig.json (or jsconfig.json) with its `extends` chain, relative and package ones, merged like tsc does. */
/** The files a package `extends` could name once the package's own copy is gone: tsc fails then, so deleting one matters. */
const packageTsconfigCandidates = (from: string, specifier: string): string[] => {
  const name = specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0];
  for (let dir = dirname(from); ; dir = dirname(dir)) {
    const pkg = join(dir, 'node_modules', name);
    if (existsSync(pkg)) {
      const base = join(realpathSync(pkg), specifier.slice(name.length));
      return [base, `${base}.json`, join(base, 'tsconfig.json')];
    }
    if (dirname(dir) === dir) return [];
  }
};

/** Inside `boundary`, following symlinks, or an installed package whose real path is in node_modules too. */
const within = (boundary: string | undefined, file: string) => {
  if (boundary === undefined) return true;
  let real = file;
  try {
    real = realpathSync(file);
  } catch {}
  const inModules = (p: string) => p.split(sep).includes('node_modules');
  return real === boundary || real.startsWith(boundary + sep) || (inModules(file) && inModules(real));
};

const readTsconfig = (start: string, boundary?: string): Tsconfig => {
  const files: string[] = [];
  const missing: string[] = [];
  const layers: Array<{ file: string; options: Record<string, unknown> }> = [];
  const visit = (file: string) => {
    if (files.includes(file)) return;
    // An `extends` out of the repository is not read; tsc would read it, oxc-resolver does.
    if (!within(boundary, file)) return;
    if (!isFile(file)) {
      missing.push(file);
      return;
    }
    files.push(file);
    const json = readJson(file);
    const ext = json?.extends;
    for (const e of Array.isArray(ext) ? ext : [ext]) {
      if (typeof e !== 'string') continue;
      if (e.startsWith('.') || isAbsolute(e)) {
        const target = resolve(dirname(file), e);
        if (isFile(target) || target.endsWith('.json')) visit(target);
        else {
          missing.push(target);
          visit(`${target}.json`);
        }
      } else {
        // Real path: a workspace config package is then keyed by its place in the repository.
        const target = packageTsconfig(file, e);
        if (target) visit(realpathSync(target));
        else missing.push(...packageTsconfigCandidates(file, e));
      }
    }
    layers.push({ file, options: (json?.compilerOptions as Record<string, unknown> | undefined) ?? {} });
  };
  visit(start);
  // The start file may simply not exist (no tsconfig.json); only missing `extends` targets count.
  if (missing[0] === start) missing.shift();
  const out: Tsconfig = { files, missing, compilerOptions: {} };
  for (const { file, options } of layers) {
    Object.assign(out.compilerOptions, options);
    if (typeof options.baseUrl === 'string') out.baseUrl = resolve(dirname(file), options.baseUrl);
    if (options.paths) out.pathsBase = dirname(file);
  }
  if (out.baseUrl) out.pathsBase = out.baseUrl;
  return out;
};

/** The project's own tsconfig.json, or jsconfig.json when there is none. */
const configFileOf = (dir: string): string | undefined =>
  [join(dir, 'tsconfig.json'), join(dir, 'jsconfig.json')].find(isFile);

/** tsconfig (or jsconfig) files a directory's code compiles with, extended ones included. */
export const tsconfigFiles = (dir: string, boundary?: string): string[] => {
  const file = configFileOf(dir);
  return file ? readTsconfig(file, boundary).files : [];
};

const WORKSPACE_MARKERS = ['pnpm-workspace.yaml', 'package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb'];
const LOCKFILE_NAMES = WORKSPACE_MARKERS.slice(1);

/** Directories from `dir` up to `stop` (or the file system root). */
const ancestors = (dir: string, stop?: string): string[] => {
  const out: string[] = [];
  for (let current = dir; ; current = dirname(current)) {
    out.push(current);
    if (current === stop || dirname(current) === current) return out;
  }
};

/**
 * The nearest directory with a lockfile or workspace file, searched up to the git root. Keys are
 * relative to it with or without .git, so a manifest from a source tarball matches one from a clone.
 */
const workspaceRoot = (dir: string, git: string | undefined): string => {
  for (const current of ancestors(dir, git)) if (WORKSPACE_MARKERS.some(m => existsSync(join(current, m)))) return current;
  return git ?? dir;
};

/** Signs that a directory is an app or package: without one, `byakugan` was probably run in a subdirectory. */
const PROJECT_SIGNS = ['package.json', 'byakugan.json', 'project.json', 'index.html', `{next,vite,react-router}.config.${CONFIG_EXT}`, 'remix.config.{js,mjs,cjs}', 'wrangler.{toml,json,jsonc}'];

const configText = (dir: string, names: string[]): string =>
  topLevel(dir, names.map(n => `${n}.config.${CONFIG_EXT}`))
    .map(f => readText(f) ?? '')
    .join('\n');

/** Strings in an array option, e.g. `pageExtensions: ['page.tsx', 'page.ts']`. */
const arrayOption = (text: string, name: string): string[] => {
  const out: string[] = [];
  for (const match of text.matchAll(new RegExp(`\\b${name}\\s*:\\s*\\[([^\\]]{0,2000})\\]`, 'g'))) {
    for (const s of match[1].matchAll(/['"`]([^'"`\n]+)['"`]/g)) out.push(s[1]);
  }
  return out;
};

/**
 * oxc-resolver reads package.json and tsconfig files (with their `references`) itself, without
 * byakugan's regular-file check. A committed `package.json -> /dev/zero` would make it read
 * forever, so the run stops first when a linked .json file is not a regular file. Git lists the
 * links, submodules included; without git, the workspace is crawled for them.
 */
const checkLinkedJson = (top: string, tracked: boolean) => {
  const links = tracked
    ? trackedLinks(top).map(link => join(top, link))
    : safeGlob(['**/*.json'], { cwd: top, dot: true, ignore: ['**/node_modules/**', '**/.git/**'] }).filter(file => {
        try {
          return lstatSync(file).isSymbolicLink();
        } catch {
          return false;
        }
      });
  for (const file of links) {
    if (!file.endsWith('.json')) continue;
    let regular = true;
    try {
      const stat = statSync(file);
      regular = stat.isFile() || stat.isDirectory();
    } catch {}
    if (!regular) throw new Error(`${relative(top, file)} is not a regular file`);
  }
};

export const loadProject = (options: LoadProjectOptions = {}): Project => {
  const dir = realpathSync(resolve(options.cwd ?? process.cwd()));
  const git = gitRoot(dir);
  const repo = git ? realpathSync(git) : undefined;
  const root = workspaceRoot(dir, repo);
  checkLinkedJson(repo ?? root, repo !== undefined);
  const configFile = join(dir, 'byakugan.json');
  let fileConfig: Config | undefined;
  if (existsSync(configFile)) {
    const text = readText(configFile);
    if (text === undefined) throw new Error(`${configFile} is not a regular file`);
    let parsed: unknown;
    try {
      parsed = parseJsonc(text);
    } catch (error) {
      throw new Error(`${configFile} is not valid JSON (${(error as Error).message})`);
    }
    fileConfig = checkConfig(configFile, parsed);
  }
  const config: Config = checkConfig('config', { ...fileConfig, ...options.config });
  if (config.tailwindDir !== undefined) {
    // The Tailwind worker reads configs there, so it must stay inside the repository.
    const target = resolve(dir, config.tailwindDir);
    const real = existsSync(target) ? realpathSync(target) : undefined;
    const boundary = repo ?? root;
    if (!real || !statSync(real).isDirectory() || !(real === boundary || real.startsWith(boundary + sep))) {
      throw new Error(`"tailwindDir" names ${config.tailwindDir}, which is not a directory inside the repository`);
    }
  }
  if (!options.config && topLevel(dir, PROJECT_SIGNS).length === 0 && !fileConfig) {
    throw new Error(`${dir} has no package.json, framework config or byakugan.json. Run byakugan in the app directory, or pass -C <dir>.`);
  }
  const manifest = readJson(join(dir, 'package.json'));
  // Tools are often declared once, in the workspace root. Nx-style apps without a package.json
  // keep all their dependencies there. The closest declaration wins.
  const deps: Record<string, unknown> = {};
  for (const current of ancestors(dir, repo ?? root).reverse()) {
    const m = current === dir ? manifest : readJson(join(current, 'package.json'));
    Object.assign(deps, m?.peerDependencies, m?.devDependencies, m?.dependencies);
  }
  // The framework is the app's own, when it has a package.json: a root `vite` for vitest does not make an API a Vite app.
  const ownDeps: Record<string, unknown> = manifest
    ? { ...(manifest.peerDependencies as object), ...(manifest.devDependencies as object), ...(manifest.dependencies as object) }
    : deps;
  const has = (name: string) => topLevel(dir, [`${name}.config.${CONFIG_EXT}`]).length > 0;
  const framework: Framework =
    config.framework ??
    (ownDeps['@react-router/dev'] || ownDeps['@remix-run/dev'] || has('react-router') || has('remix')
      ? 'react-router'
      : ownDeps.next || has('next')
        ? 'next'
        : ownDeps.nuxt || has('nuxt')
          ? 'nuxt'
          : ownDeps['@sveltejs/kit'] || has('svelte')
            ? 'sveltekit'
            : ownDeps.astro || has('astro')
              ? 'astro'
              : ownDeps['react-native'] || ownDeps.expo
                ? 'react-native'
                : ownDeps.vite || has('vite')
                  ? 'vite'
                  : 'none');

  const entryPatterns = [...TOOL_CONFIGS];
  const inputPatterns = [...TOOL_INPUTS];
  const packages: string[] = [];
  const entries: string[] = [];
  const nextConfig = framework === 'next' ? configText(dir, ['next']) : '';
  const viteConfig = framework === 'vite' || framework === 'react-router' ? configText(dir, ['vite', 'react-router']) : '';

  if (framework === 'next') {
    const custom = arrayOption(nextConfig, 'pageExtensions').map(e => e.replace(/^\./, ''));
    const routeExt = `{${[...new Set([...ROUTE_EXTENSIONS, ...custom])].join(',')}}`;
    entryPatterns.push(
      ...both(`app/**/{${NEXT_APP_FILES}}.${routeExt}`),
      ...both(`pages/**/*.${routeExt}`),
      ...both(`{middleware,proxy,instrumentation,instrumentation-client}.${CODE}`),
      ...both(`mdx-components.${CODE}`),
      `next.config.${CONFIG_EXT}`
    );
    inputPatterns.push('public/**', ...both(`app/**/${NEXT_STATIC_METADATA}`));
    packages.push(...NEXT_PACKAGES);
  } else if (framework === 'vite') {
    entries.push(...htmlReferences(join(dir, 'index.html'), dir));
    entryPatterns.push(`vite.config.${CONFIG_EXT}`);
    inputPatterns.push('index.html', 'public/**');
    packages.push(...VITE_PACKAGES, ...Object.keys(deps).filter(d => d.startsWith('@vitejs/')));
  } else if (framework === 'react-router') {
    // React Router v7 framework mode and Remix: the plugin loads root, entries and routes by convention.
    const app = /\bappDirectory\s*:\s*['"`]([^'"`]+)['"`]/.exec(viteConfig)?.[1]?.replace(/^\.\//, '').replace(/\/$/, '') ?? 'app';
    entryPatterns.push(
      `${app}/root.${CODE}`,
      `${app}/entry.{client,server}.${CODE}`,
      `${app}/routes.${CODE}`,
      `${app}/routes/**/*.{js,jsx,ts,tsx,md,mdx}`,
      `{vite,react-router}.config.${CONFIG_EXT}`,
      'remix.config.{js,mjs,cjs}'
    );
    inputPatterns.push('public/**');
    packages.push(...VITE_PACKAGES, ...Object.keys(deps).filter(d => /^(@vitejs\/|@react-router\/|@remix-run\/|react-router$)/.test(d)));
  } else if (framework === 'nuxt') {
    // Nuxt 4 keeps the app in `app/`. Components, composables and utils are auto-imported, so all of them count.
    const src = existsSync(join(dir, 'app')) && (existsSync(join(dir, 'app', 'app.vue')) || existsSync(join(dir, 'app', 'pages'))) ? 'app/' : '';
    entryPatterns.push(
      `${src}{app,error}.vue`,
      `${src}app.config.${CODE}`,
      `${src}{pages,layouts,components,composables,utils,plugins,middleware}/**/*.${COMPONENT_CODE}`,
      `{server,shared,modules}/**/*.${CODE}`,
      `nuxt.config.${CONFIG_EXT}`
    );
    inputPatterns.push('public/**');
    // @nuxt/content builds pages from the files in content/.
    if ('@nuxt/content' in deps) inputPatterns.push('content/**');
    packages.push(...NUXT_PACKAGES, ...Object.keys(deps).filter(d => d.startsWith('@nuxt/') || d.startsWith('@nuxtjs/')));
  } else if (framework === 'sveltekit') {
    entryPatterns.push(
      `src/routes/**/*.${COMPONENT_CODE}`,
      `src/hooks.${CODE}`,
      `src/hooks.{server,client,universal}.${CODE}`,
      `src/params/**/*.${CODE}`,
      `src/service-worker.${CODE}`,
      `src/service-worker/index.${CODE}`,
      'svelte.config.{js,mjs,ts}',
      `vite.config.${CONFIG_EXT}`
    );
    inputPatterns.push('src/app.html', 'src/error.html', 'static/**');
    packages.push(...SVELTEKIT_PACKAGES, ...Object.keys(deps).filter(d => d.startsWith('@sveltejs/adapter-')));
  } else if (framework === 'astro') {
    entryPatterns.push(
      `src/pages/**/*.{astro,md,mdx,html,js,ts}`,
      `src/middleware.${CODE}`,
      `src/middleware/index.${CODE}`,
      `src/content.config.${CODE}`,
      `src/content/config.${CODE}`,
      `astro.config.${CONFIG_EXT}`
    );
    inputPatterns.push('public/**', 'src/content/**');
    packages.push(...ASTRO_PACKAGES, ...Object.keys(deps).filter(d => d.startsWith('@astrojs/')));
  } else if (framework === 'react-native') {
    // Expo Router loads every file under app/ by convention; without it, index.js or App.tsx is the entry.
    if ('expo-router' in deps) entryPatterns.push(...both(`app/**/*.${CODE}`));
    entries.push(...manifestEntries(dir, manifest));
    entryPatterns.push(`{index,App}.${CODE}`, `app.config.${CONFIG_EXT}`, `metro.config.${CONFIG_EXT}`);
    inputPatterns.push('app.json', 'eas.json');
    packages.push(...REACT_NATIVE_PACKAGES);
  } else if (!config.entry?.length) {
    entries.push(...manifestEntries(dir, manifest));
    entryPatterns.push(...both(`{index,main,server,app}.${CODE}`));
  }

  entryPatterns.push(...PLATFORM_ENTRIES, ...Object.entries(PLUGIN_ENTRIES).flatMap(([pkg, patterns]) => (pkg in deps ? patterns : [])));
  const workers = wrangler(dir);
  for (const file of glob(dir, [...entryPatterns, ...(config.entry ?? [])], repo ?? root)) entries.push(file);
  entries.push(...workers.entries);
  const namedFiles = [...workers.named];
  const tsconfig = readTsconfig(configFileOf(dir) ?? join(dir, 'tsconfig.json'), repo ?? root);
  namedFiles.push(...tsconfig.missing);
  entries.push(...filesNamedIn(entries, dir, namedFiles));
  // Multi-page Vite builds name more HTML files; each one loads its own scripts and styles.
  for (const html of entries.filter(e => e.endsWith('.html'))) entries.push(...htmlReferences(html, dir));
  inputPatterns.push(...workers.inputs, ...(config.inputs ?? []));
  // Build settings Next.js, PostCSS and Babel find by walking up from the app, within the repository.
  const top = repo ?? root;
  const parentTools = dir === top || !dir.startsWith(top + sep) ? [] : ancestors(dirname(dir), top).flatMap(d => topLevel(d, [...TOOL_FILES, ...TOOL_CONFIGS]));
  const inputs = [...glob(dir, inputPatterns, top, INPUT_IGNORE), ...tsconfig.files, ...parentTools];
  const implicit = BROWSER_DATA_USERS.some(p => p in deps) ? BROWSER_DATA : [];
  packages.push(...TOOL_PACKAGES, ...packagesNamedIn([...entries, ...inputs], Object.keys(deps)));
  // Tailwind reads the code without an import from it, in any framework.
  packages.push('tailwindcss');

  const compilerOptions = tsconfig.compilerOptions;
  const jsxImportSource =
    config.jsxImportSource ?? (typeof compilerOptions.jsxImportSource === 'string' ? compilerOptions.jsxImportSource : 'react');
  const paths = (compilerOptions.paths ?? {}) as Record<string, unknown>;
  const pathTargets = (specifier: string): string[] => {
    const out: string[] = [];
    if (tsconfig.pathsBase) {
      for (const [pattern, targets] of Object.entries(paths)) {
        if (!Array.isArray(targets)) continue;
        const star = pattern.indexOf('*');
        let rest: string | undefined;
        if (star === -1) rest = pattern === specifier ? '' : undefined;
        else if (specifier.startsWith(pattern.slice(0, star)) && specifier.endsWith(pattern.slice(star + 1)))
          rest = specifier.slice(star, specifier.length - (pattern.length - star - 1));
        if (rest === undefined) continue;
        for (const t of targets) if (typeof t === 'string') out.push(resolve(tsconfig.pathsBase, t.replace('*', rest)));
      }
    }
    return out;
  };
  const aliasTargets = (specifier: string): string[] => [...pathTargets(specifier), ...(tsconfig.baseUrl ? [resolve(tsconfig.baseUrl, specifier)] : [])];
  const styleLoadPaths = [...arrayOption(nextConfig + viteConfig, 'includePaths'), ...arrayOption(nextConfig + viteConfig, 'loadPaths')]
    .map(p => resolve(dir, p))
    .filter(p => existsSync(p));
  const lockfile = ancestors(dir, root)
    .flatMap(d => LOCKFILE_NAMES.map(n => join(d, n)))
    .find(f => existsSync(f));
  const ownConfig = configFileOf(dir);

  return {
    dir,
    root,
    repo: repo ?? root,
    framework,
    config: {
      ...config,
      generated: [...(config.generated ?? []), ...(FRAMEWORK_GENERATED[framework] ?? [])],
      virtual: [...(config.virtual ?? []), ...(FRAMEWORK_VIRTUAL[framework] ?? [])],
    },
    entries: [...new Set(entries)].sort(),
    inputs: [...new Set(inputs)].sort(),
    inputPatterns,
    entryPatterns: [...entryPatterns, ...(config.entry ?? [])],
    namedFiles: [...new Set(namedFiles)].sort(),
    packages: [
      ...new Set([...packages.filter(p => p in deps), ...implicit.filter(p => installed(dir, p)), ...(config.packages ?? [])]),
    ].sort(),
    jsxImportSource,
    manifest,
    lockfile,
    tsconfig: ownConfig?.endsWith('jsconfig.json') ? ownConfig : undefined,
    parseOptions: {
      verbatimModuleSyntax: compilerOptions.verbatimModuleSyntax === true || compilerOptions.preserveValueImports === true,
      jsxClassic: compilerOptions.jsx === 'react',
      checkJs: compilerOptions.checkJs === true,
      jsxFactory: typeof compilerOptions.jsxFactory === 'string' ? compilerOptions.jsxFactory : undefined,
      jsxFragmentFactory: typeof compilerOptions.jsxFragmentFactory === 'string' ? compilerOptions.jsxFragmentFactory : undefined,
    },
    baseUrls: tsconfig.baseUrl ? [tsconfig.baseUrl] : [],
    styleLoadPaths,
    styleGlobals: sassGlobals(nextConfig + viteConfig),
    workers: workers.found,
    aliases: frameworkAliases(framework, dir),
    aliasTargets,
    pathTargets,
  };
};

/** `additionalData: '@use "@/styles/vars" as *;'` in Sass options: what every stylesheet loads first. */
const sassGlobals = (text: string): string[] => {
  const out: string[] = [];
  for (const m of text.matchAll(/\b(?:additionalData|prependData)\s*:\s*(?:'([^'\n]{0,2000})'|"([^"\n]{0,2000})"|`([^`]{0,2000})`)/g)) {
    const data = m[1] ?? m[2] ?? m[3] ?? '';
    for (const rule of data.matchAll(/@(?:use|import|forward)\s+(['"])([^'"\n]+)\1/g)) out.push(rule[2]);
  }
  return [...new Set(out)];
};

const LIST_FIELDS = ['entry', 'inputs', 'packages', 'conditions', 'generated', 'virtual', 'env'] as const;
const FRAMEWORKS = ['next', 'vite', 'react-router', 'nuxt', 'sveltekit', 'astro', 'react-native', 'none'];

/** byakugan.json in the shape the tool expects. A string where a list belongs would spread into one glob per character. */
const checkConfig = (file: string, value: unknown): Config => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${file} must hold a JSON object`);
  const config = value as Record<string, unknown>;
  for (const field of LIST_FIELDS) {
    const list = config[field];
    if (list === undefined) continue;
    if (!Array.isArray(list) || !list.every(v => typeof v === 'string' && v !== '')) throw new Error(`${file}: "${field}" must be a list of strings`);
    if (field === 'entry' || field === 'inputs' || field === 'generated') {
      const absolute = list.find(p => isAbsolute(p.replace(/^!/, '')));
      if (absolute) throw new Error(`${file}: "${field}" holds "${absolute}"; patterns are relative to the project directory`);
    }
  }
  if (config.framework !== undefined && !FRAMEWORKS.includes(config.framework as string)) {
    throw new Error(`${file}: "framework" must be one of ${FRAMEWORKS.join(', ')}`);
  }
  if (config.mode !== undefined && !MODES.includes(config.mode as string)) throw new Error(`${file}: "mode" must be one of ${MODES.join(', ')}`);
  if (config.jsxImportSource !== undefined && typeof config.jsxImportSource !== 'string') throw new Error(`${file}: "jsxImportSource" must be a string`);
  for (const field of ['tailwind', 'postcssFromStylesheet']) {
    if (config[field] !== undefined && typeof config[field] !== 'boolean') throw new Error(`${file}: "${field}" must be true or false`);
  }
  const tailwindDir = config.tailwindDir;
  if (tailwindDir !== undefined && (typeof tailwindDir !== 'string' || tailwindDir === '' || isAbsolute(tailwindDir))) {
    throw new Error(`${file}: "tailwindDir" must be a directory relative to the project`);
  }
  const rules = config.modularizeImports;
  if (rules !== undefined && (typeof rules !== 'object' || rules === null || Array.isArray(rules))) {
    throw new Error(`${file}: "modularizeImports" must be an object`);
  }
  return config as Config;
};

const installed = (dir: string, name: string) => ancestors(dir).some(d => existsSync(join(d, 'node_modules', name, 'package.json')));

/** Entry files that only configure the build. A project with nothing else has no app code to follow. */
export const isConfigEntry = (file: string) => /(^|[\\/])[\w-]+\.config\.[cm]?[jt]s$/.test(file);
