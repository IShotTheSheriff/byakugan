import { existsSync, statSync } from 'node:fs';
import { isBuiltin } from 'node:module';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { ResolverFactory, type NapiResolveOptions } from 'oxc-resolver';
import { readText } from './fs.ts';
import { globMatcher } from './glob.ts';

export interface PackageInfo {
  name: string;
  version: string;
  dir: string;
  sideEffects: unknown;
}

export interface ModularizeRule {
  transform: string;
}

export interface ResolverOptions {
  /** Extra export conditions tried before the defaults, e.g. `source` for workspace packages. */
  conditions?: string[];
  /** Also resolve with the `react-server` condition (Next.js App Router). */
  reactServer?: boolean;
  /**
   * Edge runtimes to resolve for, each with its own condition set: `edge-light` (Next.js
   * middleware and edge routes) and `workerd` (Cloudflare Workers).
   */
  edge?: Array<'edge-light' | 'workerd'>;
  /** tsconfig.json or jsconfig.json to read `paths` from. Default: the nearest tsconfig.json of each file. */
  tsconfig?: string;
  modularizeImports?: Record<string, ModularizeRule>;
  /** Import aliases (`$lib` -> a directory), tried before tsconfig `paths`. */
  alias?: Record<string, string[]>;
  /**
   * React Native: Metro picks `Button.ios.tsx` over `Button.tsx` per platform, so every platform
   * variant of a resolved file counts, and packages resolve with the `react-native` condition.
   */
  platforms?: string[];
}

/** Next.js ships this rule by default; it maps `import { partition } from 'lodash'` to `lodash/partition`. */
export const DEFAULT_MODULARIZE: Record<string, ModularizeRule> = {
  lodash: { transform: 'lodash/{{member}}' },
};

const EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.d.ts', '.json'];
const CODE_EXTENSIONS = EXTENSIONS.filter(e => e !== '.d.ts' && e !== '.json');

const EXTENSION_ALIAS = {
  '.js': ['.js', '.ts', '.tsx', '.d.ts'],
  '.jsx': ['.jsx', '.tsx'],
  '.mjs': ['.mjs', '.mts', '.d.mts'],
  '.cjs': ['.cjs', '.cts', '.d.cts'],
};

export const isInNodeModules = (file: string) => file.includes(`${sep}node_modules${sep}`);

/** Modules the runtime or bundler provides: `bun:sqlite`, `cloudflare:workers`, `virtual:pwa-register`. */
const PROVIDED = /^(bun|cloudflare|workerd|virtual|astro):|^bun$|^__STATIC_CONTENT_MANIFEST$/;

const STYLE_SUFFIXES = ['.scss', '.sass', '.css', '.less'];

/** The file a stylesheet reference points at: exact, with an extension, a Sass partial, or an index. */
export const findStyleFile = (base: string): string | undefined =>
  styleCandidates(base).find(c => {
    if (extname(c) === '') return false;
    try {
      return statSync(c).isFile();
    } catch {
      return false;
    }
  });

/** Every path `findStyleFile` tries for `base`, in order. */
export const styleCandidates = (base: string): string[] => {
  const name = basename(base);
  return [
    base,
    ...STYLE_SUFFIXES.flatMap(e => [`${base}${e}`, join(dirname(base), `_${name}${e}`), join(base, `_index${e}`), join(base, `index${e}`)]),
  ].filter(c => extname(c) !== '');
};

export const packageNameOf = (specifier: string) => {
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
};

const CASES: Record<string, (s: string) => string> = {
  kebabCase: s => s.replace(/([a-z0-9])([A-Z])/g, '$1-$2').replace(/[\s_]+/g, '-').toLowerCase(),
  camelCase: s => s.replace(/[-_\s]+(.)?/g, (_, c: string | undefined) => (c ? c.toUpperCase() : '')).replace(/^./, c => c.toLowerCase()),
  lowerCase: s => s.toLowerCase(),
  upperCase: s => s.toUpperCase(),
};

