import { readFileSync, statSync } from 'node:fs';
import { isBuiltin } from 'node:module';
import { basename, dirname, extname, join, relative, sep } from 'node:path';
import { ResolverFactory, type NapiResolveOptions } from 'oxc-resolver';
import picomatch from 'picomatch';

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
  modularizeImports?: Record<string, ModularizeRule>;
}

/** Next.js ships this rule by default; it maps `import { partition } from 'lodash'` to `lodash/partition`. */
export const DEFAULT_MODULARIZE: Record<string, ModularizeRule> = {
  lodash: { transform: 'lodash/{{member}}' },
};

const EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.d.ts', '.json'];

const EXTENSION_ALIAS = {
  '.js': ['.js', '.ts', '.tsx', '.d.ts'],
  '.jsx': ['.jsx', '.tsx'],
  '.mjs': ['.mjs', '.mts', '.d.mts'],
  '.cjs': ['.cjs', '.cts', '.d.cts'],
};

export const isInNodeModules = (file: string) => file.includes(`${sep}node_modules${sep}`);

/** Modules the runtime or bundler provides: `bun:sqlite`, `cloudflare:workers`, `virtual:pwa-register`. */
const PROVIDED = /^(bun|cloudflare|workerd|virtual):|^__STATIC_CONTENT_MANIFEST$/;

const STYLE_SUFFIXES = ['.scss', '.sass', '.css', '.less'];

/** The file a stylesheet reference points at: exact, with an extension, a Sass partial, or an index. */
export const findStyleFile = (base: string): string | undefined => {
  const name = basename(base);
  const candidates = [
    base,
    ...STYLE_SUFFIXES.flatMap(e => [`${base}${e}`, join(dirname(base), `_${name}${e}`), join(base, `_index${e}`), join(base, `index${e}`)]),
  ];
  return candidates.find(c => {
    if (extname(c) === '') return false;
    try {
      return statSync(c).isFile();
    } catch {
      return false;
    }
  });
};

const packageNameOf = (specifier: string) => {
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
    };
    const sets = [
      [...extra, 'browser', 'import', 'module', 'require', 'default'],
      [...extra, 'node', 'import', 'module', 'require', 'default'],
    ];
    if (options.reactServer) sets.push([...extra, 'react-server', 'node', 'import', 'module', 'require', 'default']);
    const first = new ResolverFactory({ ...base, tsconfig: 'auto', conditionNames: sets[0] });
    this.projectResolvers = [first, ...sets.slice(1).map(c => first.cloneWithOptions({ ...base, tsconfig: 'auto', conditionNames: c }))];
    this.packageResolvers = sets.map(c => first.cloneWithOptions({ ...base, conditionNames: c }));
    const style: NapiResolveOptions = {
      extensions: ['.css', '.scss', '.sass', '.less'],
      mainFields: ['style', 'sass', 'main'],
      mainFiles: ['index', '_index'],
      conditionNames: [...extra, 'style', 'sass', 'import', 'require', 'default'],
      symlinks: true,
    };
    this.styleResolvers = [first.cloneWithOptions({ ...style, tsconfig: 'auto' }), first.cloneWithOptions(style)];
    this.modularize = { ...DEFAULT_MODULARIZE, ...options.modularizeImports };
  }

  /** All files `specifier` can point at from `fromFile`, across export conditions. Empty when unresolved. */
  resolve(specifier: string, fromFile: string): string[] {
    if (this.isBuiltin(specifier)) return [];
    const relativeSpecifier = specifier.startsWith('.') || specifier.startsWith('/');
    const external = isInNodeModules(fromFile);
    const cacheKey = `${dirname(fromFile)}\0${specifier}`;
    const cached = this.cache.get(cacheKey);
    if (cached) return cached;
    const resolvers = external ? this.packageResolvers : this.projectResolvers;
    const found = new Set<string>();
    for (const resolver of relativeSpecifier ? resolvers.slice(0, 1) : resolvers) {
      const result = external ? resolver.sync(dirname(fromFile), specifier) : resolver.resolveFileSync(fromFile, specifier);
      if (result.path) found.add(result.path);
    }
    const files = [...found];
    this.cache.set(cacheKey, files);
    return files;
  }

  /**
   * A package stylesheet, resolved with the `style` and `sass` export conditions. When only
   * the package can be found, `package` names it so its version can stand in for the file.
   */
  resolveStyle(specifier: string, fromFile: string): { file?: string; package?: string } {
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
      matcher = picomatch(patterns, { dot: true });
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
  let text: string;
  try {
    text = readFileSync(join(dir, 'package.json'), 'utf8');
  } catch {
    return;
  }
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
