import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { globSync } from 'tinyglobby';
import { gitRoot } from './git.ts';
import { parseJsonc } from './jsonc.ts';
import type { ModularizeRule } from './resolve.ts';

export type Framework = 'next' | 'vite' | 'none';

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
}

export interface Project {
  dir: string;
  /** Git root (or `dir` outside git). Fragment keys are relative to it. */
  root: string;
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
const ROUTE_EXT = '{js,jsx,ts,tsx,mjs,md,mdx}';

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

const TOOL_INPUTS = [
  'package.json',
  'tsconfig*.json',
  '.env*',
  '.babelrc',
  '.babelrc.json',
  '.swcrc',
  '.browserslistrc',
  '.postcssrc*',
  '**/*.d.ts',
  'wrangler.{toml,json,jsonc}',
  'vercel.json',
  'netlify.toml',
];

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
const wrangler = (dir: string): { entries: string[]; inputs: string[]; named: string[] } => {
  const out = { entries: [] as string[], inputs: [] as string[], named: [] as string[] };
  for (const name of ['wrangler.jsonc', 'wrangler.json', 'wrangler.toml']) {
    const file = join(dir, name);
    if (!existsSync(file)) continue;
    const text = readFileSync(file, 'utf8');
    const values: string[][] = [[], []];
    if (name.endsWith('.toml')) {
      for (const m of text.matchAll(/^\s*main\s*=\s*["']([^"']+)["']/gm)) values[0].push(m[1]);
      for (const m of text.matchAll(/^\s*(?:directory|bucket)\s*=\s*["']([^"']+)["']/gm)) values[1].push(m[1]);
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

/**
 * Files a config file names in a string, such as Vite inputs (`/app/client.ts`) or
 * `entry: 'src/index.tsx'` for a Hono Vite build. A leading `/` is the project root.
 */
const filesNamedIn = (files: string[], dir: string, named: string[]): string[] => {
  const out: string[] = [];
  for (const file of files) {
    if (!CONFIG_FILE.test(file)) continue;
    let text: string;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
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

/** Config files whose string literals can name packages: `plugins: ["@tailwindcss/postcss"]`. */
const CONFIG_FILE = /(^|[\\/])(next|postcss|tailwind|babel|vite)\.config\.[cm]?[jt]s$|(^|[\\/])\.(babelrc|postcssrc)(\.json)?$/;

/** Dependencies a config file names in a string, e.g. a PostCSS plugin or a Turbopack loader. */
const packagesNamedIn = (files: string[], deps: string[]): string[] => {
  const out = new Set<string>();
  for (const file of files) {
    if (!CONFIG_FILE.test(file)) continue;
    let text: string;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const dep of deps) {
      const escaped = dep.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
      if (new RegExp(`['"\`]${escaped}(/[^'"\`]*)?['"\`]`).test(text)) out.add(dep);
    }
  }
  return [...out];
};

const readJson = (file: string): Record<string, unknown> | undefined => {
  try {
    const value = parseJsonc(readFileSync(file, 'utf8'));
    return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined;
  } catch {
    return;
  }
};

const glob = (dir: string, patterns: string[]) =>
  patterns.length === 0 ? [] : globSync(patterns, { cwd: dir, absolute: true, dot: true, ignore: IGNORE, onlyFiles: true });

const viteHtmlEntries = (dir: string): string[] => {
  const html = join(dir, 'index.html');
  if (!existsSync(html)) return [];
  const out: string[] = [];
  for (const match of readFileSync(html, 'utf8').matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["']/g)) {
    const src = match[1];
    if (/^[a-z]+:\/\//i.test(src)) continue;
    const file = join(dir, src.replace(/^\//, ''));
    if (existsSync(file)) out.push(file);
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
  return [...files, ...glob(dir, both(`{index,main,server,app}.${CODE}`))];
};

/** tsconfig files reached through relative `extends`, so a change to a shared base config counts. */
const tsconfigChain = (dir: string): string[] => {
  const out: string[] = [];
  const queue = [join(dir, 'tsconfig.json')];
  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (out.includes(file) || !existsSync(file)) continue;
    out.push(file);
    const json = readJson(file);
    const ext = json?.extends;
    for (const e of Array.isArray(ext) ? ext : [ext]) {
      if (typeof e === 'string' && (e.startsWith('.') || isAbsolute(e))) {
        queue.push(resolve(dirname(file), e.endsWith('.json') ? e : `${e}.json`));
      }
    }
  }
  return out;
};

const WORKSPACE_MARKERS = ['pnpm-workspace.yaml', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb'];

/** Outside git, the nearest directory with a lockfile stands in for the repository root. */
const workspaceRoot = (dir: string): string => {
  let current = dir;
  while (true) {
    if (WORKSPACE_MARKERS.some(m => existsSync(join(current, m)))) return current;
    const parent = dirname(current);
    if (parent === current) return dir;
    current = parent;
  }
};

const detectFramework = (deps: Record<string, unknown>): Framework => (deps.next ? 'next' : deps.vite ? 'vite' : 'none');

export const loadProject = (options: LoadProjectOptions = {}): Project => {
  const dir = realpathSync(resolve(options.cwd ?? process.cwd()));
  const git = gitRoot(dir);
  const root = git ? realpathSync(git) : workspaceRoot(dir);
  const fileConfig = readJson(join(dir, 'byakugan.json')) as Config | undefined;
  const config: Config = { ...fileConfig, ...options.config };
  const manifest = readJson(join(dir, 'package.json'));
  const deps: Record<string, unknown> = {
    ...(manifest?.peerDependencies as object),
    ...(manifest?.devDependencies as object),
    ...(manifest?.dependencies as object),
  };
  const framework = config.framework ?? detectFramework(deps);

  const entryPatterns = [...TOOL_CONFIGS];
  const inputPatterns = [...TOOL_INPUTS];
  const packages: string[] = [];
  const entries: string[] = [];

  if (framework === 'next') {
    entryPatterns.push(
      ...both(`app/**/{${NEXT_APP_FILES}}.${ROUTE_EXT}`),
      ...both(`pages/**/*.${ROUTE_EXT}`),
      ...both(`{middleware,proxy,instrumentation,instrumentation-client}.${CODE}`),
      ...both(`mdx-components.${CODE}`),
      `next.config.${CONFIG_EXT}`
    );
    inputPatterns.push('public/**', ...both(`app/**/${NEXT_STATIC_METADATA}`));
    packages.push(...NEXT_PACKAGES);
  } else if (framework === 'vite') {
    entries.push(...viteHtmlEntries(dir));
    entryPatterns.push(`vite.config.${CONFIG_EXT}`);
    inputPatterns.push('index.html', 'public/**');
    packages.push(...VITE_PACKAGES, ...Object.keys(deps).filter(d => d.startsWith('@vitejs/')));
  } else if (!config.entry?.length) {
    entries.push(...manifestEntries(dir, manifest));
    entryPatterns.push(...both(`{index,main,server,app}.${CODE}`));
  }

  entryPatterns.push(...PLATFORM_ENTRIES, ...Object.entries(PLUGIN_ENTRIES).flatMap(([pkg, patterns]) => (pkg in deps ? patterns : [])));
  const workers = wrangler(dir);
  entries.push(...glob(dir, [...entryPatterns, ...(config.entry ?? [])]), ...workers.entries);
  const namedFiles = [...workers.named];
  entries.push(...filesNamedIn(entries, dir, namedFiles));
  inputPatterns.push(...workers.inputs, ...(config.inputs ?? []));
  const inputs = [...glob(dir, inputPatterns), ...tsconfigChain(dir)];
  packages.push(...TOOL_PACKAGES, ...packagesNamedIn([...entries, ...inputs], Object.keys(deps)));

  const tsconfig = readJson(join(dir, 'tsconfig.json'));
  const compilerOptions = tsconfig?.compilerOptions as Record<string, unknown> | undefined;
  const jsxImportSource =
    config.jsxImportSource ?? (typeof compilerOptions?.jsxImportSource === 'string' ? compilerOptions.jsxImportSource : 'react');

  return {
    dir,
    root,
    framework,
    config,
    entries: [...new Set(entries)].sort(),
    inputs: [...new Set(inputs)].sort(),
    inputPatterns,
    entryPatterns: [...entryPatterns, ...(config.entry ?? [])],
    namedFiles: [...new Set(namedFiles)].sort(),
    packages: [...new Set([...packages.filter(p => p in deps), ...(config.packages ?? [])])].sort(),
    jsxImportSource,
    manifest,
  };
};