const applyTransform = (transform: string, member: string) =>
  transform.replace(/\{\{\s*(?:(\w+)\s+)?member\s*\}\}/g, (_, helper: string | undefined) =>
    helper && CASES[helper] ? CASES[helper](member) : member
  );

export class Resolver {
  private platforms: string[];
  private projectResolvers: ResolverFactory[];
  private packageResolvers: ResolverFactory[];
  private styleResolvers: [ResolverFactory, ResolverFactory];
  private cache = new Map<string, string[]>();
  private packages = new Map<string, PackageInfo | null>();
  private sideEffectMatchers = new Map<string, (path: string) => boolean>();
  readonly modularize: Record<string, ModularizeRule>;

  constructor(options: ResolverOptions = {}) {
    const extra = options.conditions ?? [];
    const base: NapiResolveOptions = {
      extensions: EXTENSIONS,
      extensionAlias: EXTENSION_ALIAS,
      mainFields: ['module', 'main'],
      symlinks: true,
      ...(options.alias && Object.keys(options.alias).length > 0 ? { alias: options.alias } : {}),
    };
    // A package's `exports` picks the first key, in its own order, that the set contains. So
    // `import` and `require` sit in separate sets: with both in one, `{ "require": ..., "import": ... }`
    // resolves an ES import to the CommonJS build.
    this.platforms = options.platforms ?? [];
    if (this.platforms.length > 0) base.extensions = [...this.platforms.flatMap(p => CODE_EXTENSIONS.map(e => `.${p}${e}`)), ...EXTENSIONS];
    const sets: Array<{ conditions: string[]; browser?: boolean }> = [
      { conditions: [...extra, 'browser', 'import', 'module', 'default'], browser: true },
      { conditions: [...extra, 'node', 'import', 'module', 'default'] },
      { conditions: [...extra, 'node', 'require', 'default'] },
    ];
    if (this.platforms.length > 0) sets.unshift({ conditions: [...extra, 'react-native', 'browser', 'import', 'module', 'default'] });
    if (options.reactServer) sets.push({ conditions: [...extra, 'react-server', 'node', 'import', 'module', 'default'] });
    // One set per runtime: a package listing `edge-light` before `workerd` would otherwise hide the Workers build.
    for (const runtime of options.edge ?? []) sets.push({ conditions: [...extra, runtime, 'worker', 'browser', 'import', 'module', 'default'], browser: true });
    const optionsFor = (set: (typeof sets)[number]): NapiResolveOptions => ({
      ...base,
      conditionNames: set.conditions,
      ...(set.browser ? { mainFields: ['browser', 'module', 'main'], aliasFields: [['browser']] } : {}),
    });
    const tsconfig: NapiResolveOptions['tsconfig'] = options.tsconfig ? { configFile: options.tsconfig, references: 'auto' } : 'auto';
    const first = new ResolverFactory({ ...optionsFor(sets[0]), tsconfig });
    this.projectResolvers = [first, ...sets.slice(1).map(s => first.cloneWithOptions({ ...optionsFor(s), tsconfig }))];
    this.packageResolvers = sets.map(s => first.cloneWithOptions(optionsFor(s)));
    const style: NapiResolveOptions = {
      extensions: ['.css', '.scss', '.sass', '.less'],
      mainFields: ['style', 'sass', 'main'],
      mainFiles: ['index', '_index'],
      conditionNames: [...extra, 'style', 'sass', 'import', 'require', 'default'],
      symlinks: true,
    };
    this.styleResolvers = [first.cloneWithOptions({ ...style, tsconfig }), first.cloneWithOptions(style)];
    this.modularize = { ...DEFAULT_MODULARIZE, ...options.modularizeImports };
  }

  private checked = new Set<string>();
  private installed = new Map<string, boolean>();

  /** Throws when `dir` holds a package.json that is not a regular file. */
  private checkManifest(dir: string) {
    if (this.checked.has(dir)) return;
    this.checked.add(dir);
    const file = join(dir, 'package.json');
    let regular = true;
    try {
      regular = statSync(file).isFile();
    } catch {}
    if (!regular) throw new Error(`${file} is not a regular file`);
  }

  /** `checkManifest` for `dir` and every directory above it. */
  private checkManifests(dir: string) {
    for (let current = dir; !this.checked.has(current); current = dirname(current)) {
      this.checkManifest(current);
      if (dirname(current) === current) return;
    }
  }

  /**
   * oxc-resolver reads every package.json on the way, and a FIFO there would block it forever.
   * The directories it is about to look in are checked first. Committed links are checked in
   * loadProject, which also covers paths an alias leads to.
   */
  private checkLookup(specifier: string, fromFile: string) {
    this.checkManifests(dirname(fromFile));
    if (specifier.startsWith('.') || isAbsolute(specifier)) {
      this.checkManifests(resolve(dirname(fromFile), specifier));
      return;
    }
    const name = packageNameOf(specifier);
    for (let dir = dirname(fromFile); ; dir = dirname(dir)) {
      const pkg = join(dir, 'node_modules', name);
      let found = this.installed.get(pkg);
      if (found === undefined) {
        found = existsSync(pkg);
        this.installed.set(pkg, found);
      }
      // The directories above the package are the importer's own, checked already.
      if (found) for (let current = join(dir, 'node_modules', specifier); ; current = dirname(current)) {
        this.checkManifest(current);
        if (current === pkg || dirname(current) === current) break;
      }
      if (dirname(dir) === dir) return;
    }
  }

  /** Every specifier a lookup named. `usedSubpaths` reads the `exports` keys in use from it. */
  readonly asked = new Set<string>();

  /** All files `specifier` can point at from `fromFile`, across export conditions. Empty when unresolved. */
  resolve(specifier: string, fromFile: string): string[] {
    if (this.isBuiltin(specifier)) return [];
    // Vite `./app.css?url`: the query picks a loader, the file is the same.
    const query = specifier.indexOf('?');
    if (query > 0) specifier = specifier.slice(0, query);
    this.asked.add(specifier);
    const relativeSpecifier = specifier.startsWith('.') || specifier.startsWith('/');
    const external = isInNodeModules(fromFile);
    const cacheKey = `${dirname(fromFile)}\0${specifier}`;
    const cached = this.cache.get(cacheKey);
    if (cached) return cached;
    this.checkLookup(specifier, fromFile);
    const resolvers = external ? this.packageResolvers : this.projectResolvers;
    const found = new Set<string>();
    // A relative path can still differ per set: the `browser` field remaps files, in packages and
    // in workspace packages alike. The server build keeps the original file.
    for (const resolver of relativeSpecifier ? resolvers.slice(0, 2) : resolvers) {
      const result = external ? resolver.sync(dirname(fromFile), specifier) : resolver.resolveFileSync(fromFile, specifier);
      if (result.path) found.add(result.path);
    }
    if (this.platforms.length > 0) for (const file of [...found]) for (const variant of this.platformVariants(file)) found.add(variant);
    const files = [...found];
    this.cache.set(cacheKey, files);
    return files;
  }

  /**
   * Stems of resolved files that platform variants compete for, such as `src/Button` and
   * `src/Button.ios`. Deleting `Button.ios.tsx` hands the iOS import to `Button.tsx`, which
   * the graph already holds, so git mode matches deleted files against these.
   */
  readonly variantStems = new Set<string>();

  /** `Button.ios.tsx` -> `Button.tsx`, `Button.android.js` and the rest that exist, in any code extension. */
  private platformVariants(file: string): string[] {
    const ext = /\.[cm]?[jt]sx?$/.exec(file)?.[0];
    if (!ext || file.endsWith('.d.ts')) return [];
    const stem = file.slice(0, -ext.length).replace(new RegExp(`\\.(?:${this.platforms.join('|')})$`), '');
    const stems = [stem, ...this.platforms.map(p => `${stem}.${p}`)];
    if (!isInNodeModules(file)) for (const s of stems) this.variantStems.add(s);
    const candidates = stems.flatMap(s => CODE_EXTENSIONS.map(e => `${s}${e}`));
    return candidates.filter(c => {
      if (c === file) return false;
      try {
        return statSync(c).isFile();
      } catch {
        return false;
      }
    });
  }

  /**
   * A package stylesheet, resolved with the `style` and `sass` export conditions. When only
   * the package can be found, `package` names it so its version can stand in for the file.
   */
  resolveStyle(specifier: string, fromFile: string): { file?: string; package?: string } {
    this.asked.add(specifier);
    this.checkLookup(specifier, fromFile);
    const external = isInNodeModules(fromFile);
    const resolver = this.styleResolvers[external ? 1 : 0];
    const result = external ? resolver.sync(dirname(fromFile), specifier) : resolver.resolveFileSync(fromFile, specifier);
    if (result.path) return { file: result.path };
    const name = packageNameOf(specifier);
    for (let dir = dirname(fromFile); ; dir = dirname(dir)) {
      const pkg = join(dir, 'node_modules', name);
      if (readPackage(pkg)) {
        const file = specifier === name ? undefined : findStyleFile(join(pkg, specifier.slice(name.length + 1)));
        return file ? { file } : { package: name };
      }
      if (dirname(dir) === dir) return {};
    }
  }

  isBuiltin(specifier: string) {
    return isBuiltin(specifier) || PROVIDED.test(specifier);
  }

  /** The specifier a named import maps to under a modularize rule, e.g. `lodash/partition`. */
  modularized(specifier: string, member: string): string | undefined {
    const rule = this.modularize[specifier];
    if (!rule || member === 'default' || member === '*') return;
    return applyTransform(rule.transform, member);
  }

  /** Nearest enclosing package.json that has a name. */
  packageOf(file: string): PackageInfo | undefined {
    const visited: string[] = [];
    let dir = dirname(file);
    let found: PackageInfo | null | undefined;
    while (true) {
      found = this.packages.get(dir);
      if (found !== undefined) break;
      visited.push(dir);
      found = readPackage(dir);
      if (found) break;
      const parent = dirname(dir);
      if (parent === dir) {
        found = null;
        break;
      }
      dir = parent;
    }
    for (const v of visited) this.packages.set(v, found);
    return found ?? undefined;
  }

  /** `sideEffects: false` (or a list that does not match this file) in the owning package.json. */
  isSideEffectFree(file: string): boolean {
    const pkg = this.packageOf(file);
    if (!pkg) return false;
    if (pkg.sideEffects === false) return true;
    if (!Array.isArray(pkg.sideEffects)) return false;
    let matcher = this.sideEffectMatchers.get(pkg.dir);
    if (!matcher) {
      const patterns = pkg.sideEffects
        .filter((p): p is string => typeof p === 'string')
        .map(p => (p.startsWith('./') ? p.slice(2) : p.includes('/') ? p : `**/${p}`));
      matcher = globMatcher(patterns, { dot: true });
      this.sideEffectMatchers.set(pkg.dir, matcher);
    }
    return !matcher(relative(pkg.dir, file).split(sep).join('/'));
  }

  clear() {
    this.cache.clear();
    this.packages.clear();
    for (const r of [...this.projectResolvers, ...this.styleResolvers]) r.clearCache();
  }
}

const readPackage = (dir: string): PackageInfo | undefined => {
  const text = readText(join(dir, 'package.json'));
  if (text === undefined) return;
  try {
    const json = JSON.parse(text) as Record<string, unknown>;
    if (typeof json.name !== 'string') return;
    return {
      name: json.name,
      version: typeof json.version === 'string' ? json.version : '0.0.0',
      dir,
      sideEffects: json.sideEffects,
    };
  } catch {
    return;
  }
};
